---

description: "Lista de tareas de la feature 005: derivación de la conversación al negocio"
---

# Tasks: Derivación de la conversación al negocio

**Input**: documentos de diseño de `/specs/005-handoff-to-business/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Ámbito**: Núcleo

**Tests**: se incluyen. El plan fija las suites `unit`, `contract`, `integration` y `eval`, y la
constitución exige pruebas de los Principios IV y V (toda petición de persona acaba en aviso
entregado o en CONTACTO) antes de cerrar la feature. Los tests de cada historia se escriben
primero y deben fallar antes de implementar.

**Organization**: por historia de usuario. La fase fundacional deja preparados datos, tipos,
puertos, repositorios, horario, tokens, destinos de avisos y fakes; no cambia ninguna respuesta
del bot. Cada historia añade después su parte de la tabla de decisión
([contracts/handoff-flow.md](contracts/handoff-flow.md)) y de los avisos.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede hacer en paralelo (ficheros distintos, sin dependencias pendientes)
- **[Story]**: historia a la que pertenece (US1…US6)
- Rutas desde la raíz del repositorio (proyecto único: `src/`, `tests/`)

## Reglas que aplican a todas las tareas

- En `src/` no puede haber nombres ni lógica de sector o cliente (FR-024). El test
  `tests/unit/sector-neutrality.test.ts` recorre también `src/handoff`, `src/mail` y
  `src/channels/handoff-links`; los ejemplos de quejas y consultas solo en `tests/fixtures/`.
- `src/handoff` es dominio: no importa Fastify, nodemailer, el SDK de Anthropic ni hace `fetch`.
  Lo que habla con Meta va en `src/channels/whatsapp`, lo HTTP público en
  `src/channels/handoff-links`, el email en `src/mail`, el resumen en `src/llm` y el panel en
  `src/admin`.
- Ojo con los nombres: `src/admin/routes/handoff.ts`, `src/admin/views/handoff.eta` y
  `src/knowledge/handoff.ts` son el **contacto de derivación** de la 001 y no cambian de papel; la
  página nueva es `handoffs` (plural).
- "Te contactarán" solo se dice si hay una fila `handoff` `active` con al menos un
  `handoff_notice` `sent` (FR-010, FR-012). Las respuestas de derivación son plantillas del código;
  en las filas 1, 3 y 6 de la tabla de decisión el cuerpo del modelo se descarta.
- Ningún `GET` de `/handoff/*` cambia la BD (R8). El token de acción solo existe en claro en
  memoria y en los mensajes al negocio; en la BD, `sha256` (R9).
- Destinos de avisos (`handoff_alerts`) leídos sin caché en cada uso y **nunca** dentro del
  `KnowledgeSnapshot` (el bot no puede darlos).
- Registros sin nombres, teléfonos, emails, resúmenes ni textos de mensajes
  ([contracts/activity-log.md](contracts/activity-log.md)); los eventos que provoca el negocio no
  llevan seudónimo de remitente.
- Horarios en hora local del negocio con su zona IANA; nada se pasa a UTC para calcular franjas.
- Textos, comentarios y mensajes en español.

---

## Phase 1: Setup (infraestructura compartida)

**Purpose**: dependencia de email, variables de entorno nuevas y empaquetado de las vistas nuevas.

- [X] T001 Añadir `nodemailer` a `dependencies` y `@types/nodemailer` a `devDependencies` en package.json (con `pnpm add`), y el script `"handoff:templates": "tsx src/cli/handoff-templates.ts"`
- [X] T002 [P] Documentar en .env.example `SMTP_URL=` (`smtps://usuario:clave@host:465` o `smtp://…:587`), `SMTP_FROM=` y `WHATSAPP_TEMPLATE_LANG=es`, indicando que la vía email necesita además `PUBLIC_BASE_URL` y que la vía WhatsApp necesita las tres plantillas aprobadas (`pnpm handoff:templates`)
- [X] T003 [P] Ampliar scripts/copy-assets.mjs para copiar `src/channels/handoff-links/views` (y su CSS) a `dist/src/channels/handoff-links/`

---

## Phase 2: Foundational (prerrequisitos bloqueantes)

**Purpose**: migración `0004_handoff`, tipos y puertos del dominio `src/handoff`, repositorios,
horario, tokens, destinos de avisos con sus avisos del panel, eventos de registro y fakes. Al
terminar, el bot responde exactamente igual que en la 004 (sin vías configuradas y sin cambios en
la cadena).

**⚠️ CRITICAL**: ninguna historia puede empezar hasta terminar esta fase.

### Configuración

- [X] T004 Añadir a `loadEnv` en src/config/env.ts `SMTP_URL` (opcional; URL `smtp://` o `smtps://`), `SMTP_FROM` (opcional; email válido) y `WHATSAPP_TEMPLATE_LANG` (opcional, por defecto `es`, formato `xx` o `xx_XX`), con mensajes de error en español; `SMTP_URL` sin `SMTP_FROM` (o al revés) es error
- [X] T005 [P] Añadir casos a tests/unit/env.test.ts: SMTP completo válido, solo una de las dos variables SMTP (error), `SMTP_URL` con esquema no válido (error), `WHATSAPP_TEMPLATE_LANG` ausente → `es`, con formato no válido (error)

### Datos y migración

- [X] T006 Modificar src/db/schema.ts según [data-model.md](data-model.md): en `conversation`, `contact_name text`, `contact_phone text` y `handoff_step jsonb` nullable; valor `forwarded` en el enum `message_status`; enums `handoff_kind`, `handoff_status`, `handoff_summary_source`, `handoff_action_via`, `handoff_end_cause`, `handoff_notice_type`, `handoff_route`, `handoff_notice_status`; tablas `handoff` (con `token_hash bytea` único, índice único parcial `(conversation_id) WHERE status = 'active'`, los dos `CHECK` y el índice `(status, reminder_due_at)`), `handoff_notice` y `handoff_alerts` (singleton `id smallint` con `CHECK (id = 1)`), ambas con `ON DELETE CASCADE` hacia su padre; `conversationTableNames` pasa a `['handoff_notice', 'handoff', 'message', 'conversation', 'customer', 'web_usage_day']`
- [X] T007 Generar con `pnpm db:generate` src/db/migrations/0004_handoff.sql (con `meta/0004_snapshot.json` y `_journal.json`) y editarla a mano: `ALTER TYPE message_status ADD VALUE 'forwarded'` en una sentencia propia separada por `--> statement-breakpoint`, índice único parcial y `CHECK` escritos a mano si drizzle-kit no los genera, e `INSERT INTO handoff_alerts (id) VALUES (1)`
- [X] T008 Actualizar `resetDb` en tests/helpers/db.ts: truncar también `handoff_notice` y `handoff` (vía `conversationTableNames`) y restablecer `handoff_alerts` a vacío con un `UPDATE … SET whatsapp_phone = NULL, email = NULL` (no se trunca: es singleton)
- [X] T009 [P] Test de integración tests/integration/handoff/migration-0004.test.ts: base con `0000`–`0003` y conversaciones y mensajes existentes, aplicar `0004` y comprobar recuentos intactos, columnas nuevas nulas, fila única vacía de `handoff_alerts`, que se puede insertar un mensaje `forwarded`, que una segunda derivación `active` de la misma conversación viola el índice y que borrar la conversación borra `handoff` y `handoff_notice`

### Dominio: tipos, esquemas y puertos

- [X] T010 [P] Crear src/handoff/types.ts: `HANDOFF_KINDS` y `HandoffKind` (`person`, `unresolved`, `complaint`), `handoffStepSchema` (Zod, unión `offered`/`collecting` con `missing` no vacío y `phoneRetried`, fechas ISO) y `HandoffStep`, `BusinessNotice` y `NoticeHandoff` tal como en [data-model.md](data-model.md), `HandoffEndCause`, `HandoffActionVia`, `RouteName` (`whatsapp`, `email`, `simulated`) y `RouteResults`
- [X] T011 [P] Crear src/handoff/ports.ts con `AlertRoute` (con `send(notice, { signal })` que no lanza), `HandoffSummarizer` y `AlertRoutesProvider`, copiando las firmas de [contracts/handoff-flow.md](contracts/handoff-flow.md)
- [X] T012 [P] Crear src/handoff/schemas.ts con `handoffAlertsSchema` (Zod): `whatsapp` vacío → `null`, si no libphonenumber-js con `DEFAULT_PHONE_REGION`, `isValid()` y E.164 ("Indica un teléfono válido, con prefijo si no es de España"); `email` vacío → `null`, `z.email()` recortado y en minúsculas ("Indica un email válido")
- [X] T013 [P] Test unitario tests/unit/handoff/schemas.test.ts: `handoffStepSchema` (válidos, `missing` vacío rechazado, paso desconocido rechazado) y `handoffAlertsSchema` (vacíos → `null`, teléfono nacional → E.164, internacional, no válido, email con mayúsculas y espacios, email no válido)
- [X] T014 Ampliar src/conversation/types.ts: `modelReplySchema` + `complaint`, `acceptsHandoff`, `refusesContact` (boolean, por defecto `false`) y `contactName`, `contactPhone` (`string | null`, por defecto `null`); `ReplyContext` + `handoffStep: HandoffStep | null` y `handoffEnded: boolean`; `ReplyTemplate` y `replyTraceSchema.template` + `R-HANDOFF-ASK`, `R-HANDOFF-PHONE`, `R-HANDOFF-OK`, `R-HANDOFF-COMPLAINT`, `R-HANDOFF-LATE`; `ContactReason` + `handoff_unavailable` y `contact_refused`; `replyTraceSchema.handoff` opcional (`action`, `kind`, `routes`); `InboundEvent` + `profileName` y `buttonPayload` (`string | null`)
- [X] T015 Ampliar `ChannelPolicy` y `buildChannelPolicies` en src/conversation/channels.ts con `contactFromChannel` (solo `whatsapp`) y `simulateAlerts` (solo `playground`), y sus casos en tests/unit/conversation/channels.test.ts
- [X] T016 Actualizar el esquema JSON y el parseo de la salida estructurada en src/llm/anthropic-chat-model.ts con los cinco campos nuevos (opcionales en la respuesta, con valor por defecto), y `reply()` de tests/helpers/fakes.ts con esos valores por defecto; ampliar tests/unit/llm/anthropic-chat-model.test.ts con una salida sin los campos (defaults) y otra con ellos
- [X] T017 Rellenar `profileName: null` y `buttonPayload: null` en todos los `InboundEvent` que construyen src/channels/whatsapp/payload.ts, src/channels/web/api.ts, src/admin/routes/playground.ts, src/cli/bot-chat.ts y tests/helpers/ (compila y nada cambia de comportamiento)

### Registros técnicos

- [X] T018 Añadir a src/conversation/activity-log.ts los eventos `handoff_*` de [contracts/activity-log.md](contracts/activity-log.md) con sus campos tipados (sin texto libre) y su nivel en `eventLevels`; `reply_sent` gana `handoffAction?`; los eventos del negocio (`handoff_confirmed`, `handoff_ended` por `business`, `handoff_action_ignored`, `handoff_business_message`) se emiten sin contexto de cliente
- [X] T019 [P] Ampliar tests/unit/conversation/activity-log.test.ts: cada evento nuevo tiene nivel, se serializa sin campos de texto y los eventos del negocio no llevan `customer` ni `via`

### Repositorios

- [X] T020 Ampliar src/conversation/repositories/message.ts: `history()` incluye los entrantes `forwarded` (FR-018); `listForConversation()` los devuelve como mensajes del cliente; nueva `markForwarded(tx, ids)`; `claimReady` sigue reclamando solo `pending`
- [X] T021 Ampliar src/conversation/repositories/conversation.ts: leer y escribir `contact_name`, `contact_phone` y `handoff_step` (validado con `handoffStepSchema` al leer; un valor que no valida se trata como `null`), `setProfileName(tx, id, name)` que recorta a 80 caracteres y quita saltos de línea
- [X] T022 [P] Crear src/handoff/repositories/handoff.ts: `insertActive`, `findActiveByConversation`, `findByTokenHash`, `hasEnded(conversationId)`, `confirm(id, via, at)` (`UPDATE … WHERE status = 'active' AND confirmed_at IS NULL`), `end(id, cause, at, confirmVia?)` (`WHERE status = 'active'`, devuelve si cambió), `listActive()` (con nombre, teléfono y canal de la conversación, sin `summary`, excluye `playground`), `endInactive(before)` y `claimDueReminders(now)` (`FOR UPDATE SKIP LOCKED`, marca `reminder_sent_at`)
- [X] T023 [P] Crear src/handoff/repositories/handoff-notice.ts: `insertMany(tx, notices)`, `emailThreadRef(handoffId)` (el `provider_ref` del `alert` por email) y `listForHandoff(handoffId)` (para el playground)
- [X] T024 Test de integración tests/integration/handoff/repositories.test.ts: una sola activa por conversación, `confirm` y `end` solo actúan sobre activas y devuelven si cambiaron, `end` con `confirmVia` confirma a la vez, `endInactive` respeta el límite de 24 h, `claimDueReminders` no devuelve la misma fila dos veces en dos transacciones concurrentes, `history()` incluye `forwarded`

### Horario de atención (R13)

- [X] T025 [P] Test unitario tests/unit/handoff/schedule.test.ts: horario del contacto de derivación con franjas frente al del negocio (FR-011), cierre puntual que tapa la próxima franja, franja que ya ha empezado (abierto → `null`), negocio sin franjas (siempre abierto, `addOpenMinutes` en tiempo real), cierre largo sin franja en 60 días (`null` en los dos cálculos), `addOpenMinutes(120)` que salta la noche y el fin de semana, cambio de hora de marzo y de octubre en `Europe/Madrid` (hora inexistente → primer minuto válido), otra zona (`America/Mexico_City`), y el texto "hoy a las 16:00" / "mañana a las 9:00" / "el lunes 5 de octubre a las 9:00"
- [X] T026 Crear src/handoff/schedule.ts con funciones puras sobre el snapshot: `applicableHours(snapshot)`, `isOpenAt(snapshot, at)`, `nextOpening(snapshot, at)` (horizonte 60 días), `addOpenMinutes(snapshot, at, minutes)` y `describeOpening(instant, now, timezone)`, reutilizando `effectiveIntervals` de src/knowledge/time/intervals.ts y la conversión local→instante con `Intl`

### Tokens (R9)

- [X] T027 [P] Test unitario tests/unit/handoff/tokens.test.ts: token de 22 caracteres base64url y distinto en cada llamada, `hashToken` estable de 32 bytes, `parseButtonPayload` acepta `h1:attend:<token>` y `h1:end:<token>` y rechaza versión, acción o longitud no válidas, `isTokenFormat` para las rutas
- [X] T028 [P] Crear src/handoff/tokens.ts: `issueToken()` (`randomBytes(16)` base64url), `hashToken(token)` (`sha256`), `buttonPayload(action, token)`, `parseButtonPayload(payload)` e `isTokenFormat(token)`

### Destinos de avisos, vías disponibles y avisos del panel (R16)

- [X] T029 Crear src/handoff/settings.ts: `readHandoffAlerts(tx)` (sin caché), `saveHandoffAlerts(input)` con la escritura protegida de src/knowledge/services/guarded-write.ts, y `availability(alerts, instance)` → `{ whatsapp, email }` donde `instance` dice si hay canal WhatsApp y si hay `SMTP_URL`+`SMTP_FROM`+`PUBLIC_BASE_URL`
- [X] T030 Ampliar `KnowledgeState` en src/knowledge/types.ts y `loadKnowledgeState` en src/knowledge/state.ts con `handoffAlerts: { whatsapp, email, routes }`; `routes` llega como opción (por defecto `{ whatsapp: false, email: false }`); comprobar que src/knowledge/snapshot.ts no lo incluye
- [X] T031 Añadir a src/knowledge/warnings.ts `HANDOFF_ALERTS_NONE` y `HANDOFF_ALERTS_SINGLE` (gravedad `normal`, textos de [contracts/admin-and-web.md](contracts/admin-and-web.md)) y `WarningTargetKind` `handoff_alerts` con enlace a `/admin/handoffs`; `computeWarnings` sigue siendo pura
- [X] T032 [P] Test unitario tests/unit/warnings/handoff-alerts.test.ts: sin vías → `NONE`; destino configurado pero instancia sin canal → cuenta como no disponible; una vía → `SINGLE` nombrando la otra; dos → ninguno; ninguno es crítico (no bloquea activar el negocio)
- [X] T033 Adaptar los tests de la 001 que comprueban la lista exacta de avisos (tests/unit/warnings/catalog.test.ts, tests/contract/admin/warnings.test.ts, tests/contract/admin/dashboard.test.ts y los que fallen al ejecutar `pnpm test`) para que esperen `HANDOFF_ALERTS_NONE` cuando no hay destinos
- [X] T034 [P] Ampliar tests/contract/snapshot-shape.test.ts: con destinos configurados, el JSON del snapshot no contiene el WhatsApp ni el email de avisos

### Fakes y banco de pruebas

- [X] T035 Añadir a tests/helpers/fakes.ts `FakeAlertRoute` (nombre configurable; guiones `ok`/`fail(failure)`/`hang`; guarda los `BusinessNotice` recibidos), `FakeSummarizer` (guiones `ok(summary)`/`fail`/`hang`; guarda las entradas) y un `FakeAlertRoutesProvider`; ampliar `createTestBot` en tests/helpers/bot.ts con opciones `alertRoutes`, `summarizer` y `handoffAlerts` (destinos a guardar), y un `setHandoffAlerts(t, …)` en tests/helpers/db.ts

**Checkpoint**: migración aplicada, `pnpm test` en verde con los tests de la 001–004 adaptados al
aviso nuevo, y el bot responde igual que antes.

---

## Phase 3: User Story 1 - El cliente pide hablar con una persona (Priority: P1) 🎯 MVP

**Goal**: una petición de persona, en cualquier canal, termina en un aviso al negocio por
WhatsApp y/o email con nombre, teléfono, canal, tipo y un resumen verificado, y en la
confirmación R-HANDOFF-OK; si faltan datos, el bot los pide en una sola pregunta; si no hay vías
o el aviso no se entrega, el contacto de la 002.

**Independent Test**: con un negocio activo, dentro de horario y una vía de aviso disponible,
escribir por WhatsApp una pregunta de precio y después "quiero hablar con una persona";
comprobar la confirmación al cliente y un único aviso con nombre, número y un motivo que menciona
el precio. En el playground, pedir una persona, dar un teléfono mal y luego bien, y ver el aviso
simulado en la información técnica (quickstart, escenario 2, pasos 1–3).

### Tests for User Story 1 ⚠️

> **NOTE: escribir estos tests PRIMERO y comprobar que FALLAN antes de implementar**

- [X] T036 [P] [US1] Test unitario tests/unit/handoff/decision.test.ts: filas 3, 4 y 5 de la tabla de [contracts/handoff-flow.md](contracts/handoff-flow.md) con todas las combinaciones de `request` (bandera o detector), `hasRoutes`, `contactFromChannel` y datos conocidos; § Datos completo (rechazo, datos completos, teléfono no válido una vez y dos veces, falta uno); y la garantía de SC-001: ninguna combinación con petición termina sin iniciar, pedir datos o CONTACTO
- [X] T037 [P] [US1] Test unitario tests/unit/handoff/contact-data.test.ts: nombre recortado, sin saltos de línea, 1–80 caracteres; teléfono de `contactPhone` o, si es nulo, el primero de `findPhoneNumbersInText` en los textos; validación con `DEFAULT_PHONE_REGION` y E.164; en WhatsApp el teléfono es el `channel_user_id` y el nombre, el de perfil; `missing` correcto por canal
- [X] T038 [P] [US1] Test unitario tests/unit/handoff/summary.test.ts: resumen del modelo aceptado; resumen con un teléfono, importe, fecha o URL que el cliente no escribió → respaldo; más de 300 caracteres o con saltos de línea → respaldo; fallo o plazo de 8 s → respaldo; respaldo sin mensajes previos = "El cliente pidió hablar con una persona sin dar el motivo" (US1-5); con mensajes = extracto literal recortado a 300; `summary_source` correcto; el summarizer solo recibe textos del cliente
- [X] T039 [P] [US1] Test unitario tests/unit/handoff/notices.test.ts: composición del aviso `alert` (nombre, `displayPhone`, "WhatsApp" / "chat de la web" / "prueba del panel", tipo en texto, motivo, "desde" en hora local) y variables de plantilla saneadas (sin `\n`, `\t`, 5 espacios seguidos ni vacías → "—")
- [X] T040 [P] [US1] Test unitario tests/unit/handoff/templates.test.ts: R-HANDOFF-ASK en sus tres variantes, R-HANDOFF-PHONE y R-HANDOFF-OK (negocio abierto) en forma tú y usted, con saludo si es la primera respuesta; ninguna contiene datos del negocio salvo el nombre
- [X] T041 [P] [US1] Test unitario tests/unit/channels/template-sender.test.ts: cuerpo JSON de `derivacion_aviso` exacto al de [contracts/business-alerts.md](contracts/business-alerts.md) (idioma, cinco parámetros, dos botones `quick_reply` con `h1:attend:` y `h1:end:`), `to` sin `+`, reintento en 429/5xx, 4xx → `template_rejected`/`recipient_invalid` sin reintento, `wamid` como `ref`, plazo con `AbortSignal`
- [X] T042 [P] [US1] Test unitario tests/unit/mail/smtp-mailer.test.ts (con transporte `jsonTransport` o `streamTransport` de nodemailer): asunto `Derivación: {nombre} ({tipo})`, cuerpo de texto de [contracts/business-alerts.md](contracts/business-alerts.md) con los dos enlaces `${PUBLIC_BASE_URL}/handoff/{token}/attend|end`, HTML con el contenido del cliente escapado (`<script>` en el motivo), `Message-ID` como `ref`, fallo SMTP → `{ ok: false, failure: 'smtp_4xx'|'smtp_5xx'|'timeout'|'network' }`
- [X] T043 [P] [US1] Test unitario tests/unit/llm/summary-prompt.test.ts y ampliar tests/unit/llm/prompt.test.ts: instrucciones del resumen genéricas y con los textos del cliente entre marcas y escapados, sin snapshot; nueva regla de petición de persona ("responde solo con una frase breve de acuse; no pidas datos ni el motivo"); indicación de paso `collecting` con lo que falta; campos nuevos en el "Formato de salida"
- [X] T044 [P] [US1] Test unitario tests/unit/conversation/payload.test.ts (ampliar): `contacts[].profile.name` → `profileName` por `wa_id`; sin perfil → `null`
- [X] T045 [P] [US1] Test de integración tests/integration/handoff/request.test.ts (vías falsas y reloj controlable): WhatsApp con perfil → sin pedir datos, un `alert` por vía disponible, fila `handoff` `active` con `handoff_notice` `sent`, `handoff_step` nulo y R-HANDOFF-OK con el número del cliente; WhatsApp sin perfil → pide solo el nombre; web → pide nombre y teléfono en una pregunta, teléfono no válido → R-HANDOFF-PHONE, válido → deriva; web que se niega → CONTACTO (`contact_refused`) sin aviso (US1-4); petición en mitad de otra gestión con el detector y sin la bandera del modelo → deriva y el resumen recoge la gestión; varios mensajes seguidos → un solo aviso; el motivo menciona la consulta de precio previa; con el límite por cliente ya superado (y, en la web, con el tope diario alcanzado), "quiero hablar con una persona" → R-LIMIT (o el aviso de tope de la 004) con CONTACTO, sin fila `handoff` ni aviso al negocio (caso límite de la spec, Principio V) (US1-1, US1-5)
- [X] T046 [P] [US1] Test de integración tests/integration/handoff/routes-failure.test.ts: una vía falla y la otra no → deriva y registra `handoff_alert_failed`; las dos fallan o ninguna configurada → sin fila `handoff`, respuesta con CONTACTO (`handoff_unavailable`) y `handoff_not_started` con `delivery_failed`/`no_routes`; vía colgada → se corta a los 15 s (reloj de las vías) y cuenta como fallo; resumen caído → deriva con respaldo y `handoff_summary_fallback`
- [X] T047 [P] [US1] Test de integración tests/integration/handoff/playground.test.ts: en el playground la única vía es `simulated`, ningún `FakeAlertRoute` real recibe llamadas, `handoff_notice.body` guarda el texto del aviso y `reply_trace.handoff` = `started` con `routes.simulated = 'sent'`
- [X] T048 [P] [US1] Test de contrato tests/contract/admin/handoffs.test.ts (parte de destinos): `GET /admin/handoffs` exige sesión; muestra el estado de cada vía ("Disponible", "Sin configurar", "Configurado, pero esta instancia no puede…" con la variable que falta) y los avisos `NONE`/`SINGLE`; `POST /admin/handoffs/alerts` sin CSRF → rechazado, válido → `303` y guardado, teléfono o email no válidos → `422` con errores por campo y la BD sin cambios
- [X] T049 [P] [US1] Test de contrato tests/contract/admin/playground.test.ts (ampliar): la información técnica de una respuesta que inicia una derivación muestra "Derivación iniciada (simulada) · tipo · vías" y el texto del aviso en un bloque plegable

### Implementation for User Story 1

- [X] T050 [P] [US1] Crear src/handoff/contact-data.ts: `normalizeName`, `resolvePhone(modelPhone, texts, region)` → E.164 o `invalid`/`missing`, y `missingContact(policy, conversation, channelUserId, profileName)` según § Datos
- [X] T051 [P] [US1] Crear src/handoff/templates.ts con R-HANDOFF-ASK (tres variantes), R-HANDOFF-PHONE y R-HANDOFF-OK (variante de negocio abierto) en tú y usted, usando `formOf` y el saludo de src/conversation/templates.ts
- [X] T052 [P] [US1] Crear src/handoff/notices.ts: `alertNotice(...)` que compone `NoticeHandoff`, `describeChannel`, `describeKind`, `describeSince` (hora local) y `sanitizeTemplateVar` (saltos y tabuladores → espacio, espacios repetidos → uno, vacía → "—")
- [X] T053 [US1] Crear src/handoff/decision.ts con `decide(input: TurnInput): TurnDecision` pura para las filas 3, 4 y 5 y § Datos (las filas 1, 2, 6 y 7 se añaden en US6 y US2; mientras tanto caen en la fila 8); la decisión dice qué plantilla usar, si iniciar, el `kind`, el `ContactReason` y el `handoff_step` siguiente
- [X] T054 [P] [US1] Crear src/llm/summary-prompt.ts con las instrucciones fijas de [contracts/handoff-flow.md](contracts/handoff-flow.md) § Resumen y la función que monta los textos del cliente escapados como en src/llm/prompt.ts
- [X] T055 [US1] Crear src/llm/anthropic-summarizer.ts (`HandoffSummarizer`): mismo cliente y `LLM_MODEL` que src/llm/anthropic-chat-model.ts, esfuerzo `low`, salida estructurada `{ summary }`, `max_tokens` 400, respeta el `AbortSignal`
- [X] T056 [US1] Crear src/handoff/summary.ts: `summarizeHandoff({ summarizer, kind, customerTexts, clock, activityLog })` con plazo de 8 s, verificación con `extractFacts` de src/conversation/facts.ts (hechos del resumen ⊆ hechos de los textos), longitud ≤ 300, una línea, y respaldo por código; devuelve `{ summary, source }`
- [X] T057 [P] [US1] Crear src/channels/whatsapp/template-sender.ts (`AlertRoute` `whatsapp`): traduce `BusinessNotice` `alert` a `derivacion_aviso` con el JSON del contrato, idioma `WHATSAPP_TEMPLATE_LANG`, reutiliza el cliente y los reintentos de src/channels/whatsapp/graph-client.ts, plazo total 15 s; los tipos `reminder` y `forward` se añaden en US5 y US3
- [X] T058 [P] [US1] Crear src/mail/smtp-mailer.ts (`AlertRoute` `email`) con nodemailer desde `SMTP_URL`/`SMTP_FROM` al email de avisos: aviso con asunto, texto y HTML escapado de [contracts/business-alerts.md](contracts/business-alerts.md), enlaces con `PUBLIC_BASE_URL`, plazo 15 s, sin reintentos, fallos traducidos a códigos cortos
- [X] T059 [P] [US1] Crear la vía simulada en src/handoff/simulated-route.ts (`AlertRoute` `simulated`): siempre `ok`, devuelve en `body` el texto del aviso tal como lo recibiría el negocio (mismo texto que el email)
- [X] T060 [US1] Crear src/handoff/routes-provider.ts (`AlertRoutesProvider`): lee `handoff_alerts` sin caché, aplica `availability` y devuelve las vías reales disponibles con el destino ya puesto; con `simulateAlerts` devuelve solo la simulada
- [X] T061 [US1] Crear src/handoff/service.ts con `createHandoffService(deps)` y los métodos `active`, `decide` (delegando en decision.ts) y `start` según [contracts/handoff-flow.md](contracts/handoff-flow.md) § Inicio y R12: resumen, token, aviso en paralelo por las vías con 15 s cada una, y con ≥ 1 `ok` una transacción que inserta `handoff` (`reminder_due_at` con `addOpenMinutes(120)`), los `handoff_notice`, limpia `handoff_step` y devuelve `started`; registra `handoff_started`, `handoff_alert_failed`, `handoff_not_started`; `forward`, `act`, `endByOperator` y `sweep` se añaden en US3–US5
- [X] T062 [US1] Cambiar src/conversation/responder.ts para que devuelva también la salida del modelo (banderas y datos de contacto) además del cuerpo compuesto, sin cambiar la composición actual cuando no hay derivación
- [X] T063 [US1] Integrar la derivación en src/conversation/processor.ts: el `ReplyContext` lleva `handoffStep` y `handoffEnded`; tras el modelo, `handoff.decide(...)` y, según la decisión, R-HANDOFF-ASK/PHONE (guardando `handoff_step` y los datos dados), `handoff.start(...)` antes de `deliver` con R-HANDOFF-OK o, si no se inició, cuerpo + CONTACTO (`handoff_unavailable`/`contact_refused`); `handoff_step`, datos de contacto y saliente en la misma transacción; `reply_trace.handoff` y `reply_sent.handoffAction`; si el modelo falla (R-ERR) no se decide nada
- [X] T064 [US1] Ampliar src/llm/prompt.ts: regla de petición de persona ("marca handoffRequested y responde solo con una frase breve de acuse; el sistema se encarga del resto. No pidas datos ni el motivo"), indicación del turno final para `collecting` (qué falta, copiar literalmente en `contactName`/`contactPhone`, `refusesContact`), y los campos nuevos en el "Formato de salida"
- [X] T065 [US1] Extraer `profileName` en src/channels/whatsapp/payload.ts (`contacts[].profile.name` por `wa_id`) y guardarlo en `conversation.contact_name` desde src/conversation/intake.ts con `setProfileName` en cada entrante que lo traiga
- [X] T066 [US1] Componer en src/bot.ts las vías (template-sender si hay canal WhatsApp, smtp-mailer si hay SMTP y `PUBLIC_BASE_URL`), el `AlertRoutesProvider`, el summarizer y el `HandoffService`, inyectarlo en el procesador y pasar `routes` a `loadKnowledgeState` para los avisos del panel
- [X] T067 [US1] Crear src/admin/routes/handoffs.ts y src/admin/views/handoffs.eta con la sección "Avisos al negocio" (`GET /admin/handoffs`, `POST /admin/handoffs/alerts`) según [contracts/admin-and-web.md](contracts/admin-and-web.md), registrarla en src/admin/routes/index.ts y añadir el enlace "Derivaciones" en src/admin/views/layout.eta después de "Contacto de derivación"
- [X] T068 [US1] Mostrar `reply_trace.handoff` y el aviso simulado (`handoff_notice.body`) en src/admin/playground-trace.ts y src/admin/views/partials/playground-trace.eta
- [X] T069 [P] [US1] Crear src/cli/handoff-templates.ts (`pnpm handoff:templates`): imprime el JSON de las tres plantillas (`derivacion_aviso`, `derivacion_recordatorio`, `derivacion_mensaje`) para `POST /{waba-id}/message_templates`, categoría `UTILITY`, idioma de `WHATSAPP_TEMPLATE_LANG`, con ejemplos de variables y los dos botones `QUICK_REPLY`
- [X] T070 [US1] Adaptar tests/eval/sc008-handoff.test.ts: con vías (falsas) la petición termina en R-HANDOFF-OK o R-HANDOFF-ASK; sin vías, en CONTACTO como antes
- [X] T071 [P] [US1] Crear tests/eval/sc-handoff-summary.test.ts (SC-003, modelo real): conversaciones de tests/fixtures/eval/ con la petición al final; comprobar automáticamente que ningún resumen contiene datos concretos (teléfonos, importes, fechas, horas, URLs) que el cliente no dio, y volcar al informe todos los resúmenes con su conversación, con dos casillas por resumen: "identifica cliente y motivo" (umbral 90 %) y "sin datos no dados" (umbral 100 %), para revisión manual en T131; y peticiones en mitad de otra gestión (SC-001)

**Checkpoint**: el cliente pide una persona y el negocio recibe el aviso (o el cliente recibe el
contacto). Valida el MVP junto con US3: sin ella, el bot sigue contestando tras derivar.

---

## Phase 4: User Story 2 - El bot no puede resolver y el cliente acepta la derivación (Priority: P1)

**Goal**: ante una consulta sin dato o una petición que no se gestiona por este medio, el bot
ofrece la derivación (OFERTA, sin CONTACTO) cuando hay vías; si el cliente acepta, deriva como en
US1 con tipo `unresolved`; si no, la oferta caduca.

**Independent Test**: preguntar algo sin dato registrado, aceptar la oferta y comprobar que el
aviso incluye esa pregunta en el motivo; repetir rechazando y comprobar que no hay aviso
(quickstart, escenario 3).

### Tests for User Story 2 ⚠️

- [ ] T072 [P] [US2] Ampliar tests/unit/handoff/decision.test.ts con las filas 6 y 7: `offered` + `acceptsHandoff` → derivar `unresolved`; `offered` sin aceptar → caduca (`null`) y respuesta normal; `offerContact` o `bookingRequested` con vías → OFERTA y `offered`; sin vías o con `needsRephrase` → fila 8 (CONTACTO de la 002); con `handoffEnded` y vías → sigue siendo fila 7 (OFERTA, FR-018)
- [ ] T073 [P] [US2] Ampliar tests/unit/handoff/templates.test.ts con OFERTA en tú y usted tras el cuerpo del modelo y sin bloque CONTACTO
- [ ] T074 [P] [US2] Ampliar tests/unit/llm/prompt.test.ts con la indicación del turno final para `offered` ("Si ahora acepta, marca acceptsHandoff")
- [ ] T075 [P] [US2] Test de integración tests/integration/handoff/offer.test.ts: consulta sin dato → cuerpo + OFERTA y `handoff_offered`; "sí" → deriva (en web, pidiendo datos) y el motivo recoge la pregunta; "no, gracias" o cambio de tema → sin aviso y `handoff_step` nulo; petición de reserva → también ofrece (US2-4); sin vías → CONTACTO como en la 002

### Implementation for User Story 2

- [ ] T076 [US2] Añadir las filas 6 y 7 (y la caducidad de `offered` en cualquier otra fila) a src/handoff/decision.ts
- [ ] T077 [P] [US2] Añadir OFERTA a src/handoff/templates.ts
- [ ] T078 [US2] Ampliar src/conversation/processor.ts para componer cuerpo + OFERTA sin CONTACTO en la fila 7, guardar `handoff_step = offered` y registrar `handoff_offered`; la aceptación reutiliza el camino de US1
- [ ] T079 [US2] Añadir a src/llm/prompt.ts la indicación del turno final para `offered`
- [ ] T080 [P] [US2] Crear tests/eval/sc-handoff-offer.test.ts (SC-007, modelo real): consultas sin dato de las tres fixtures con vías disponibles; el 100 % incluye la oferta; aceptaciones y rechazos variados se clasifican bien

**Checkpoint**: las consultas sin dato se convierten en derivaciones cuando el cliente acepta.

---

## Phase 5: User Story 3 - El bot calla mientras el negocio atiende (Priority: P1)

**Goal**: con una derivación activa, el bot no responde en esa conversación; los mensajes del
cliente se agrupan y se reenvían al negocio en un único mensaje por lote, se marcan `forwarded`
y el chat web y el playground muestran un aviso fijo en lugar de respuestas.

**Independent Test**: derivar una conversación, enviar varios mensajes más desde el cliente y
comprobar que el bot no contesta ninguno y que el negocio recibe un único reenvío por grupo;
otro cliente sigue atendido (quickstart, escenario 2, paso 4).

### Tests for User Story 3 ⚠️

- [ ] T081 [P] [US3] Ampliar tests/unit/handoff/notices.test.ts con el aviso `forward`: ítems en orden, archivo sin texto → `[<otherType>]`, audio transcrito → su texto, `{{3}}` unido con " / " y recortado a 700 caracteres con la coletilla que corresponda según haya vía email o no
- [ ] T082 [P] [US3] Ampliar tests/unit/channels/template-sender.test.ts y tests/unit/mail/smtp-mailer.test.ts con `derivacion_mensaje` y el email de reenvío (asunto, texto completo sin recortar con hora local, mismos enlaces, `In-Reply-To`/`References` al `Message-ID` del aviso)
- [ ] T083 [P] [US3] Test de integración tests/integration/handoff/silence-forward.test.ts: con derivación activa, ningún saliente (ni saludo, ni R-MEDIA) (SC-004); dos mensajes seguidos → un único `forward` por vía con los dos textos y los entrantes `forwarded`; nueva petición de persona → se reenvía, sin aviso nuevo (US3-4); vías caídas → entrantes `forwarded` igualmente y `handoff_forward_failed` sin reintentos; límite por cliente superado → un R-LIMIT con CONTACTO (como en la 002) y los limitados no se reenvían; una segunda conversación de otro cliente se atiende con normalidad a la vez (FR-015)
- [ ] T084 [P] [US3] Test de contrato tests/contract/web-chat-handoff.test.ts: `GET /chat/api/messages` con derivación activa → `handoff.active = true`, `notice` con el teléfono dado y sin el WhatsApp ni el email de avisos, `waiting = false` aunque haya `pending`, entrantes `forwarded` como `from: "visitor"`; sin derivación → `handoff: null`; `POST` durante la derivación → `202`
- [ ] T085 [P] [US3] Ampliar tests/unit/channels/web-assets.test.ts: `frame.js` pinta `handoff.notice` con `textContent` en una franja `role="status"` (no burbuja), oculta "escribiendo" mientras está visible y programa el sondeo de 60 s
- [ ] T086 [P] [US3] Ampliar tests/contract/admin/playground.test.ts: con la conversación de prueba derivada, aviso fijo encima de la caja de texto y reenvío simulado en la información técnica de los mensajes del operador

### Implementation for User Story 3

- [ ] T087 [US3] Añadir `forwardNotice(...)` a src/handoff/notices.ts y el caso `forward` a src/channels/whatsapp/template-sender.ts (`derivacion_mensaje` con recorte a 700), src/mail/smtp-mailer.ts (reenvío completo en el hilo del aviso con `emailThreadRef`) y src/handoff/simulated-route.ts
- [ ] T088 [US3] Añadir `forward(input)` a src/handoff/service.ts según [contracts/handoff-flow.md](contracts/handoff-flow.md) § Reenvío: vías disponibles ahora, un aviso por lote, `markForwarded` y `handoff_notice` en la misma transacción aunque fallen todas, eventos `handoff_forwarded`/`handoff_forward_failed`
- [ ] T089 [US3] En src/conversation/processor.ts, tras comprobar negocio activo y chat activado y antes de la ventana de WhatsApp: si `handoff.active(...)` → `handoff.forward(...)` con los pendientes que no estén limitados y `return`; `rateLimitNotice` sigue enviando R-LIMIT con derivación activa, como en la 002; los limitados quedan fuera del reenvío
- [ ] T090 [US3] Añadir el texto fijo de FR-013a (tú/usted, con el teléfono dado y el nombre del negocio) a src/handoff/templates.ts y el campo `handoff` y `waiting = false` a `GET /chat/api/messages` en src/channels/web/api.ts
- [ ] T091 [US3] Pintar la franja fija y el sondeo de 60 s en src/channels/web/assets/frame.js y su estilo en src/channels/web/assets/frame.css (la franja se quita cuando llega `handoff: null`, sin añadir mensajes)
- [ ] T092 [US3] Mostrar en src/admin/routes/playground.ts y src/admin/views/playground.eta (o sus partials) el aviso fijo de derivación y los reenvíos simulados en la información técnica, con `waiting = false` mientras dure

**Checkpoint**: MVP completo (US1 + US3): el negocio recibe el aviso y los mensajes posteriores, y
el bot no se pisa con él.

---

## Phase 6: User Story 4 - La conversación vuelve al bot (Priority: P2)

**Goal**: el negocio confirma ("Le atiendo") o termina ("Terminado") con los botones de
WhatsApp o los enlaces del email, el operador termina desde el panel o el playground, y el
barrido termina por 24 h de inactividad; la vuelta es silenciosa y el bot retoma sin saludar ni
volver a derivar por el mismo motivo.

**Independent Test**: derivar, pulsar "Terminado" (botón o enlace + confirmación `POST`) y
comprobar que el siguiente mensaje lo contesta el bot; repetir dejando pasar 24 h sin mensajes y
terminando desde el panel (quickstart, escenarios 2 pasos 5–6, 6 y 7).

### Tests for User Story 4 ⚠️

- [ ] T093 [P] [US4] Ampliar tests/unit/conversation/payload.test.ts: `type = "button"` → `kind = 'other'`, `otherType = 'button'`, `buttonPayload = button.payload`; `interactive.button_reply` → `buttonPayload = button_reply.id`
- [ ] T094 [P] [US4] Test unitario tests/unit/handoff/business-replies.test.ts: acuses y ayuda de [contracts/business-alerts.md](contracts/business-alerts.md) para cada resultado de `act`, con el nombre del cliente
- [ ] T095 [P] [US4] Test de contrato tests/contract/whatsapp-business.test.ts (webhook firmado): botón `h1:attend:` → confirma y acusa; `h1:end:` → termina y acusa; con dos derivaciones activas, solo cambia la del token (SC-010); botón válido desde otro número → se acepta; texto libre desde el WhatsApp de avisos → ayuda una vez cada 15 min, sin `customer`, `conversation` ni `message` nuevos y sin cambiar derivaciones (FR-008b); token desconocido o derivación terminada → acuse sin cambios y `handoff_action_ignored`
- [ ] T096 [P] [US4] Test de contrato tests/contract/handoff-links.test.ts: `GET` nunca cambia la BD (las cuatro variantes de la tabla del contrato), `POST` aplica y es idempotente, token con formato no válido o desconocido → `404`, derivación terminada → "ya había terminado", cabeceras `Cache-Control: no-store`, `Referrer-Policy`, `X-Robots-Tag` y CSP, sin cookies, límite de 30 peticiones/15 min por IP, "Le atiendo" por email y "Terminado" por WhatsApp a la vez → solo cuenta el primero
- [ ] T097 [P] [US4] Ampliar tests/contract/admin/handoffs.test.ts con "Derivaciones activas": tabla con cliente, canal, tipo, inicio en hora local, confirmada y recordatorio, **sin** el motivo (derivación con una palabra marcada en el resumen) y sin las del playground; `POST /admin/handoffs/:id/end` con CSRF termina, la segunda vez "ya había terminado", id inexistente → 404, respuesta htmx sustituye la fila; la portada muestra "Derivaciones activas: N"
- [ ] T098 [P] [US4] Test de integración tests/integration/handoff/end.test.ts: fin por botón, por enlace, por el panel, por el playground (`POST /admin/playground/handoff/end`) y por inactividad en el barrido (reloj a +24 h desde el último entrante; a +23 h 59 min sigue activa); en todos, ningún mensaje al cliente (FR-018), `handoff_ended` con su causa y el siguiente mensaje lo contesta el bot sin saludar si la conversación sigue abierta y sin iniciar una derivación sin petición ni aceptación del cliente; una nueva petición explícita crea otra derivación; en la web `handoff` pasa a `null`; una derivación sin confirmar cerrada por inactividad envía en ese momento un `reminder` por vía (`trigger: 'inactivity'`) y ningún mensaje al cliente; si ya se había enviado el recordatorio, no se repite; un botón o enlace pulsado después responde con el acuse de "ya terminada" y el teléfono del cliente
- [ ] T099 [P] [US4] Ampliar tests/unit/llm/prompt.test.ts con la indicación `handoffEnded` ("Esta conversación estuvo atendida por el negocio y ha vuelto a ti…")

### Implementation for User Story 4

- [ ] T100 [US4] Añadir `act(token, action, via)` y `endByOperator(id, cause)` a src/handoff/service.ts según R9 (hash, `attend` confirma solo si era nulo, `end` confirma y termina, solo la primera cuenta), con `handoff_confirmed` (`minutesToConfirm`), `handoff_ended` y `handoff_action_ignored`
- [ ] T101 [US4] Añadir a src/handoff/service.ts la parte de inactividad de `sweep()` (`endInactive(now − 24 h)` y `handoff_ended` por `inactivity`) y el recordatorio por cierre de inactividad sin confirmar (FR-019: `endInactive` marca `reminder_sent_at` con `RETURNING` y, fuera de la transacción, aviso `reminder` por las vías sin R-HANDOFF-LATE, `handoff_reminder_sent` con `trigger: 'inactivity'`); para ello, `reminderNotice(...)` y el caso `reminder` de las vías se adelantan aquí desde T114 y arrancarla y pararla con el procesador en src/bot.ts cada `handoffSweepMs` (60 s por defecto, configurable en tests)
- [ ] T102 [P] [US4] Crear src/handoff/business-replies.ts con los acuses y la ayuda al negocio (tú, textos del contrato)
- [ ] T103 [US4] Extraer `buttonPayload` (plantilla `button` e `interactive.button_reply`) en src/channels/whatsapp/payload.ts
- [ ] T104 [US4] Crear src/channels/whatsapp/business-router.ts y engancharlo en src/bot.ts antes de `intake.handle`: payload `h1:` válido → `handoff.act(..., 'whatsapp')` y acuse con `sendText`; remitente = WhatsApp de avisos (leído sin caché) → ayuda como mucho una vez cada 15 min por número (en memoria) y `handoff_business_message`; el resto, recepción normal
- [ ] T105 [US4] Crear src/channels/handoff-links/routes.ts con `GET` y `POST /handoff/:token/:action` según [contracts/business-alerts.md](contracts/business-alerts.md) § Enlaces, cabeceras de seguridad, `@fastify/rate-limit` de 30/15 min por IP (sin registrar la IP), y las vistas src/channels/handoff-links/views/page.eta y handoff.css; registrar en src/app.ts bajo `/handoff` solo si hay bot
- [ ] T106 [US4] Añadir a src/admin/routes/handoffs.ts y src/admin/views/handoffs.eta la sección "Derivaciones activas" y `POST /admin/handoffs/:id/end` (flash y sustitución de fila con htmx), y el contador "Derivaciones activas: N" en src/admin/routes/dashboard.ts y src/admin/views/dashboard.eta
- [ ] T107 [US4] Añadir `POST /admin/playground/handoff/end` (causa `playground`) y el botón "Terminar derivación" en src/admin/routes/playground.ts y la vista del playground
- [ ] T108 [US4] Pasar `handoffEnded` (`hasEnded(conversationId)`) al `ReplyContext` en src/conversation/processor.ts y añadir su indicación en src/llm/prompt.ts

**Checkpoint**: toda derivación termina (negocio, operador o inactividad) y la conversación vuelve
al bot sin mensajes al cliente.

---

## Phase 7: User Story 5 - Derivación fuera de horario (Priority: P2)

**Goal**: con el negocio cerrado, la confirmación da la próxima franja de atención (con cierres
puntuales y zona horaria), el aviso sale en el momento, y si el negocio no confirma en 2 horas de
horario recibe un recordatorio único y el cliente, un único mensaje con el contacto directo.

**Independent Test**: derivar un sábado por la noche en un negocio que abre el lunes a las 9:00
y comprobar que la confirmación dice "el lunes … a las 9:00"; sin confirmar, avanzar el reloj
hasta 2 h de horario y ver un recordatorio y un R-HANDOFF-LATE, una sola vez (quickstart,
escenario 5).

### Tests for User Story 5 ⚠️

- [ ] T109 [P] [US5] Ampliar tests/unit/handoff/templates.test.ts con R-HANDOFF-OK de negocio cerrado (con franja y sin franja en 60 días) y R-HANDOFF-LATE con CONTACTO, en tú y usted
- [ ] T110 [P] [US5] Ampliar tests/unit/channels/template-sender.test.ts, tests/unit/mail/smtp-mailer.test.ts y tests/unit/handoff/notices.test.ts con el recordatorio (`derivacion_recordatorio`, asunto `Recordatorio: {nombre} sigue esperando`, hilo del aviso, "desde" en hora local, y la frase final del email según `trigger`: contacto dado al cliente o conversación vuelta al asistente; con los dos enlaces en ambos casos); si T101 se hace antes, estos casos se escriben con T098
- [ ] T111 [P] [US5] Test de integración tests/integration/handoff/after-hours.test.ts (reloj controlable): sábado noche → "el lunes … a las 9:00" y el aviso sale en el momento (FR-009); cierre puntual mañana derivando la víspera → primera franja tras el cierre (US5-2); horario del contacto de derivación distinto del del negocio → manda el del contacto (FR-011); negocio abierto → sin horarios (US5-3); `handoff_started.afterHours` correcto
- [ ] T112 [P] [US5] Test de integración tests/integration/handoff/reminder.test.ts: sin confirmar, a 1 h 59 min de horario no pasa nada; a 2 h de horario (saltando el cierre nocturno) → un `reminder` por vía y un único R-HANDOFF-LATE al cliente; barridos siguientes y dos barridos concurrentes → no se repite (SC-009); confirmada antes → sin recordatorio; en WhatsApp con la ventana de 24 h cerrada → no se envía al cliente y se registra `customerNotified = false`; la conversación sigue derivada; derivación el viernes a las 21:00 con apertura el lunes a las 9:00 → el sábado a las 21:00 se cierra por inactividad y sale el recordatorio al negocio (`trigger: 'inactivity'`), sin R-HANDOFF-LATE; el lunes no se envía nada más

### Implementation for User Story 5

- [ ] T113 [US5] Añadir a src/handoff/templates.ts la variante de negocio cerrado de R-HANDOFF-OK (con `describeOpening` o "en cuanto puedan") y R-HANDOFF-LATE con el bloque CONTACTO de src/conversation/templates.ts; usar `nextOpening` en `start` (src/handoff/service.ts) para elegir la variante y registrar `afterHours`
- [ ] T114 [US5] Completar (ya existen desde T101) `reminderNotice(...)` en src/handoff/notices.ts y el caso `reminder` en src/channels/whatsapp/template-sender.ts (`derivacion_recordatorio`), src/mail/smtp-mailer.ts (en el hilo del aviso) y src/handoff/simulated-route.ts
- [ ] T115 [US5] Añadir a `sweep()` en src/handoff/service.ts el recordatorio: `claimDueReminders(now)` y, fuera de la transacción, aviso `reminder` por las vías y R-HANDOFF-LATE al cliente con la entrega de su canal (respetando la ventana de WhatsApp), guardando el saliente y `handoff_notice`, y registrando `handoff_reminder_sent`

**Checkpoint**: SC-005 y SC-009 verificables con el reloj de pruebas.

---

## Phase 8: User Story 6 - Las quejas se derivan siempre (Priority: P2)

**Goal**: una queja o reclamación se deriva sin pedir aceptación y sin el cuerpo del modelo; sin
vías, disculpa + CONTACTO; un comentario negativo que no reclama nada se atiende con normalidad.

**Independent Test**: escribir "quiero poner una reclamación, el trabajo me lo hicieron mal" y
comprobar que el bot no explica ni justifica, confirma la derivación y el aviso dice "queja o
reclamación" con un motivo que empieza por "Queja:" (quickstart, escenario 4).

### Tests for User Story 6 ⚠️

- [ ] T116 [P] [US6] Ampliar tests/unit/handoff/decision.test.ts con las filas 1 y 2: `complaint` gana sobre petición, datos y oferta; con vías deriva `complaint` sin aceptación; sin vías → R-HANDOFF-COMPLAINT + CONTACTO; en ningún caso con `complaint` se usa el cuerpo del modelo (FR-003); queja durante `collecting` recalcula el tipo y sigue pidiendo lo que falta
- [ ] T117 [P] [US6] Ampliar tests/unit/handoff/templates.test.ts y tests/unit/llm/prompt.test.ts: R-HANDOFF-COMPLAINT en sus dos variantes (derivada con y sin franja; sin vías con CONTACTO) y la regla de quejas del prompt con el contraejemplo de comentario negativo
- [ ] T118 [P] [US6] Test de integración tests/integration/handoff/complaint.test.ts: queja con vías → R-HANDOFF-COMPLAINT, aviso con tipo "queja o reclamación" y el cuerpo del modelo descartado aunque el fake devuelva una explicación; queja sin vías o con las vías caídas → disculpa + CONTACTO sin cuerpo; `complaint = false` con texto negativo → respuesta normal

### Implementation for User Story 6

- [ ] T119 [US6] Añadir las filas 1 y 2 a src/handoff/decision.ts y el recálculo del tipo durante `collecting`
- [ ] T120 [P] [US6] Añadir R-HANDOFF-COMPLAINT (derivada y sin vías) a src/handoff/templates.ts
- [ ] T121 [US6] Usar R-HANDOFF-COMPLAINT en src/conversation/processor.ts para las filas 1 y 2 y cuando `start` no se entrega con `kind = complaint`
- [ ] T122 [US6] Añadir la regla de quejas a src/llm/prompt.ts según [contracts/handoff-flow.md](contracts/handoff-flow.md)
- [ ] T123 [P] [US6] Crear tests/eval/sc-handoff-complaint.test.ts (SC-006, modelo real) con quejas y comentarios negativos que no lo son en tests/fixtures/eval/ (las tres fixtures): ≥ 95 % de quejas derivadas sin intento de resolverlas y ≥ 90 % de comentarios atendidos con normalidad

**Checkpoint**: las seis historias funcionan; la tabla de decisión está completa.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: neutralidad, privacidad, retención, documentación y validación final.

- [ ] T124 [P] Ampliar tests/unit/sector-neutrality.test.ts (y tests/integration/sector-neutrality.test.ts si recorre carpetas) para que recorra `src/handoff`, `src/mail`, `src/channels/handoff-links` (incluidas vistas y CSS), src/llm/summary-prompt.ts y src/cli/handoff-templates.ts (FR-024)
- [ ] T125 [P] Test de integración tests/integration/handoff/activity-log.test.ts: flujo completo (petición, datos, aviso, reenvío, recordatorio, botón, fin) con nombre, teléfono, email de avisos y una palabra del motivo marcados; ninguno aparece en la salida del logger; los eventos del negocio no llevan seudónimo (FR-022)
- [ ] T126 [P] Test de integración tests/integration/handoff/retention.test.ts: con reloj a +30 días, la retención borra la conversación derivada y con ella `handoff`, `handoff_notice`, `contact_name`, `contact_phone` y `handoff_step` (FR-023)
- [ ] T127 [P] Ampliar tests/integration/conversation/channel-parity.test.ts: la misma petición de persona produce la misma decisión y plantilla en WhatsApp, web y playground, salvo lo que dice `ChannelPolicy` (datos del canal y vía simulada)
- [ ] T128 [P] Añadir a tests/integration/performance.test.ts (o a tests/integration/handoff/latency.test.ts) la comprobación de SC-002 con fakes en su plazo máximo: desde el último mensaje hasta el aviso aceptado < 1 min, y `/handoff/*` p95 < 100 ms
- [ ] T129 Ejecutar `pnpm lint`, `pnpm typecheck` y `pnpm test` y corregir lo que falle
- [ ] T130 Revisión de seguridad de `/handoff/*`, el enrutador del negocio y el email (token, cabeceras, escape en HTML, inyección en cabeceras, límite por IP) con el agente `security-auditor`; anotar hallazgos y decisiones al final de este fichero
- [ ] T131 Ejecutar `pnpm test:eval` (sc008 adaptado, sc-handoff-summary, sc-handoff-offer, sc-handoff-complaint) y anotar los porcentajes obtenidos y el resultado de la revisión manual de SC-003
- [ ] T132 Recorrer [quickstart.md](quickstart.md) (escenarios 1–6 y 8; el 7 si hay número de pruebas de WhatsApp) con Mailpit y "Probar el bot"
- [ ] T133 Avisar al usuario y actualizar README.md: estado de la feature 005, `pnpm handoff:templates`, variables `SMTP_URL`/`SMTP_FROM`/`WHATSAPP_TEMPLATE_LANG`, página "Derivaciones" y las consecuencias del plan (plantillas de Meta con coste, aviso `HANDOFF_ALERTS_NONE`)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias.
- **Foundational (Phase 2)**: depende de Setup; bloquea todas las historias.
- **US1 (Phase 3)**: depende de Foundational. Crea `decision.ts`, `service.ts`, las vías y la
  integración en el procesador, que el resto de historias amplían.
- **US2 (Phase 4)**: depende de US1 (reutiliza el inicio y la recogida de datos).
- **US3 (Phase 5)**: depende de US1 (necesita derivaciones activas).
- **US4 (Phase 6)**: depende de US1; sus tests de vuelta al bot en la web usan la franja de US3.
- **US5 (Phase 7)**: depende de US1 (confirmación y `reminder_due_at`) y de la parte de barrido
  de US4 (T101).
- **US6 (Phase 8)**: depende de US1.
- **Polish (Phase 9)**: depende de las historias que se entreguen.

### User Story Dependencies

```text
Setup → Foundational → US1 ─┬─ US2
                            ├─ US3 ─── US4 ─── US5
                            └─ US6
```

US2, US3 y US6 pueden avanzar en paralelo tras US1, pero tocan los mismos ficheros
(`decision.ts`, `templates.ts`, `processor.ts`, `prompt.ts`): en paralelo, hacerlo en ramas y
fusionar con cuidado, o en serie en el orden de prioridad US3 → US2 → US6.

### Within Each User Story

- Los tests se escriben primero y deben fallar.
- Plantillas, composición de avisos y decisión (puras) → vías y servicio → procesador y
  composición en `bot.ts` → panel y canales.
- La historia se cierra con su checkpoint antes de pasar a la siguiente.

### Parallel Opportunities

- Phase 1: T002 y T003.
- Phase 2: T010–T013, T019, T022–T023, T025, T027–T028, T032 y T034 (ficheros distintos).
- US1: todos los tests T036–T049; en implementación, T050–T052, T054, T057–T059 y T069.
- US3–US6: los tests de cada historia entre sí; las vías (`template-sender`, `smtp-mailer`,
  `simulated-route`) se pueden ampliar a la vez.
- Phase 9: T124–T128.

---

## Parallel Example: User Story 1

```bash
# Tests de US1 a la vez (deben fallar):
Task: "Test unitario tests/unit/handoff/decision.test.ts (filas 3–5 y § Datos)"
Task: "Test unitario tests/unit/handoff/summary.test.ts (verificación y respaldo)"
Task: "Test unitario tests/unit/channels/template-sender.test.ts (derivacion_aviso)"
Task: "Test unitario tests/unit/mail/smtp-mailer.test.ts (aviso por email)"
Task: "Test de integración tests/integration/handoff/request.test.ts"

# Piezas puras y adaptadores de US1 a la vez:
Task: "Crear src/handoff/contact-data.ts"
Task: "Crear src/handoff/templates.ts"
Task: "Crear src/handoff/notices.ts"
Task: "Crear src/channels/whatsapp/template-sender.ts"
Task: "Crear src/mail/smtp-mailer.ts"
Task: "Crear src/handoff/simulated-route.ts"
```

## Parallel Example: User Story 4

```bash
Task: "Test de contrato tests/contract/whatsapp-business.test.ts"
Task: "Test de contrato tests/contract/handoff-links.test.ts"
Task: "Ampliar tests/contract/admin/handoffs.test.ts (derivaciones activas)"
Task: "Test de integración tests/integration/handoff/end.test.ts"
```

---

## Implementation Strategy

### MVP First (US1 + US3)

1. Phase 1: Setup.
2. Phase 2: Foundational (bloquea todo).
3. Phase 3: US1 — el negocio recibe el aviso.
4. Phase 5: US3 — el bot calla y reenvía. Sin ella, derivar deja al bot contestando encima del
   negocio, así que el MVP útil son las dos historias P1 juntas.
5. **STOP and VALIDATE**: quickstart, escenario 2 (pasos 1–4), en "Probar el bot" y en el chat
   web con Mailpit. Mientras no esté US4, las derivaciones solo terminan desde la BD: no
   desplegar a clientes reales sin US4.

### Incremental Delivery

1. Setup + Foundational → base lista, bot sin cambios.
2. US1 + US3 → MVP demostrable.
3. US2 → las consultas sin dato se convierten en derivaciones.
4. US4 → las derivaciones terminan (**mínimo para producción**).
5. US5 → horario y recordatorio.
6. US6 → quejas.
7. Polish → neutralidad, privacidad, seguridad, eval y README.

### Parallel Team Strategy

Tras US1, una persona en US3 → US4 → US5 (cadena de estado y plazos) y otra en US2 y US6
(tabla de decisión y prompt), coordinando los cambios en `decision.ts`, `templates.ts`,
`processor.ts` y `prompt.ts`.

---

## Notes

- [P] = ficheros distintos y sin dependencias pendientes.
- [USn] liga la tarea a su historia para la trazabilidad.
- Verificar que los tests fallan antes de implementar.
- Commit tras cada tarea o grupo lógico.
- Parar en cada checkpoint para validar la historia por separado.
- Evitar: tareas vagas, dos tareas [P] sobre el mismo fichero, dependencias entre historias que
  rompan su independencia más allá de las indicadas arriba.
