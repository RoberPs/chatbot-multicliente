# Implementation Plan: Canal web del bot de atención

**Branch**: `004-web-channel` | **Date**: 2026-09-25 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/004-web-channel/spec.md`

**Ámbito**: Núcleo

## Summary

Se añade la web como segundo canal del bot, con la misma cadena de respuesta que WhatsApp: una
página "Probar el bot" en el panel del operador, con la información técnica de cada respuesta,
y un chat público que el negocio inserta en su web, con visitantes anónimos, límites y topes de
uso, activable por instancia.

Enfoque técnico: el núcleo de conversación de la 002 pasa a identificar al cliente por
`(canal, id en el canal)` y concentra lo propio de cada canal en una `ChannelPolicy` (entrega,
ventana de 24 h, negocio activo, chat activado, tope). La recepción, la cola persistente con
espera de agrupado, el responder, el verificador, las plantillas y la retención son los mismos
para `whatsapp`, `web` y `playground`. En la web y en el playground la respuesta se guarda y
el cliente la recoge con un sondeo corto mientras espera. El chat público es un `<script>`
que inserta un `<iframe>` servido por la instancia, restringido a las webs permitidas con
`frame-ancestors`. La API solo acepta peticiones de su propio origen, con sesión anónima
firmada en `localStorage`. Límites por IP en memoria (20 sesiones/h, 120 mensajes/15 min),
el mismo límite por visitante que en WhatsApp y topes de 200 respuestas/día y 3 000/mes
contados en la zona del negocio. La migración `0002` renombra y añade columnas sin copiar
datos. Detalle en [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.x (strict) sobre Node.js 22 LTS (heredado)

**Primary Dependencies**: las de la 001/002 (Fastify 5, `@fastify/rate-limit`,
`@fastify/secure-session`, `@fastify/csrf-protection`, Eta + htmx, Drizzle ORM, Zod,
`@anthropic-ai/sdk`). Sin dependencias nuevas: el JS del chat es vanilla y se sirve desde la
instancia.

**Storage**: PostgreSQL 16, la misma BD por instancia; migración `0002_channels`: columnas
`customer.channel` y `customer.channel_user_id`, `message.channel_message_id` y
`message.reply_trace`, y tablas `web_chat_settings` y `web_usage_day`
([data-model.md](data-model.md))

**Testing**: Vitest — `unit` (política de canal, motivos de contacto, esquema de
configuración, firma de sesión, cuentas en hora local), `contract` (`fastify.inject` sobre
`/chat/*` y las páginas nuevas del panel), `integration` (Testcontainers: paridad entre
canales, migración con datos, topes, límites, retención, registros) y `eval` con
`EVAL_CHANNEL=web`

**Target Platform**: el mismo contenedor Linux por instancia; entrada HTTPS pública para
`/chat/*` (ya existía para el webhook) y salida a `api.anthropic.com`. WhatsApp pasa a ser
opcional.

**Project Type**: servicio web (monolito modular): nuevo módulo de dominio `src/webchat`,
nuevo adaptador `src/channels/web` y dos secciones del panel

**Performance Goals**: SC-003 y SC-004 — p95 < 10 s desde el último mensaje del grupo hasta
que el cliente ve la respuesta (3 s de espera + modelo + ≤ 1,5 s de sondeo); API del chat p95
< 100 ms sin contar el modelo; decenas de visitantes simultáneos por instancia

**Constraints**: WhatsApp sin cambios de comportamiento (FR-004); misma cadena en todos los
canales (FR-002); nada guardado ni respondido con el chat desactivado, el negocio no activo,
una web no permitida o el tope alcanzado (SC-006); contenido del visitante siempre como texto;
sin IP en BD ni registros (FR-029, SC-008); snapshot y configuración leídos sin caché; horas
y días en la zona del negocio

**Scale/Scope**: 1 negocio por instancia; hasta 10 webs permitidas; 4 conversaciones
procesándose a la vez (compartidas entre canales); topes por defecto 200/día y 3 000/mes

Cifras que la spec delegaba al plan: límites por IP 20 sesiones/h y 120 mensajes/15 min
(R10); longitud máxima 1 000 caracteres (R10, tabla); sondeo 1,5 s y disculpa a los 45 s (R5).
No quedan incógnitas técnicas ([research.md](research.md), tabla final).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Evaluación inicial (antes de Phase 0)

| Principio | Cumplimiento en esta feature | Estado |
|-----------|------------------------------|--------|
| **I. Base común única** | Spec de núcleo. Canales, plantillas, aviso de privacidad y textos del chat son genéricos; el nombre del negocio y la URL de privacidad salen del snapshot y de la configuración. El test de neutralidad sectorial recorre también `src/webchat`, `src/channels/web` y los assets del chat. | ✅ |
| **II. Configuración antes que código** | Activación, webs permitidas, política de privacidad y topes son configuración por instancia en la BD, editable desde el panel sin desplegar. `PUBLIC_BASE_URL` es una variable de instancia opcional. | ✅ |
| **III. Personalizaciones aisladas** | Sin extensiones. `ChannelPolicy` y `ChannelSender` son puntos genéricos: un canal nuevo será otra spec de núcleo, como pide la restricción "Canales". | ✅ (N/A) |
| **IV. Solo información registrada** | El chat web y el playground usan el mismo responder, los mismos hechos calculados y el mismo verificador; ninguna regla depende del canal (FR-002). Paridad comprobada en integración y en `eval` con `EVAL_CHANNEL=web` (SC-002). La plantilla nueva R-UNAVAILABLE no contiene datos del negocio salvo el contacto. | ✅ |
| **V. Siempre hay salida a una persona** | En todos los caminos en que el chat web no responde (desactivado, negocio no activo, tope, límite por visitante, límite por IP, fallo, respuesta que no llega en 45 s) el visitante ve el contacto de derivación o, si el snapshot no se lee, el de emergencia. Por eso `EMERGENCY_CONTACT_PHONE` pasa a ser obligatoria con `ANTHROPIC_API_KEY`. El detector de petición de persona y el bloque de contacto son los mismos que en WhatsApp. El límite por visitante mantiene la excepción justificada en la 002 (R-LIMIT ya entrega el contacto). | ✅ |
| **VI. El operador registra la información** | Solo el operador, con sesión y CSRF, activa y configura el chat. El visitante no tiene ninguna vía de escritura salvo sus propios mensajes, que se tratan como datos (FR-026 de la 002). El negocio solo pega un fragmento fijo. | ✅ |
| Restricción: canales (v1.1.0) | La web se añade mediante esta spec de núcleo y aplica la misma cadena y las garantías de IV y V. | ✅ |
| Restricción: aislamiento | Configuración, sesiones (firmadas con el secreto propio de la instancia) y conversaciones en la BD de la instancia. El iframe se sirve desde el dominio de la instancia y ninguna web puede leer los datos de otra. | ✅ |
| Flujo: pruebas de IV y V | Tests deterministas de paridad y de contacto en todos los caminos de "no disponible", y suite `eval` por la web antes de cerrar la feature. | ✅ |

**Resultado**: sin violaciones. Se puede continuar con Phase 0.

### Re-evaluación tras el diseño (Phase 1)

Revisados [data-model.md](data-model.md) y [contracts/](contracts/):

- **I**: [conversation-channels.md](contracts/conversation-channels.md) no introduce ramas por
  canal en el responder; las diferencias están solo en la tabla de `ChannelPolicy`, y ninguna
  fila menciona sectores. ✅
- **II**: `web_chat_settings` es configuración del canal editable en el panel; no se mezcla
  con el `KnowledgeSnapshot`. ✅
- **IV**: `reply_trace` solo describe cómo se compuso la respuesta; no añade información que
  el bot pueda decir. ✅
- **V**: el objeto `unavailable` de [web-chat-http.md](contracts/web-chat-http.md) lleva
  siempre `contact`; `GET /chat/api/state` da el contacto por adelantado para la disculpa del
  iframe cuando falla la red o el servidor; R-UNAVAILABLE lleva contacto. ✅
- **VI**: las rutas de escritura de configuración están solo en
  [admin-web-channel.md](contracts/admin-web-channel.md), bajo sesión de operador y CSRF. ✅
- **Privacidad**: token solo en el navegador y en la cabecera; en la BD, un hash; IP solo en
  memoria para los límites; registros con `via` y seudónimo, sin IP
  ([activity-log.md](contracts/activity-log.md)). ✅

**Resultado**: sin violaciones. Complexity Tracking vacío.

**Consecuencias que conviene conocer** (no son violaciones):

- `EMERGENCY_CONTACT_PHONE` pasa a ser obligatoria cuando hay `ANTHROPIC_API_KEY`, aunque no
  haya WhatsApp. Un `.env` de desarrollo con solo la clave del modelo dejará de arrancar hasta
  que se añada.
- Los seudónimos de los registros de WhatsApp cambian una vez al desplegar (R12).
- Las columnas `customer.phone` y `message.wa_message_id` cambian de nombre; los tests de la
  002 se adaptan solo en eso y en la forma de `InboundEvent`.

## Project Structure

### Documentation (this feature)

```text
specs/004-web-channel/
├── plan.md              # Este fichero
├── research.md          # Phase 0: decisiones técnicas
├── data-model.md        # Phase 1: canales, reply_trace, web_chat_settings, web_usage_day
├── quickstart.md        # Phase 1: guía de validación
├── contracts/
│   ├── conversation-channels.md  # Channel, ChannelPolicy, recepción, procesador, R-UNAVAILABLE
│   ├── web-chat-http.md          # widget.js, iframe y API /chat/api/*
│   ├── admin-web-channel.md      # Páginas "Probar el bot" y "Chat web" del panel
│   └── activity-log.md           # Campo via y eventos web_*
├── checklists/
└── tasks.md             # Phase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
src/
├── config/env.ts                 # EMERGENCY_CONTACT_PHONE con ANTHROPIC_API_KEY; + PUBLIC_BASE_URL
├── db/
│   ├── schema.ts                 # customer.channel/channel_user_id, message.channel_message_id/reply_trace,
│   │                             # web_chat_settings, web_usage_day
│   └── migrations/0002_channels.sql
├── conversation/                 # Dominio 002, generalizado (sin HTTP)
│   ├── channels.ts               # NUEVO: Channel, validación de channel_user_id, ChannelPolicy
│   ├── ports.ts                  # + storedDelivery
│   ├── types.ts                  # InboundEvent generalizado, ReplyTrace
│   ├── intake.ts                 # política de canal, IntakeOutcome
│   ├── processor.ts              # policies en vez de sender; reply_trace; tope; R-UNAVAILABLE
│   ├── responder.ts              # contactReason, groundingRejections
│   ├── templates.ts              # + R-UNAVAILABLE
│   ├── activity-log.ts           # via, seudónimo por canal, eventos web_*
│   ├── retention.ts              # + purga de web_usage_day
│   └── repositories/             # customer por (channel, id); message.channel_message_id; lectura para la web
├── webchat/                      # NUEVO dominio del chat web (sin HTTP)
│   ├── schemas.ts                # webChatSettingsSchema (orígenes, privacidad, topes)
│   ├── settings.ts               # leer / guardar configuración
│   ├── usage.ts                  # contador diario en hora local y comprobación de topes
│   ├── session-token.ts          # emitir / verificar token firmado; channel_user_id
│   └── availability.ts           # disponible o motivo + contacto (FR-022)
├── channels/
│   ├── whatsapp/                 # solo mapea a InboundEvent generalizado
│   └── web/                      # NUEVO adaptador HTTP
│       ├── routes.ts             # /chat/widget.js, /chat/frame, /chat/api/*
│       ├── guards.ts             # origen, sesión, límites por IP
│       ├── views/frame.eta
│       └── assets/               # widget.js, frame.js, frame.css (vanilla, sin innerHTML)
├── admin/
│   ├── routes/playground.ts      # NUEVO: Probar el bot
│   ├── routes/web-chat.ts        # NUEVO: configuración, uso y fragmento
│   ├── routes/dashboard.ts       # + estado del chat web
│   └── views/                    # playground.eta, web-chat.eta, partials/playground-*.eta, layout (+2 enlaces)
├── bot.ts                        # bot con ANTHROPIC_API_KEY; WhatsApp opcional; políticas de canal
├── app.ts                        # registro de /chat; CSP propia del frame; serializador sin IP
└── cli/bot-chat.ts               # adaptado a InboundEvent generalizado

tests/
├── unit/conversation/            # channels, contact-reason, reply-trace
├── unit/webchat/                 # schemas, session-token, usage (medianoche local)
├── unit/channels/web-assets.test.ts   # sin innerHTML ni similares en los assets
├── contract/web-chat.test.ts
├── contract/admin/playground.test.ts
├── contract/admin/web-chat.test.ts
├── integration/conversation/     # channel-parity, migration-0002, web-quota, web-limits, playground
├── eval/harness.ts               # EVAL_CHANNEL
└── helpers/                      # web.ts (sesión y mensajes por inject); fakes con customerKey
```

**Structure Decision**: proyecto único, como la 001 y la 002. El dominio común sigue en
`src/conversation`. Lo específico del chat web que no es HTTP (configuración, topes, sesión,
disponibilidad) va a un módulo de dominio hermano, `src/webchat`, y todo lo que conoce
Fastify, cabeceras o el navegador va a `src/channels/web`, igual que WhatsApp vive en
`src/channels/whatsapp`. Las páginas nuevas del panel siguen el patrón de `src/admin`.

## Complexity Tracking

Sin violaciones de la constitución que justificar.
