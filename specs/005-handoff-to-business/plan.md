# Implementation Plan: Derivación de la conversación al negocio

**Branch**: `005-handoff-to-business` | **Date**: 2026-09-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/005-handoff-to-business/spec.md`

**Ámbito**: Núcleo

## Summary

Cuando un cliente pide una persona, presenta una queja o acepta la oferta tras una consulta que
el bot no puede resolver, el bot avisa al negocio por WhatsApp y por email con el nombre, el
teléfono y un resumen del motivo, deja de responder en esa conversación, reenvía al negocio lo
que el cliente siga escribiendo y la recupera cuando el negocio pulsa "Terminado", cuando el
operador la cierra o tras 24 h sin mensajes del cliente. Igual en WhatsApp, el chat web y
"Probar el bot" (aquí, simulado).

Enfoque técnico: módulo de dominio nuevo `src/handoff` que el procesador de la 004 consulta en
cada lote. El modelo de la 002 solo clasifica (queja, aceptación de la oferta) y extrae nombre y
teléfono; el código decide con una tabla fija y responde con plantillas, de modo que "te
contactarán" solo se dice si el aviso se entregó. El motivo lo resume una llamada aparte que solo
ve los mensajes del cliente, verificada y con respaldo por código. Los avisos salen por un puerto
`AlertRoute` con dos adaptadores: plantillas *utility* de WhatsApp con botones "Le atiendo" y
"Terminado", y email por SMTP (nodemailer) con enlaces a una página que confirma con `POST`. Cada
derivación tiene un token de 128 bits (solo su hash en BD) que liga botones y enlaces a ella. Los
mensajes del cliente durante la derivación se agrupan como siempre y se marcan `forwarded`. Un
barrido cada 60 s cierra por inactividad y envía el recordatorio a las 2 h de horario. Migración
`0004_handoff`. Detalle en [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.x (strict) sobre Node.js 22 LTS (heredado)

**Primary Dependencies**: las de la 001–004 (Fastify 5, `@fastify/rate-limit`, Eta + htmx,
Drizzle ORM, Zod, libphonenumber-js, `@anthropic-ai/sdk`) más **`nodemailer`** (y
`@types/nodemailer`) para el email (R7). WhatsApp sigue con `fetch` sobre la Graph API.

**Storage**: PostgreSQL 16, la misma BD por instancia; migración `0004_handoff`: columnas
`conversation.contact_name`, `contact_phone` y `handoff_step`; valor `forwarded` en
`message_status`; tablas `handoff`, `handoff_notice` y `handoff_alerts`
([data-model.md](data-model.md))

**Testing**: Vitest — `unit` (tabla de decisión, horario y 2 h de horario con cierres y cambio de
hora, composición y saneado de avisos, resumen verificado y de respaldo, tokens, parseo de
botones y perfil), `contract` (`fastify.inject`: webhook con botones y texto del negocio,
`/handoff/*`, `/admin/handoffs`, `/chat/api/messages`, playground), `integration`
(Testcontainers con vías falsas y reloj controlable: los seis flujos, silencio y reenvío
agrupado, fines, recordatorio, fallos de vías, registros, retención, migración) y `eval` con el
modelo real (SC-001, SC-003, SC-006, SC-007)

**Target Platform**: el mismo contenedor Linux por instancia; salida nueva a un servidor SMTP;
entrada HTTPS pública para `/handoff/*` (la misma que ya sirve `/chat` y el webhook)

**Project Type**: servicio web (monolito modular): dominio nuevo `src/handoff`, adaptadores
nuevos (plantillas de WhatsApp, SMTP, enlaces, resumen con Claude) y una página del panel

**Performance Goals**: SC-002 — aviso entregado por al menos una vía en < 1 min desde que el
cliente completa la petición (3 s de agrupado + modelo ≤ 20 s + resumen ≤ 8 s + vías en paralelo
≤ 15 s ≈ 46 s en el peor caso); `/handoff/*` p95 < 100 ms; decenas de derivaciones al día por
instancia

**Constraints**: "te contactarán" solo con aviso entregado (FR-010/012); 0 respuestas automáticas
en una conversación derivada salvo el aviso de FR-019 (SC-004); el resumen solo con lo que
escribió el cliente (FR-007); ningún `GET` de un enlace cambia nada (R8); destinos de avisos fuera
del snapshot; registros sin nombres, teléfonos, emails ni textos (FR-022); todo borrado con la
conversación (FR-023); sin lógica sectorial (FR-024); horarios en hora local del negocio

**Scale/Scope**: 1 negocio y como mucho 1 WhatsApp + 1 email de avisos por instancia; varias
derivaciones activas a la vez (una por conversación); 3 plantillas de WhatsApp por cuenta de Meta

Cifras que la spec delegaba al plan: resumen ≤ 300 caracteres en ≤ 8 s (R4); 15 s por vía (R5);
reenvío ≤ 700 caracteres por WhatsApp (R6); enlaces 30 peticiones/15 min por IP (R8); ayuda al
negocio como mucho cada 15 min (R10); horizonte de 60 días para la próxima franja (R13); barrido
cada 60 s (R14); consulta del aviso web cada 60 s (R15). No quedan incógnitas técnicas
([research.md](research.md), tabla final).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Evaluación inicial (antes de Phase 0)

| Principio | Cumplimiento en esta feature | Estado |
|-----------|------------------------------|--------|
| **I. Base común única** | Spec de núcleo. Plantillas al cliente y al negocio, instrucciones del resumen y reglas de queja son genéricas; los nombres de las plantillas de Meta son fijos y sin sector. El test de neutralidad recorre también `src/handoff`, `src/mail` y `src/channels/handoff-links`. | ✅ |
| **II. Configuración antes que código** | Los destinos de los avisos son configuración por instancia en la BD, editable en el panel sin desplegar. Las credenciales SMTP son variables de instancia, como las de WhatsApp. Horario de atención y cierres salen del snapshot de la 001. | ✅ |
| **III. Personalizaciones aisladas** | Sin extensiones. `AlertRoute` y `HandoffSummarizer` son puertos genéricos: otra vía de aviso sería otro adaptador en una spec de núcleo. | ✅ (N/A) |
| **IV. Solo información registrada** | Las respuestas de derivación son plantillas del código; la franja de atención se calcula desde el snapshot (no la estima el modelo). La queja nunca recibe el cuerpo del modelo. Ante una consulta sin dato, el bot sigue diciendo que no lo tiene y ofrece el contacto **en forma de derivación** cuando hay vías (es contacto con el negocio, como exige IV); sin vías, el bloque CONTACTO de la 002. El resumen al negocio solo usa lo que escribió el cliente, verificado por código. | ✅ |
| **V. Siempre hay salida a una persona** | La petición se reconoce por la bandera del modelo **o** el detector determinista de la 002, y tiene prioridad sobre cualquier otro intercambio. Todos los caminos terminan en aviso entregado o en el contacto de derivación: sin vías, con el aviso fallido, con el cliente que no da sus datos, con el modelo caído (R-ERR con CONTACTO) y cuando el negocio no confirma en 2 h (contacto directo al cliente). El silencio del bot durante la derivación es la salida a la persona, no un bloqueo; nunca dura más de 24 h sin mensajes. Durante la derivación no se envía R-LIMIT (justificado en R11: el negocio ya está atendiendo). | ✅ |
| **VI. El operador registra la información** | Solo el operador, con sesión y CSRF, configura los destinos y puede terminar derivaciones. El negocio recibe botones y enlaces que solo cambian el estado de **su** derivación (atiendo / terminado); no le dan acceso a la configuración ni al panel. | ✅ |
| Restricción: canales | Mismo comportamiento en WhatsApp, web y playground; lo que difiere (datos del canal, simulación) está en `ChannelPolicy`. | ✅ |
| Restricción: aislamiento | Derivaciones, destinos y tokens en la BD de la instancia; plantillas y SMTP propios de cada despliegue. | ✅ |
| Flujo: pruebas de IV y V | Tests deterministas de la tabla de decisión (todos los caminos acaban en aviso o contacto) y de las plantillas; `eval` de quejas, ofertas y peticiones en mitad de otra gestión antes de cerrar la feature. | ✅ |

**Resultado**: sin violaciones. Se puede continuar con Phase 0.

### Re-evaluación tras el diseño (Phase 1)

Revisados [data-model.md](data-model.md) y [contracts/](contracts/):

- **I**: los textos de [business-alerts.md](contracts/business-alerts.md) y
  [handoff-flow.md](contracts/handoff-flow.md) no nombran sectores ni clientes; los ejemplos de
  queja del quickstart son ilustrativos. ✅
- **II**: `handoff_alerts` es configuración editable; no hay nombres de plantilla ni textos por
  instancia. ✅
- **IV**: `handoff_alerts` no entra en el `KnowledgeSnapshot`, así que el bot no puede dar el
  WhatsApp ni el email internos del negocio; `reply_trace.handoff` no añade nada que el bot diga;
  la verificación del resumen usa el mismo extractor de datos que el verificador de la 002. ✅
- **V**: la tabla de decisión de [handoff-flow.md](contracts/handoff-flow.md) no tiene ninguna
  fila en que una petición o una queja acabe sin aviso entregado ni CONTACTO; R-HANDOFF-LATE lleva
  CONTACTO; `HANDOFF_ALERTS_NONE` es normal porque sin vías se mantiene el contacto de la 002. ✅
- **VI**: las únicas escrituras que no pasan por el panel son `handoff.act` (token de la
  derivación) y el barrido; ninguna toca tablas de la 001. ✅
- **Privacidad**: token solo en los mensajes al negocio y como hash en BD; texto de los avisos
  guardado solo en el playground; registros sin datos personales
  ([activity-log.md](contracts/activity-log.md)); borrado en cascada con la conversación. ✅

**Resultado**: sin violaciones. Complexity Tracking vacío.

**Consecuencias que conviene conocer** (no son violaciones):

- La vía WhatsApp necesita las tres plantillas aprobadas por Meta en la cuenta de cada instancia
  y cada aviso, recordatorio y reenvío se cobra como conversación de plantilla (R6).
- La vía email necesita `SMTP_URL`, `SMTP_FROM` y `PUBLIC_BASE_URL`.
- Toda instancia sin destinos configurados muestra un aviso normal más en el panel; los tests de
  la 001 que comprueban la lista exacta de avisos se adaptan (R16).
- Con vías configuradas, "quiero hablar con una persona" deja de dar el contacto y pasa a
  derivar: la prueba `eval` `sc008-handoff` de la 002 se adapta.
- El número de WhatsApp de avisos del negocio no puede usarse como cliente del bot (R10).

## Project Structure

### Documentation (this feature)

```text
specs/005-handoff-to-business/
├── plan.md              # Este fichero
├── research.md          # Phase 0: decisiones técnicas
├── data-model.md        # Phase 1: handoff, handoff_notice, handoff_alerts, cambios en conversation/message
├── quickstart.md        # Phase 1: guía de validación
├── contracts/
│   ├── handoff-flow.md      # Tabla de decisión, plantillas al cliente, procesador, resumen, barrido
│   ├── business-alerts.md   # Plantillas de WhatsApp, email, botones, ayuda y /handoff/*
│   ├── admin-and-web.md     # Página "Derivaciones", "Probar el bot" y chat web
│   └── activity-log.md      # Eventos handoff_*
├── checklists/
└── tasks.md             # Phase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
src/
├── config/env.ts                    # + SMTP_URL, SMTP_FROM, WHATSAPP_TEMPLATE_LANG
├── db/
│   ├── schema.ts                    # conversation.contact_*/handoff_step, message_status 'forwarded',
│   │                                # handoff, handoff_notice, handoff_alerts
│   └── migrations/0004_handoff.sql
├── handoff/                         # NUEVO dominio (sin HTTP)
│   ├── types.ts                     # HandoffKind, HandoffStep (Zod), BusinessNotice
│   ├── ports.ts                     # AlertRoute, HandoffSummarizer, AlertRoutesProvider
│   ├── schemas.ts                   # handoffAlertsSchema (destinos)
│   ├── settings.ts                  # leer/guardar destinos; vías disponibles
│   ├── decision.ts                  # tabla de decisión (pura)
│   ├── contact-data.ts              # nombre y teléfono: extracción, validación E.164
│   ├── schedule.ts                  # horario aplicable, nextOpening, addOpenMinutes, texto de la franja
│   ├── summary.ts                   # resumen: llamada, verificación, respaldo
│   ├── notices.ts                   # BusinessNotice de aviso, recordatorio y reenvío
│   ├── templates.ts                 # R-HANDOFF-*, OFERTA, aviso fijo web, acuses al negocio
│   ├── tokens.ts                    # emitir token, hash, parsear payload h1:
│   ├── service.ts                   # HandoffService: start, forward, act, endByOperator, sweep
│   └── repositories/                # handoff, handoff_notice
├── conversation/
│   ├── types.ts                     # modelReplySchema +5 campos; ReplyContext; ReplyTrace.handoff; InboundEvent
│   ├── channels.ts                  # ChannelPolicy + contactFromChannel, simulateAlerts
│   ├── processor.ts                 # rama de derivación activa; decide/start antes de deliver
│   ├── responder.ts                 # devuelve también la salida del modelo para decidir
│   ├── intake.ts                    # guarda profileName en conversation.contact_name
│   ├── activity-log.ts              # eventos handoff_*
│   └── repositories/                # message: 'forwarded' en history/list; conversation: contact_*, handoff_step
├── knowledge/
│   ├── state.ts / types.ts          # KnowledgeState.handoffAlerts (con vías de la instancia)
│   └── warnings.ts                  # HANDOFF_ALERTS_NONE, HANDOFF_ALERTS_SINGLE
├── llm/
│   ├── prompt.ts                    # regla de quejas; indicaciones de paso; campos nuevos
│   ├── anthropic-summarizer.ts      # NUEVO: HandoffSummarizer
│   └── summary-prompt.ts            # NUEVO: instrucciones del resumen
├── mail/smtp-mailer.ts              # NUEVO: AlertRoute email (nodemailer)
├── channels/
│   ├── whatsapp/payload.ts          # profileName, buttonPayload
│   ├── whatsapp/template-sender.ts  # NUEVO: AlertRoute WhatsApp (plantillas)
│   ├── whatsapp/business-router.ts  # NUEVO: botones y ayuda al negocio antes de la recepción
│   ├── web/api.ts                   # campo handoff; waiting con derivación
│   ├── web/assets/frame.js|css      # franja fija y sondeo de 60 s
│   └── handoff-links/               # NUEVO: /handoff/:token/:action (GET página, POST acción) + vista
├── admin/
│   ├── routes/handoffs.ts           # NUEVO: destinos, derivaciones activas, terminar
│   ├── routes/playground.ts         # aviso fijo y "Terminar derivación"
│   ├── playground-trace.ts          # handoff en la información técnica
│   └── views/                       # handoffs.eta, partials de playground, layout (+1 enlace), dashboard
├── cli/handoff-templates.ts         # NUEVO: pnpm handoff:templates
├── bot.ts                           # vías, resumen, HandoffService, enrutador del negocio, barrido
└── app.ts                           # registro de /handoff

tests/
├── unit/handoff/                    # decision, schedule, contact-data, summary, notices, tokens, templates
├── unit/channels/                   # payload (botones, perfil), template-sender (saneado)
├── contract/                        # whatsapp-business.test.ts, handoff-links.test.ts,
│                                    # admin/handoffs.test.ts, web-chat-handoff.test.ts
├── integration/handoff/             # request, offer, complaint, silence-forward, end, reminder,
│                                    # routes-failure, playground, retention, activity-log, migration-0004
├── eval/                            # sc-handoff-complaint, sc-handoff-offer, sc-handoff-summary; sc008 adaptado
└── helpers/                         # FakeAlertRoute, FakeSummarizer
```

**Structure Decision**: proyecto único, como las features anteriores. La lógica de la derivación
es un dominio hermano (`src/handoff`) que no conoce Fastify, la Graph API, SMTP ni el SDK del
modelo; el procesador de `src/conversation` lo recibe inyectado. Los adaptadores nuevos siguen la
convención: lo que habla con Meta en `src/channels/whatsapp`, lo HTTP público nuevo en
`src/channels/handoff-links`, el email en `src/mail` (como `src/speech`) y el resumen en
`src/llm`. La página del operador sigue el patrón de `src/admin`.

## Complexity Tracking

Sin violaciones de la constitución que justificar.
