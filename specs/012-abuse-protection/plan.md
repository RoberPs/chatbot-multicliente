# Implementation Plan: Protección frente a abuso y saturación

**Branch**: `012-abuse-protection` | **Date**: 2026-10-05 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/012-abuse-protection/spec.md`

**Ámbito**: Núcleo (propuesta P8)

## Summary

Cerrar los bloqueantes de la auditoría completa del 2026-10-05 para que una instancia sea apta para
producción: un anónimo no puede hacer gastar al negocio ni dejar la instancia sin servicio, y el
operador siempre puede entrar al panel.

Enfoque técnico (detalle en [research.md](research.md)):

1. **Estado de protección** — módulo de dominio `src/usage/protection.ts` con una sola consulta, sin
   caché y con plazo de 2 s, que falla cerrado (R1, R2). En producción, sin tope o sin precio, los
   clientes finales reciben R-CAP / «no disponible» con el contacto; los avisos críticos de
   protección se ven en todas las pantallas e impiden activar el negocio, pero no bloquean el resto
   de escrituras (R3, R4).
2. **Transcripción y WhatsApp** — los audios se comprueban antes de descargarse y su consumo se
   registra por duración con precio por minuto; WhatsApp gana un tope diario de respuestas con
   modelo contado en la transacción del saliente (R5, R6).
3. **Derivaciones** — límites por instancia (nuevas por día, minutos entre avisos, avisos por día)
   con reserva atómica antes de enviar; reenvíos agrupados con `process_after`; texto del cliente
   delimitado y con las direcciones desactivadas (R7, R8).
4. **Rutas públicas y BD** — límites por dirección en frame, hoja e imágenes del diseño, clave IPv6
   /64 común, imagen comprobada antes de leer bytes, pool principal con máximos y plazos y pool
   público aparte para las lecturas del chat web (R9).
5. **Login** — retardo creciente en vez de bloqueo, cola de verificaciones y cookie de navegador
   conocido (R16).
6. **Salientes y lotes** — plazos en la Graph API; reintentos con espera creciente y abandono con
   disculpa; todo efecto externo marcado antes de enviarse (R10, R11).
7. **Importación** — máximos por lista, 50 errores visibles y coste lineal (R15).
8. **Enlaces** — una regla única para verificador, chat web y panel (R12).
9. **Registros y arranque** — errores con tipo y código, consulta sin valores, y reglas de secretos
   compartidas por el arranque en producción y `instance:check` (R13, R14).

## Technical Context

**Language/Version**: TypeScript 5.x (strict) sobre Node.js 22 LTS (heredado)

**Primary Dependencies**: las existentes — Fastify 5, `@fastify/rate-limit` 11 (`keyGenerator`
común), Eta + htmx, Drizzle ORM + drizzle-kit, `pg` (opciones de pool y `statement_timeout`), Zod 4,
`argon2`, `nodemailer` (plazos ya configurados), `@anthropic-ai/sdk`. **Sin dependencias nuevas**:
la normalización IPv6 usa `node:net` y la lista de dominios de primer nivel va embebida.

**Storage**: PostgreSQL 16, una BD por instancia. Migración de solo añadir
`0008_abuse_protection.sql` ([data-model.md](data-model.md)): valores de enum
(`usage_purpose.transcription`, `message_status.held`, `handoff_end_cause.interrupted`), columnas en
`model_usage`, `usage_settings`, `conversation` y `handoff`, y tablas `transcription_price`,
`whatsapp_usage_day`, `handoff_limits` (fila única) y `handoff_day`. No es configuración del negocio:
**no sube `formatVersion`** y no viaja en la 008 (FR-036).

**Testing**: Vitest —
`unit` (tabla de `protectionState`/`canCallModel`/`canTranscribe`/`protectionWarnings`; coste por
minuto y duración Ogg/Opus; `customerQuote` con la batería de SC-011; `clientKey` IPv4/IPv6/mapeadas;
`displayLinks ⊆ linkCandidates` y `links.js` inyectado con la batería de SC-008; reglas de secretos
y paridad arranque/`instance:check` con la batería de SC-010; serializador `err` y `loggedUrl`;
prueba estática de llamadas al logger; máximos de la importación, 50 errores y eliminación lineal
de repetidos; esquemas Zod de límites; esperas de reintento; retardo del login),
`contract` (`fastify.inject`: 429 en frame, hoja e imágenes sin consultas; imagen con versión falsa
sin leer bytes; login con retardo, cola llena y cookie de navegador conocido; `/admin/usage` con
los formularios nuevos, 422 por rango y por producción; banda de avisos en todas las pantallas;
activación bloqueada; `/health` con `"blocked"`; webhook sin `hub.verify_token` en el registro),
`integration` (Testcontainers: R-CAP en WhatsApp y «no disponible» en web por cada motivo; gasto
ilegible; audios bloqueados y consumo de transcripción; tope diario de WhatsApp con reloj falso;
derivaciones nuevas al límite, reenvío agrupado, avisos retenidos y `held`; límite por cliente con
derivación; reintentos con espera, abandono y «como mucho una vez»; plazos de Graph y SMTP con
servidores que no responden; saturación de rutas públicas con el panel y el webhook < 2 s; login
durante un ataque < 30 s; importación en su máximo < 5 s; restauración de copia con las tablas
nuevas; pool público agotado).
Sin `eval` nuevo: el prompt no cambia; las rutas sin modelo se prueban con dobles.

**Target Platform**: servidor Linux (contenedor `node:22-slim`); `instance:check` e
`instance:versions` en el equipo del operador.

**Project Type**: servicio web (monolito modular). Cambios en `src/usage`, `src/conversation`,
`src/handoff`, `src/channels`, `src/admin`, `src/config`, `src/config-transfer`, `src/db`,
`src/health`, `src/provisioning`, `src/speech`, `src/webchat`.

**Performance Goals**: `protectionState` en una consulta (≤ 10 ms en la mediana, como la del tope de
la 010) y con plazo de 2 s; panel y webhook < 2 s durante 10 000 peticiones públicas (SC-004);
validar + previsualizar la importación máxima < 5 s (SC-007); login del operador < 30 s durante un
ataque (SC-005).

**Constraints**: falla cerrado (FR-004); sin caché en tope, protección ni ajustes; contadores
diarios en hora local del negocio; ningún dato personal en tablas de consumo, contadores ni
registros; mensajes de arranque sin valores de secretos; nada de sectores ni clientes en `src/`;
textos en español; plantillas de WhatsApp aprobadas sin cambios.

**Scale/Scope**: una instancia por cliente con decenas de miles de mensajes al mes; ataques de miles
de peticiones por minuto desde decenas o cientos de direcciones.

No quedan incógnitas técnicas: valores por defecto, plazos, reglas de secretos, máximos de la
importación y retardo del login están fijados en el research.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio / regla | Evaluación |
|---|---|
| I. Base común única | **Cumple.** Todos los límites son genéricos y configurables por instancia, con valores por defecto válidos para cualquier sector (FR-038). Ningún nombre ni rama de sector en `src/`. |
| II. Configuración antes que código | **Cumple.** Tope de WhatsApp, precios de transcripción y límites de derivación se cambian en el panel sin desplegar. No son configuración del negocio (FR-036): no viajan en la 008, no suben `formatVersion`, y la prueba de tablas que no viajan se amplía. Los máximos de la importación son validación, no formato. |
| III. Personalizaciones aisladas | **No aplica**: sin extensiones ni puntos de extensión nuevos. |
| IV. Solo información registrada | **Cumple y se refuerza.** Sin modelo, las respuestas son plantillas fijas (R-CAP, R-ERR, R-HANDOFF-FAIL) con el contacto registrado. La regla única de enlaces (R12) impide mostrar una dirección que el verificador no haya comprobado contra la información registrada, también las que WhatsApp enlaza sin protocolo. |
| V. Siempre hay salida a una persona | **Cumple.** Toda respuesta sin modelo lleva el contacto del negocio (o el de emergencia). Con el límite de derivaciones o de avisos alcanzado, la petición de persona recibe el contacto para llamar o escribir (R7); con los topes, la derivación sigue con el detector determinista; el lote abandonado responde con disculpa y contacto. Ningún límite deja una petición de persona sin salida (SC-002). Pruebas de integración lo verifican antes de cerrar. **Criterio verificable del principio** («se atiende con el mecanismo de derivación configurado»): con `daily_max` o `notices_daily_max` alcanzados, la petición de persona se reconoce igual y recibe **al instante** la salida que ya define la 005 cuando el mecanismo no puede avisar (R-HANDOFF-FAIL con el contacto del negocio). El límite es parte del mecanismo configurado: el operador lo fija en el panel dentro de su rango, igual que las vías y su horario (005). La petición nunca se retrasa ni se bloquea. El agrupado (R7.2) no afecta a la petición ni a la alerta de inicio, que salen sin esperar: solo agrupa lo que el cliente escribe **después**, cuando el negocio ya está avisado y la salida ya se ha dado. Sin desviación que justificar. |
| VI. El operador registra la información | **Cumple.** Solo el operador con sesión cambia topes, precios y límites; el login sigue siendo suyo y ahora no se le puede dejar fuera. El negocio no gana acceso a nada. |
| Aislamiento entre instancias | **Cumple.** Contadores, límites y precios en la BD de cada instancia; límites por dirección en la memoria de cada proceso; la cookie de navegador conocido se firma con una clave derivada del `SESSION_SECRET` propio. |
| Flujo de desarrollo (convenciones) | Spec de núcleo declarada. Migración de solo añadir (valores de enum sin usar en la misma migración). Dominio sin HTTP (`src/usage/protection.ts`, `src/handoff/customer-text.ts`, `src/conversation/link-rule.ts`); las rutas y la clave por dirección, en `src/channels` y `src/admin`. Días en hora local con zona IANA; importes en enteros (billonésimas y millonésimas por minuto); duraciones en milisegundos donde las mide la máquina y minutos donde las configura el operador. `computeWarnings` sigue siendo pura y sin guardar; los avisos de protección se calculan igual, fuera de ella (R3). README y `docs/operacion-multicliente.md` (9.1, 9.2, P8 hecha, §4.1, §5 y límites de derivación) se actualizan al cerrar, avisando antes al usuario. |
| Pruebas de IV y V | La feature cambia la conversación: pruebas de integración de contacto en cada respuesta sin modelo, de la petición de persona con cada límite y tope alcanzado, y de que todo enlace mostrado pasó por el verificador. |

**Resultado: sin violaciones; Complexity Tracking vacío.**

**Re-evaluación tras el diseño (Phase 1)**: el diseño añade cuatro tablas sin datos personales,
columnas de control en `conversation` y `handoff`, un pool público y una cookie sin datos del
operador. Las respuestas nuevas reutilizan plantillas existentes con contacto; la regla de enlaces
pasa a ser más estricta, nunca más permisiva. Los avisos de protección no se guardan ni bloquean
escrituras del conocimiento. Sin cambios en la evaluación.

## Project Structure

### Documentation (this feature)

```text
specs/012-abuse-protection/
├── plan.md                               # Este fichero
├── research.md                           # Phase 0 (R1–R18)
├── data-model.md                         # Phase 1
├── quickstart.md                         # Phase 1
├── contracts/
│   ├── protection-conversation.md        # estado de protección, R-CAP, audios, WhatsApp, /health
│   ├── handoff-limits.md                 # límites, agrupado, held, texto del cliente
│   ├── public-routes-and-login.md        # límites por dirección, /64, imagen, pools, login
│   ├── outbound-and-retries.md           # plazos y reintentos de lotes, como mucho una vez
│   ├── config-import-limits.md           # máximos por lista, 50 errores, coste lineal
│   ├── link-rule.md                      # displayLinks / linkCandidates
│   ├── logging-and-startup.md            # err sin datos, URL sin valores, secretos
│   └── admin-protection.md               # «Consumo» ampliada y banda de avisos
├── checklists/requirements.md
└── tasks.md                              # Phase 2 (/speckit-tasks; no lo crea /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── usage/
│   ├── protection.ts                     # NUEVO — protectionState, checkProtection, canCallModel, canTranscribe, protectionWarnings
│   ├── transcription-cost.ts             # NUEVO — coste por minuto, duración Ogg/Opus
│   ├── meter.ts                          # recordTranscription
│   ├── settings.ts · schemas.ts          # tope WhatsApp, precios de transcripción, rechazos en producción (FR-003)
│   └── types.ts                          # UsagePurpose 'transcription', ProtectionState
├── handoff/
│   ├── limits.ts                         # NUEVO — handoff_limits, reservas en handoff_day
│   ├── customer-text.ts                  # NUEVO — customerQuote (R8)
│   ├── service.ts                        # start guarda antes de avisar; forward agrupado y con reserva; held al terminar
│   ├── notices.ts · templates.ts         # delimitado del texto del cliente
│   └── repositories/handoff.ts           # alerts_sent_at, customer_notified_at, last_notice_at, interrupted
├── conversation/
│   ├── link-rule.ts · tlds.ts            # NUEVO — regla única de enlaces (R12)
│   ├── grounding.ts                      # linkCandidates
│   ├── processor.ts                      # protección, tope WhatsApp, límites de derivación, reintentos
│   ├── intake.ts · transcription.ts      # checkProtection; canTranscribe antes de descargar
│   ├── repositories/conversation.ts      # batch_attempts, process_after en claimReady
│   ├── repositories/message.ts           # estado held
│   ├── ports.ts · settings.ts            # señal en MediaFetcher/sendText; esperas de reintento
│   ├── activity-log.ts                   # eventos nuevos (data-model §3)
│   └── retention.ts                      # purga de whatsapp_usage_day y handoff_day
├── channels/
│   ├── client-key.ts                     # NUEVO — clientKey (IPv6 /64)
│   ├── web/routes.ts                     # límites en frame/design; imagen por metadatos; pool público
│   ├── web/assets/links.js               # regla inyectada
│   └── whatsapp/graph-client.ts          # plazos por petición y total
├── admin/
│   ├── auth/routes.ts · auth/login-throttle.ts   # retardo, cola, cookie de navegador conocido
│   ├── routes/usage.ts · views/usage.eta         # secciones nuevas
│   ├── render.ts · views/partials/protection-banner.eta  # banda común
│   ├── routes/playground.ts · message-links.ts   # recordatorio; displayLinks
│   └── routes/business.ts                        # activación con avisos de protección
├── knowledge/services/business-status.ts # activateBusiness recibe los avisos de protección
├── config/
│   ├── secret-rules.ts                   # NUEVO — reglas de secretos (movidas desde provisioning)
│   └── env.ts                            # reglas en producción; HEALTH_SECRET obligatoria
├── config-transfer/parse.ts · schema.ts · replace.ts   # máximos, 50 errores, coste lineal
├── db/
│   ├── client.ts                         # opciones de pool; createPublicDb
│   ├── schema.ts · migrations/0008_abuse_protection.sql
├── webchat/design/store.ts               # readDesignImageMeta
├── speech/whisper.ts                     # duración
├── health/report.ts                      # spendCap "blocked"
├── provisioning/check.ts · secrets.ts · versions.ts   # reglas compartidas; celda «bloqueado»
├── app.ts                                # keyGenerator, serializador err, loggedUrl, pool público
└── startup.ts                            # weak_secrets fuera de producción

tests/
├── unit/usage/ · unit/handoff/ · unit/conversation/link-rule.test.ts · unit/channels/ · unit/config/ · unit/config-transfer/ · unit/admin/
├── contract/web-chat-*.test.ts · contract/admin/login.test.ts · contract/admin/usage.test.ts · contract/health.test.ts · contract/whatsapp-webhook.test.ts
└── integration/protection/ · integration/handoff/limits.test.ts · integration/processor-retries.test.ts · integration/saturation.test.ts · integration/config-transfer/performance.test.ts · integration/backup/

docs/operacion-multicliente.md            # 9.1/9.2, P8 hecha, §4.1, §5, límites de derivación
README.md                                 # estado de la feature 012
```

**Structure Decision**: monolito modular existente. Las reglas nuevas son dominio sin HTTP
(`src/usage/protection.ts`, `src/handoff/limits.ts` y `customer-text.ts`,
`src/conversation/link-rule.ts`) y las usan los canales, el panel y la salud; lo que depende de la
petición HTTP (clave por dirección, cola del login, cookie, límites de rutas) vive en
`src/channels` y `src/admin`. Las reglas de secretos pasan a `src/config` porque las usa el arranque
y el aprovisionamiento no debe ser una dependencia del arranque.

## Complexity Tracking

> Sin violaciones de la constitución que justificar.
