---

description: "Lista de tareas de la feature 012: protección frente a abuso y saturación"
---

# Tasks: Protección frente a abuso y saturación

**Input**: documentos de diseño de `/specs/012-abuse-protection/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md) (R1–R18),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Ámbito**: núcleo (propuesta P8).

**Tests**: sí. El plan (Technical Context → Testing) los pide: `unit`, `contract` (`fastify.inject`)
e `integration` (Testcontainers), y la constitución exige pruebas de los Principios IV y V (contacto
en toda respuesta sin modelo, salida a una persona con cada límite alcanzado, enlaces verificados).
Dentro de cada historia, los tests se escriben primero y deben fallar antes de implementar.

**Organización**: por historia de usuario (spec.md), en orden de prioridad: US1 y US2 (P1); US3,
US4 y US8 (P2); US5, US6 y US7 (P3).

## Formato: `[ID] [P?] [Story] Descripción`

- **[P]**: se puede hacer en paralelo (ficheros distintos, sin dependencias pendientes)
- **[Story]**: historia a la que pertenece (US1…US8)
- Cada tarea indica la ruta exacta del fichero

## Convenciones del proyecto que afectan a todas las tareas

- Specs, comentarios, mensajes y textos de la interfaz, en español.
- Dominio sin HTTP: `src/usage/protection.ts`, `src/usage/transcription-cost.ts`,
  `src/handoff/limits.ts`, `src/handoff/customer-text.ts` y `src/conversation/link-rule.ts` **no
  importan Fastify**. La clave por dirección, la cola del login y los límites de rutas viven en
  `src/channels` y `src/admin`.
- En `src/` no puede haber nombres ni límites de un sector o cliente (FR-038); los ejemplos con
  marcas solo en `tests/fixtures/`.
- Migración de solo añadir `0008_abuse_protection.sql`; las publicadas (`0000`–`0007`) no se tocan.
  **No sube `formatVersion`**: nada de esto es configuración del negocio (FR-036).
- Sin caché en tope, protección ni ajustes: se leen en cada mensaje.
- Días en hora local del negocio (zona IANA); importes en enteros (billonésimas, millonésimas por
  minuto); duraciones medidas por la máquina en ms y configuradas por el operador en minutos.
- Ningún dato personal ni secreto en tablas de consumo, contadores, eventos ni registros.
- `computeWarnings` no cambia: los avisos de protección se calculan aparte con
  `protectionWarnings(state)` y **no** entran en `guardedTransaction` (R3).

---

## Phase 1: Setup (infraestructura compartida)

**Purpose**: ficheros de prueba y carpetas que usan varias historias.

- [ ] T001 [P] Crear `tests/fixtures/audio/generate.ts` (script de Node sin dependencias, ejecutable con `pnpm tsx`) que escriba en `tests/fixtures/audio/` las notas de voz Ogg/Opus de R6.3: `voice-3s.ogg` (última `granule_position` = 3 × 48 000), `voice-119s.ogg`, `no-granule.ogg` (sin página final válida), `truncated.ogg` y `not-ogg.bin`; añadir `tests/fixtures/audio/README.md` con la lista y la duración esperada de cada uno, y generar y versionar los ficheros
- [ ] T002 [P] Crear `tests/fixtures/links/battery.ts` con la batería de textos de SC-008 y SC-011 (contracts/link-rule.md y handoff-limits.md): con y sin protocolo, `http://`, `www.`, dominios sueltos con TLD real e inventado, `xhttps://otra.web`, signos pegados (`(https://a.es)`, `https://a.es.`, `«https://a.es»`), mayúsculas, credenciales (`https://u:p@a.es`), puertos, IDN, caracteres de ancho completo, correos, y falsos positivos (`3.5 kg`, `p.ej.`, `v1.2.3`); cada caso con los `LinkMatch` esperados de `displayLinks` y `linkCandidates` y la salida esperada de `customerQuote`
- [ ] T003 [P] Crear `tests/fixtures/secrets/battery.ts` con la batería de SC-010: un entorno de producción válido (secretos generados con `src/provisioning/generate.ts`) y, por cada variable de contracts/logging-and-startup.md, variantes `too_short`, `example_value` (valores de `.env.example` y la contraseña `chatbot`), `trivial` (relleno, carácter repetido, secuencia), `reused` (mismo valor en dos variables, con mayúsculas distintas) y ausencia de `BACKUP_KEY`/`HEALTH_SECRET`; cada caso con su `SecretFinding[]` esperado

---

## Phase 2: Foundational (prerrequisitos que bloquean todas las historias)

**Purpose**: esquema y migración, tipos comunes, catálogo de eventos, clave por dirección, regla de
enlaces de dominio y `process_after` en el procesador. Ninguna historia puede empezar sin esto.

**⚠️ CRÍTICO**: la migración usa `ALTER TYPE … ADD VALUE`, que no se puede usar en la misma
transacción que lo añade: ni los `CHECK` ni el relleno usan los valores nuevos.

- [ ] T004 Ampliar `src/db/schema.ts` según data-model §1: valores de enum `usage_purpose.transcription`, `message_status.held`, `handoff_end_cause.interrupted`; columna `audio_ms integer` nula en `model_usage` con `CHECK (audio_ms is null or audio_ms >= 0)`; `whatsapp_daily_cap integer not null default 200` con `CHECK between 1 and 10000` y `whatsapp_cap_notified_day date` en `usage_settings`; tablas nuevas `transcription_price` (`model text` PK, `micros_per_minute bigint not null` ≥ 0, `updated_at` con `clock_timestamp()`), `whatsapp_usage_day` (`day date` PK, `replies integer not null` ≥ 0), `handoff_limits` (fila única `id smallint` PK `CHECK (id = 1)`, `daily_max` 20 en 1–200, `forward_interval_minutes` 15 en 5–240, `notices_daily_max` 60 en 10–500, `updated_at`) y `handoff_day` (`day date` PK, `started`, `refused`, `notices`, `notices_held` `integer not null default 0` con `CHECK >= 0`, `refused_logged` y `held_logged` `boolean not null default false`); columnas `batch_attempts smallint not null default 0` (`CHECK between 0 and 5`) y `process_after timestamptz` en `conversation`; `alerts_sent_at`, `customer_notified_at` y `last_notice_at` `timestamptz` nulos en `handoff`
- [ ] T005 Generar la migración con drizzle-kit y renombrarla a `src/db/migrations/0008_abuse_protection.sql` (con `src/db/migrations/meta/0008_snapshot.json` y la entrada en `src/db/migrations/meta/_journal.json`); añadir a mano el `INSERT` de la fila de `handoff_limits` y el relleno de `handoff`: `alerts_sent_at = customer_notified_at = started_at` y `last_notice_at = coalesce(max(handoff_notice.created_at), started_at)`; revisar que no usa los valores de enum nuevos y que no edita ninguna migración publicada (depende de T004)
- [ ] T006 [P] Test de integración de la migración en `tests/integration/migration-0008.test.ts` (Testcontainers): sobre una BD en `0007` con derivaciones y avisos existentes, aplicar `0008` y comprobar la fila única de `handoff_limits` con sus valores por defecto, el relleno de las tres columnas de `handoff`, `whatsapp_daily_cap = 200`, que los `CHECK` rechazan valores fuera de rango (incluido `id = 2` en `handoff_limits`) y que los valores de enum nuevos se pueden usar después (depende de T005)
- [ ] T007 [P] Añadir `transcription_price`, `whatsapp_usage_day`, `handoff_limits` y `handoff_day` a la lista de tablas que no viajan en `tests/unit/config-transfer/usage-tables.test.ts`, y comprobar que `tests/unit/config-transfer/column-coverage.test.ts` sigue en verde **sin** subir `formatVersion` en `src/config-transfer/format.ts` (FR-036; depende de T004)
- [ ] T008 [P] Ampliar `tests/unit/usage/model-usage-columns.test.ts` con `audio_ms` (la lista de columnas permitidas de `model_usage` sigue sin textos ni identificadores de cliente o conversación) (depende de T004)
- [ ] T009 [P] Ampliar los tipos de `src/usage/types.ts`: `UsagePurpose` con `'transcription'`; `ContactOnlyReason` (`cap_disabled` | `model_unpriced` | `stt_unpriced` | `spend_unreadable`); `CapReason = ContactOnlyReason | 'spend_cap' | 'whatsapp_daily'`; `ProtectionState` y `HandoffLimits` como en data-model §2.1 y §2.3
- [ ] T010 [P] Ampliar el catálogo cerrado de `src/conversation/activity-log.ts` con los eventos de data-model §3 (`protection_read_failed`, `contact_only_reply`, `whatsapp_quota_reached`, `transcription_usage_failed`, `handoff_daily_limit`, `business_notices_held`, `handoff_forward_deferred`, `batch_retry_scheduled`, `batch_abandoned`, `login_throttled`, `weak_secrets`) y los valores nuevos `transcription_failed.reason: 'blocked'`, `handoff_not_started.reason: 'daily_limit'`, `handoff_ended.cause: 'interrupted'` con `heldMessages`; tipados sin texto libre, y ampliar `tests/unit/conversation/activity-log.test.ts` para que ninguno acepte campos fuera del catálogo
- [ ] T011 [P] Test unitario de la clave por dirección en `tests/unit/channels/client-key.test.ts` con la tabla de contracts/public-routes-and-login.md: IPv4 tal cual; `::ffff:a.b.c.d` como IPv4; IPv6 reducida a su `/64` normalizado (`2001:db8:1:2::/64`) también desde la forma expandida con ceros; `::1`; entrada no válida → la cadena tal cual
- [ ] T012 Crear `src/channels/client-key.ts` con `clientKey(ip: string): string` usando `node:net` (`isIPv4`/`isIPv6`) sin dependencias nuevas, y registrarlo como `keyGenerator` por defecto de `@fastify/rate-limit` en `src/app.ts` (`app.register(rateLimit, { global: false, keyGenerator: (req) => clientKey(req.ip) })`), de modo que lo usen todas las rutas con límite: login, salud, `/chat/api/*` y `/handoff/*` (FR-020; depende de T011)
- [ ] T013 [P] Test unitario de la regla de enlaces en `tests/unit/conversation/link-rule.test.ts` con la batería de T002: `displayLinks` y `linkCandidates` dan los `LinkMatch` esperados, y para todo texto `displayLinks(t) ⊆ linkCandidates(t)` (mismo `start`, `end` y `url`); `xhttps://otra.web` es candidato; `3.5 kg`, `p.ej.` y `v1.2.3` no lo son
- [ ] T014 [P] Crear `src/conversation/tlds.ts` con la lista de dominios de primer nivel de IANA embebida (un `Set<string>` en minúsculas, con la fecha de la lista en un comentario) y su función `isKnownTld(label)`
- [ ] T015 Crear `src/conversation/link-rule.ts` (dominio, sin HTTP) con `LinkMatch`, `displayLinks(text)`, `linkCandidates(text)` y `DISPLAY_LINK_RULE { candidate, flags, trailing }` según contracts/link-rule.md: `displayLinks` = `https://` sin borde de palabra delante, signos finales `.,;:!?]}»` fuera, válido si `URL` lo analiza con `https:`, host con punto y sin credenciales; `linkCandidates` = lo anterior más `http://`, `www.` y dominios sueltos con TLD de `tlds.ts` (depende de T014; T013 debe pasar)
- [ ] T016 Añadir a `src/conversation/repositories/conversation.ts` la condición `and (c.process_after is null or c.process_after <= $now)` en `claimReady`, y funciones `setProcessAfter(tx, conversationId, at)` y `resetBatch(tx, conversationId)` (`batch_attempts = 0`, `process_after = null`); test de integración en `tests/integration/conversation/claim-ready.test.ts` de que una conversación con `process_after` futuro no se reclama y sí al vencer (depende de T005)

**Checkpoint**: esquema migrado, tipos y eventos listos, clave /64 activa en las rutas existentes,
regla de enlaces disponible para US2 y US7, y `process_after` respetado por el procesador.

---

## Phase 3: User Story 1 - El gasto de una instancia en producción siempre está acotado (Priority: P1) 🎯 MVP

**Goal**: en producción no se llama al modelo sin tope activo y con precio; el tope falla cerrado; la
transcripción se comprueba antes de descargar y suma al gasto; WhatsApp tiene tope diario de
respuestas con modelo.

**Independent Test**: en producción sin tope, el negocio no se puede activar y uno ya activo responde
con el contacto sin llamar al modelo; con el tope y precio, se atiende; con el gasto ilegible, no se
llama al modelo; un audio con el tope alcanzado no se descarga ni se transcribe; superado el tope
diario de WhatsApp, R-CAP hasta las 00:00 locales.

### Tests for User Story 1 ⚠️

> Escribir primero; deben fallar antes de implementar.

- [ ] T017 [P] [US1] Test unitario de la tabla de casos en `tests/unit/usage/protection.test.ts` (data-model §2.1): `canCallModel(state, 'whatsapp' | 'web')` y `canTranscribe(state, canal)` para cada motivo, en producción y fuera de ella, con tope alcanzado y con tope diario de WhatsApp alcanzado; `stt_unpriced` solo afecta a `canTranscribe`; orden de `reason` con varios motivos (`spend_unreadable`, `cap_disabled`, `model_unpriced`, `stt_unpriced`, `spend_cap`, `whatsapp_daily`); `protectionWarnings(state)` devuelve los códigos de data-model §2.2 con `target.kind = 'instance'` y el nombre del modelo en `MODEL_UNPRICED`/`STT_MODEL_UNPRICED`
- [ ] T018 [P] [US1] Test unitario en `tests/unit/usage/transcription-cost.test.ts`: `transcriptionCostPico(audioMs, microsPerMinute)` = `ceil(audio_ms × micros × 50 / 3)` con enteros grandes (`bigint`), 0 ms, precio 0 y sin precio → `null`; `oggOpusDurationMs(bytes)` con los ficheros de T001 (3 s, 119 s; `null` para `no-granule.ogg`, `truncated.ogg` y `not-ogg.bin`); `resolveAudioMs(providerSeconds, bytes, audioMaxSeconds)` prefiere proveedor → Ogg → máximo (nunca infraestima)
- [ ] T019 [P] [US1] Ampliar `tests/unit/usage/schemas.test.ts` con `whatsappDailyCap` (1–10 000, entero, mensaje con el rango), el precio por minuto de transcripción (decimal hasta 6 decimales, 0–1 000 000, modelo 1–200 caracteres sin espacios a los lados) y el rechazo de `capEnabled = false` en producción con el negocio activo
- [ ] T020 [P] [US1] Test de integración en `tests/integration/usage/protection-state.test.ts`: `protectionState` hace una sola consulta (contar consultas con el registro de Drizzle), lee ajustes, gasto del mes, existencia de precio de `LLM_MODEL` y de `STT_MODEL` y respuestas de WhatsApp del día local; con la consulta fallida o con un retraso > 2 s (`pg_sleep` en una vista de prueba o doble del ejecutor) devuelve `contactOnly: ['spend_unreadable']` y el resto `null`, sin lanzar, y registra `protection_read_failed` como mucho una vez por minuto
- [ ] T021 [P] [US1] Test de integración en `tests/integration/protection/contact-only.test.ts`: con `production: true` y negocio activo, por cada motivo (`cap_disabled`, `model_unpriced`, `spend_unreadable`) un mensaje por WhatsApp recibe R-CAP con el contacto del negocio y `capReason`, y uno por el chat web recibe «no disponible» (`reason: 'quota'`) con el contacto; el modelo doble no se llama nunca (SC-001); se registra `contact_only_reply` con su `reason`; sin snapshot legible → R-ERR con el contacto de emergencia; fuera de producción sin tope se atiende con el modelo (010); y en el chat web, una respuesta con modelo cuyo registro de consumo falla o sin tokens del proveedor suma igual en `web_usage_day` y cuenta para el tope diario de la 004 (FR-005)
- [ ] T022 [P] [US1] Test de integración en `tests/integration/protection/handoff-with-cap.test.ts` (Principio V, SC-002): con el tope de gasto, con el tope diario de WhatsApp y con cada motivo de `contactOnly`, una petición de persona por WhatsApp sigue derivándose con el detector determinista y el resumen literal (010)
- [ ] T023 [P] [US1] Test de integración en `tests/integration/protection/transcription.test.ts`: con el tope alcanzado, con el tope diario del canal alcanzado y con `stt_unpriced` en producción, un audio no llama a `fetchAudio` ni a `stt.transcribe`, queda `transcription = failed` con `transcription_failed { reason: 'blocked' }` y el cliente recibe R-CAP (SC-002); bajo el tope, `model_usage` gana una fila `purpose = 'transcription'`, `model = STT_MODEL`, `calls = 1`, tokens a 0, `audio_ms` y `cost_pico` según `transcription_price` (nulo sin precio) que suma al gasto del mes; una transcripción con error tras responder el proveedor también se registra; un fallo del registro emite `transcription_usage_failed` y no rompe la respuesta
- [ ] T024 [P] [US1] Test de integración con reloj falso en `tests/integration/protection/whatsapp-daily-cap.test.ts`: tras `whatsapp_daily_cap` respuestas con modelo, la siguiente es R-CAP con `capReason: 'whatsapp_daily'` y `whatsapp_quota_reached` sale una sola vez ese día; a las 00:00 locales del negocio vuelve el modelo; las respuestas con el registro de consumo fallido o sin tokens del proveedor cuentan igual (FR-005); «Probar el bot» y el chat web no cuentan
- [ ] T025 [P] [US1] Ampliar `tests/contract/admin/usage.test.ts`: secciones «Tope diario de WhatsApp» y «Precios de transcripción»; `POST /admin/usage/whatsapp-cap` (303 / 422 por rango); `POST /admin/usage/transcription-prices` y `/:model/delete` (303 / 404 / 422); en producción con el negocio activo, desactivar el tope → 422 en `capEnabled` con «En producción el tope de gasto es obligatorio mientras el negocio está activo.» y borrar el precio de `LLM_MODEL` o, con audios, de `STT_MODEL` → 422 con el mensaje de contracts/protection-conversation.md; con el negocio desactivado se permite; el tope del chat web (004) no baja de 1 (FR-011); visibilidad de las secciones según contracts/admin-protection.md
- [ ] T026 [P] [US1] Test de contrato de la banda común en `tests/contract/admin/protection-banner.test.ts`: en producción sin tope, la banda con `SPEND_CAP_REQUIRED` y enlace a «Consumo» aparece en **todas** las pantallas del panel (recorrer las rutas GET de `src/admin/routes/`), encima del aviso de gasto de la 010; los críticos también en la lista de avisos del inicio; activar el negocio se rechaza con la pantalla de avisos bloqueantes de hoy; el resto de escrituras del conocimiento siguen permitidas (R3); «Probar el bot» muestra «En producción, los clientes reciben ahora solo el contacto: <motivo>.» y sigue funcionando
- [ ] T027 [P] [US1] Ampliar `tests/contract/health.test.ts` y `tests/unit/provisioning/versions.test.ts`: con secreto, `spendCap: "blocked"` por `cap_disabled`, `model_unpriced`, `stt_unpriced` y `spend_unreadable`; sin credencial, sin cambios; `instance:versions` muestra `bloqueado` sin cambiar la clasificación de la fila ni el código de salida

### Implementation for User Story 1

- [ ] T028 [P] [US1] Crear `src/usage/transcription-cost.ts` (dominio): `transcriptionCostPico`, `oggOpusDurationMs` (última `granule_position` / 48 000, leyendo páginas `OggS`) y `resolveAudioMs` (T018 debe pasar)
- [ ] T029 [P] [US1] Ampliar `src/usage/schemas.ts` con `whatsappCapSchema`, `transcriptionPriceSchema` (precio por minuto en millonésimas desde el decimal, como los precios de la 010) y el error de producción de `capEnabled` (T019 debe pasar)
- [ ] T030 [US1] Ampliar `src/usage/settings.ts`: leer y guardar `whatsapp_daily_cap` en transacción; CRUD de `transcription_price` (`saveTranscriptionPrice`, `deleteTranscriptionPrice`) con la misma regla de moneda de la 010 (cambiar la moneda exige también esta tabla vacía); rechazos de FR-003 con `FieldConflictError` en `saveUsageSettings` (`capEnabled = false`), `deletePrice` (precio de `LLM_MODEL`) y `deleteTranscriptionPrice` (precio de `STT_MODEL` con audios) cuando `production` y el negocio está activo; recibe `production`, `llmModel` y `sttModel` como parámetros (depende de T029)
- [ ] T031 [US1] Crear `src/usage/protection.ts` (dominio, sin HTTP) con `protectionState(tx, { production, llmModel, sttModel, now, timezone })` en **una** consulta con `statement_timeout`/plazo de 2 s (`PROTECTION_READ_TIMEOUT_MS`) que nunca lanza, `checkProtection(tx, input, activityLog, logContext?)` que además emite `spend_cap_reached` y `whatsapp_quota_reached` una vez por periodo con las marcas persistidas (`cap_notified_month`, `whatsapp_cap_notified_day`) y `protection_read_failed` como mucho una vez por minuto, `canCallModel`, `canTranscribe` y `protectionWarnings`; reutilizar el cálculo de nivel de `src/usage/spend-cap.ts` sin duplicarlo; los contadores de derivación del estado quedan `null` hasta US2 (T017 y T020 deben pasar; depende de T009, T010)
- [ ] T032 [US1] Añadir `recordTranscription(tx, { channel, model, audioMs, at, timezone })` a `src/usage/meter.ts`: inserta en `model_usage` con `purpose = 'transcription'`, `calls = 1`, tokens a 0, `audio_ms` y el coste congelado de `transcriptionCostPico` (nulo sin precio); nunca lanza y emite `transcription_usage_failed` (depende de T028, T030)
- [ ] T033 [US1] Hacer que `src/speech/whisper.ts` devuelva la duración que informa el proveedor (`duration`, en segundos) junto al texto y también en los errores tras responder el proveedor, sin cambiar su plazo (010)
- [ ] T034 [US1] En `src/conversation/transcription.ts` (`createTranscriber`): antes de `fetchAudio`, `checkProtection` + `canTranscribe(state, canal)`; si no puede, `setTranscription(failed)`, `transcription_failed { reason: 'blocked' }` y despertar al procesador sin descargar; si puede, tras transcribir (bien o con error del proveedor) llamar a `recordTranscription` con `resolveAudioMs(proveedor, bytes, audioMaxSeconds)` (T023 debe pasar; depende de T031, T032, T033)
- [ ] T035 [US1] Añadir el contador de WhatsApp: función `incrementWhatsappReplies(tx, day)` en `src/usage/whatsapp-usage.ts` (upsert en `whatsapp_usage_day`) llamada en la transacción del saliente de `src/conversation/processor.ts` cuando la respuesta es de WhatsApp y `response.modelCalled`, haya o no registro de consumo (FR-005); día local con la zona del negocio
- [ ] T036 [US1] En `src/conversation/processor.ts`, sustituir `spendCapReached` por `checkProtection` + `canCallModel(state, canal)`: sin modelo, WhatsApp responde R-CAP (salida sintética para la derivación, como en la 010) con `capReason` en la traza y `contact_only_reply` cuando el motivo es de `contactOnly` o `whatsapp_daily`; sin snapshot, R-ERR con el contacto de emergencia; «Probar el bot» no se corta (T021, T022 y T024 deben pasar; depende de T031, T035)
- [ ] T037 [US1] En `src/conversation/intake.ts` (recepción web) y `src/webchat/availability.ts` (frame y API), sustituir `checkSpendCap` por `checkProtection` + `canCallModel(state, 'web')` manteniendo el tope de la 004 y la salida «no disponible» (`quota`) con el contacto (depende de T031)
- [ ] T038 [US1] Pasar `production` (`NODE_ENV === 'production'`), `LLM_MODEL` y `STT_MODEL` (solo con `AUDIO_TRANSCRIPTION=on`) desde `src/config/env.ts`/`src/app.ts` a procesador, recepción, transcripción, disponibilidad, panel y salud, sin leerlos de `process.env` en el dominio
- [ ] T039 [US1] Ampliar `src/usage/retention.ts` para purgar `whatsapp_usage_day` con más de 400 días en la misma pasada que `web_usage_day`, y su caso en `tests/integration/usage/retention.test.ts`
- [ ] T040 [US1] Rutas nuevas en `src/admin/routes/usage.ts` (`POST /admin/usage/whatsapp-cap`, `POST /admin/usage/transcription-prices`, `POST /admin/usage/transcription-prices/:model/delete`) con sesión, CSRF, 303/404/422 y formulario repintado; secciones «Tope diario de WhatsApp» (hoy / tope) y «Precios de transcripción» en `src/admin/views/usage.eta`, con el aviso de que en producción el tope de gasto es obligatorio, y las reglas de visibilidad de contracts/admin-protection.md (T025 debe pasar; depende de T030)
- [ ] T041 [US1] Crear `src/admin/views/partials/protection-banner.eta` y calcular `protectionWarnings(state)` en cada página desde `src/admin/render.ts` (layout común, encima del aviso de gasto de la 010, con enlace a «Consumo»); añadir los críticos a la lista de avisos del inicio en `src/admin/routes/dashboard.ts` (depende de T031)
- [ ] T042 [US1] Bloquear la activación: `activateBusiness` en `src/knowledge/services/business-status.ts` recibe los avisos de protección y lanza `ActivationBlockedError` si hay alguno crítico, además de `computeWarnings`; `src/admin/routes/business.ts` calcula el estado y los pasa (T026 debe pasar; depende de T031)
- [ ] T043 [US1] Recordatorio en «Probar el bot»: con `contactOnly` no vacío, `src/admin/routes/playground.ts` y `src/admin/views/playground.eta` muestran «En producción, los clientes reciben ahora solo el contacto: <motivo>.» (texto por motivo en español)
- [ ] T044 [US1] `spendCap: "blocked"` en `src/health/report.ts` cuando `contactOnly` tiene `cap_disabled`, `model_unpriced`, `stt_unpriced` o `spend_unreadable`, y celda `bloqueado` en `src/provisioning/versions.ts` sin cambiar clasificación ni código de salida (T027 debe pasar; depende de T031)

**Checkpoint**: US1 completa: el gasto de una instancia en producción está acotado en todos los
canales y la transcripción; MVP entregable.

---

## Phase 4: User Story 2 - Una derivación no se convierte en un canal de mensajes sin límite (Priority: P1)

**Goal**: límites por instancia (derivaciones nuevas al día, minutos entre avisos, avisos al día)
con reserva atómica antes de enviar; reenvíos agrupados; mensajes conservados (`pending` o `held`);
texto del cliente delimitado y con las direcciones desactivadas.

**Independent Test**: con una derivación activa, 100 mensajes seguidos producen como mucho un aviso
por intervalo y ninguno se pierde; con `daily_max` alcanzado, una petición de persona recibe
R-HANDOFF-FAIL con contacto y el panel cuenta la petición sin aviso; ningún aviso contiene una
dirección pulsable.

### Tests for User Story 2 ⚠️

- [ ] T045 [P] [US2] Test unitario de `customerQuote` en `tests/unit/handoff/customer-text.test.ts` con la tabla de contracts/handoff-limits.md y la batería de T002 (SC-011): sin protocolo, `.` del host → `[.]`, `@` → `[@]`, signos finales fuera, mayúsculas, `3.5 kg` y `p.ej.` sin cambios; y el delimitado: en email `El cliente escribió:` con cada línea sangrada 4 espacios entre `«»` y nada del cliente en la columna 0; en variables de plantilla `El cliente escribió: «…»` y `Según el cliente: «…»`; motivo `Motivo (según el cliente): «…»`
- [ ] T046 [P] [US2] Test unitario de `handoffLimitsSchema` en `tests/unit/handoff/limits-schema.test.ts`: enteros en los rangos de data-model §1.6, un error por campo con el rango en el mensaje, todos los errores a la vez
- [ ] T047 [P] [US2] Test de integración de la reserva atómica en `tests/integration/handoff/limits.test.ts`: `reserveHandoffStart` y `reserveNotice` con 50 llamadas concurrentes y máximo N reservan exactamente N; sin plaza suman `refused`/`notices_held`; `handoff_daily_limit` y `business_notices_held` se registran una vez por día local (marcas `refused_logged`/`held_logged`); el día cambia a las 00:00 locales; la vía simulada no cuenta
- [ ] T048 [P] [US2] Test de integración de la derivación nueva al límite en `tests/integration/handoff/daily-limit.test.ts` (Principio V): con `started = daily_max`, una petición de persona por WhatsApp y por web recibe R-HANDOFF-FAIL con el contacto del negocio, el negocio no recibe nada, `refused + 1` y `handoff_not_started { reason: 'daily_limit' }`; con plaza de derivación pero sin plaza de aviso, lo mismo con `notices_held + 1`; pedir persona con una derivación ya activa no es derivación nueva
- [ ] T049 [P] [US2] Test de integración del reenvío agrupado en `tests/integration/handoff/grouped-forward.test.ts` con reloj falso (SC-003): 100 mensajes seguidos con una derivación activa producen como mucho un aviso por `forward_interval_minutes`; los no enviados siguen `pending` con `conversation.process_after = last_notice_at + intervalo` y `handoff_forward_deferred { reason: 'interval' }`; al vencer sale **un** reenvío con todos (email con la hora de cada uno; plantilla unida y recortada a 700 caracteres); sin plaza diaria, `process_after` = 00:00 locales del día siguiente y `reason: 'daily_limit'`; el cliente no recibe nada distinto de lo habitual; ningún mensaje se pierde; el intervalo cuenta desde la alerta de inicio y desde cada recordatorio, no solo desde el último reenvío
- [ ] T050 [P] [US2] Test de integración de fin con pendientes en `tests/integration/handoff/held-messages.test.ts`: al terminar la derivación (negocio, inactividad, panel) los `pending` anteriores al fin pasan a `held`, no se reenvían, el bot no los contesta, `handoff_ended` lleva `heldMessages`, y se ven como «retenido (no reenviado)» en el panel y en «Probar el bot»
- [ ] T051 [P] [US2] Test de integración de recordatorios y límite por cliente en `tests/integration/handoff/reminder-limits.test.ts`: un recordatorio sin plaza diaria no se envía ni se acumula (`notices_held + 1`) y el cliente recibe igualmente R-HANDOFF-LATE si toca; con una derivación activa, los entrantes por encima del límite por cliente quedan `rate_limited`, no se reenvían nunca y R-LIMIT sale una vez por ventana (FR-012)
- [ ] T052 [P] [US2] Test de privacidad de los avisos en `tests/integration/handoff/customer-quote.test.ts` (SC-011): para la batería de T002, ningún email ni variable de plantilla enviada por las vías dobles contiene una dirección con protocolo ni un host sin `[.]`, tampoco en el resumen (del modelo o literal) ni en el nombre de contacto/perfil
- [ ] T053 [P] [US2] Ampliar `tests/contract/admin/usage.test.ts` con la sección «Límites de derivación»: `POST /admin/usage/handoff-limits` (303 / 422 con el rango), contadores de hoy (`started / daily_max`, peticiones sin aviso, `notices / notices_daily_max`, retenidos); y `tests/contract/admin/protection-banner.test.ts` con `BUSINESS_NOTICES_HELD` (aviso normal) cuando `notices_held > 0` hoy; y `tests/contract/admin/handoffs.test.ts` con los pendientes por intervalo (hora prevista) y los mensajes `held`

### Implementation for User Story 2

- [ ] T054 [P] [US2] Crear `src/handoff/customer-text.ts` (dominio): `customerQuote(text)` sobre `linkCandidates` de `src/conversation/link-rule.ts` más correos, y los formateadores `quoteForEmail(lines)`, `quoteForTemplate(text)`, `quoteSummaryForTemplate(text)` y `quoteReason(text)` (T045 debe pasar)
- [ ] T055 [P] [US2] Crear `src/handoff/limits.ts` (dominio sin HTTP): `handoffLimitsSchema`, `readHandoffLimits(tx)` sin caché, `saveHandoffLimits(tx, limits)` en transacción, `reserveHandoffStart(tx, day, max)` y `reserveNotice(tx, day, max)` con la sentencia única `INSERT … ON CONFLICT … DO UPDATE … WHERE … RETURNING` de data-model §1.7, `recordRefused`/`recordNoticeHeld` con las marcas de una vez al día, y `readHandoffDay(tx, day)` (T046 y T047 deben pasar; depende de T010)
- [ ] T056 [US2] Aplicar `customerQuote` y el delimitado en `src/handoff/notices.ts` y `src/handoff/templates.ts` al texto reenviado, al resumen y al nombre de contacto/perfil, sin cambiar las plantillas de WhatsApp aprobadas (solo el contenido de sus variables) (T052 debe pasar; depende de T054)
- [ ] T057 [US2] Repositorio de la derivación en `src/handoff/repositories/handoff.ts`: leer y escribir `alerts_sent_at`, `customer_notified_at` y `last_notice_at`; `markHeld(tx, conversationId, endedAt)` en `src/conversation/repositories/message.ts` (entrantes `pending` anteriores al fin → `held`) llamado desde todas las causas de fin
- [ ] T058 [US2] Derivación nueva con reserva en `src/handoff/service.ts` (`start`): reservar plaza diaria y plaza de aviso antes de avisar; sin plaza, no avisar, `refused + 1` o `notices_held + 1`, `handoff_not_started { reason: 'daily_limit' }`, y devolver «no entregado» para que el procesador responda R-HANDOFF-FAIL con el contacto; la vía simulada ni reserva ni cuenta; al reservar la plaza de aviso de la alerta de inicio, poner `last_notice_at = now` en la misma transacción que guarda la derivación (T048 debe pasar; depende de T055, T057)
- [ ] T059 [US2] Reenvío agrupado en `src/handoff/service.ts` (`forward`) y `src/conversation/processor.ts`: si `now − last_notice_at < forward_interval_minutes`, dejar los entrantes `pending`, `setProcessAfter(last_notice_at + intervalo)` y `handoff_forward_deferred { reason: 'interval' }`; si no, en una transacción pasar los entrantes a `forwarded`, reservar el aviso y poner `last_notice_at = now`, y después enviar **un** aviso con todos; sin plaza diaria, `process_after` = 00:00 locales del día siguiente y `reason: 'daily_limit'` (T049 debe pasar; depende de T016, T055, T056)
- [ ] T060 [US2] Recordatorios en `src/handoff/service.ts`: reservar plaza diaria antes de cada recordatorio reclamado con `claimDueReminders` y, con plaza, poner `last_notice_at = now` en la misma transacción; el recordatorio **no** espera al intervalo de agrupado (es un aviso programado, no texto del cliente), pero lo reinicia; sin plaza, darlo por enviado, `notices_held + 1` y sin acumular (T051 debe pasar; depende de T055)
- [ ] T061 [US2] Fin con retenidos: llamar a `markHeld` al terminar la derivación por cualquier causa en `src/handoff/service.ts` y añadir `heldMessages` a `handoff_ended`; mostrar `held` como «retenido (no reenviado)» en `src/admin/routes/handoffs.ts`, `src/admin/views/handoffs.eta` y en la traza de «Probar el bot» (`src/admin/playground-trace.ts`) (T050 debe pasar; depende de T057)
- [ ] T061a [US2] Revisar todos los usos de `message_status` y `handoff_end_cause` en `src/` (con `pnpm typecheck` y búsqueda de `'pending'`, `'forwarded'` y de las causas de fin) y fijar: los mensajes `held` **no** entran en el historial que se pasa al modelo (`src/conversation/processor.ts`, construcción del contexto) ni en `claimReady`, sí en la vista de conversación del panel y en la retención como los demás entrantes; `interrupted` tiene etiqueta «interrumpida (no consta el aviso)» en `src/admin/views/handoffs.eta` y en el resumen de derivaciones de `src/usage/summary.ts` si lo agrupa por causa. Test en `tests/integration/handoff/held-messages.test.ts` (T050): un mensaje `held` no aparece en la llamada al modelo doble del siguiente turno (depende de T057)
- [ ] T062 [US2] Contadores de derivación en el estado de protección: `protectionState` en `src/usage/protection.ts` añade `handoffs { started, refused, notices, held, limits }` del día local dentro de la misma consulta, y `protectionWarnings` devuelve `BUSINESS_NOTICES_HELD` cuando `held > 0` (depende de T031, T055)
- [ ] T063 [US2] Sección «Límites de derivación» en `src/admin/routes/usage.ts` (`POST /admin/usage/handoff-limits`) y `src/admin/views/usage.eta` con el formulario de los tres límites y los contadores de hoy; pendientes por intervalo con su hora prevista en `src/admin/views/handoffs.eta` (T053 debe pasar; depende de T055, T062)
- [ ] T064 [US2] Ampliar `src/conversation/retention.ts` para purgar `handoff_day` con más de 400 días, y su caso en `tests/integration/handoff/retention.test.ts`

**Checkpoint**: US1 y US2 completas: los dos vectores de gasto sin credenciales están cerrados.

---

## Phase 5: User Story 3 - Las rutas públicas del chat web resisten la saturación (Priority: P2)

**Goal**: límites por dirección en frame, hoja e imágenes del diseño antes de consultar la BD; imagen
comprobada por metadatos antes de leer bytes; pool principal acotado y pool público aparte.

**Independent Test**: ráfagas a cada ruta pública desde una dirección y desde un mismo /64 → 429 sin
consultas; imagen con versión falsa → 404 sin leer bytes; durante 10 000 peticiones públicas el panel
y el webhook responden en < 2 s.

### Tests for User Story 3 ⚠️

- [ ] T065 [P] [US3] Test de contrato en `tests/contract/web-chat-public-routes.test.ts`: `GET /chat/frame` 60/min, `/chat/design.css` 120/min y `/chat/design/:slot/:file` 120/min por dirección; por encima, 429 `text/plain` sin ninguna consulta a la BD (contar consultas con un doble del pool); el frame rechazado lleva la CSP de respaldo; direcciones distintas del mismo /64 comparten límite; `web_rejected { reason: 'ip_limit' }` sin la dirección
- [ ] T066 [P] [US3] Ampliar `tests/contract/web-chat-design.test.ts`: con un hash o una extensión que no son los vigentes, o sin imagen, 404 «No encontrado» sin llamar a `readDesignImageBytes` (espía); con la versión vigente, los bytes y las cabeceras de la 011
- [ ] T067 [P] [US3] Test de integración en `tests/integration/db/pools.test.ts`: el pool principal tiene `max = 10`, `connectionTimeoutMillis = 5 000`, `statement_timeout = 15 s` e `idle_in_transaction_session_timeout = 60 s` (comprobar con `SHOW` en una conexión); el público, `max = 3`, `statement_timeout = 5 s` y `connectionTimeoutMillis = 2 000`; con el pool público agotado, la API del chat responde 503 `{ "error": "busy" }` y el frame «no disponible» con el último contacto conocido, mientras el panel sigue atendiendo; migraciones, copias y `db:verify` no heredan esos plazos
- [ ] T068 [P] [US3] Test de integración de saturación en `tests/integration/saturation.test.ts` (SC-004): 10 000 peticiones a las rutas públicas desde una dirección y desde un mismo /64 (y repartidas entre 100 direcciones) mientras se miden `GET /admin` con sesión y `POST /webhooks/whatsapp` firmado: ambos < 2 s

### Implementation for User Story 3

- [ ] T069 [P] [US3] Añadir `readDesignImageMeta(db, slot)` → `{ sha256, mimeType } | null` (sin `bytes`) en `src/webchat/design/store.ts`
- [ ] T070 [US3] Opciones de pool en `src/db/client.ts`: `createDb` con `max`, `connectionTimeoutMillis`, `statement_timeout` e `idle_in_transaction_session_timeout` del pool principal, y `createPublicDb(databaseUrl)` para el pool público; migraciones (`src/db/migrate.ts`), copias y verificación siguen con sus conexiones propias sin `statement_timeout`
- [ ] T071 [US3] En `src/channels/web/routes.ts`: `config.rateLimit` en `/chat/frame` (60/min, respuesta 429 de texto con la CSP de respaldo), `/chat/design.css` y `/chat/design/:slot/:file` (120/min), con `web_rejected { reason: 'ip_limit' }`; la imagen comprueba primero `readDesignImageMeta` y solo lee bytes si coincide la versión (T065 y T066 deben pasar; depende de T012, T069)
- [ ] T072 [US3] Usar el pool público y su propio lector del snapshot para las lecturas del chat web (frame, hoja y diseño, disponibilidad, historial y estado de la API) en `src/channels/web/routes.ts`, `src/channels/web/api.ts` y `src/app.ts`; la recepción de mensajes sigue en el pool principal; pool agotado → 503 `busy` en la API y «no disponible» con el último contacto en el frame (T067 y T068 deben pasar; depende de T070)

**Checkpoint**: una avalancha pública no deja sin servicio al panel ni a WhatsApp.

---

## Phase 6: User Story 4 - El operador siempre puede entrar al panel con su credencial (Priority: P2)

**Goal**: el contador global de fallos pasa de bloqueo a retardo creciente; cola de verificaciones;
cookie de navegador conocido.

**Independent Test**: con muchos fallos desde varias direcciones, el operador entra con la
credencial correcta en < 30 s desde un navegador nuevo y al instante con la cookie de navegador
conocido; el ritmo del atacante queda limitado.

### Tests for User Story 4 ⚠️

- [ ] T073 [P] [US4] Test unitario en `tests/unit/admin/login-throttle.test.ts`: retardo `min(5 000, 250 × max(0, fallos_15min − 5))` y vuelta a cero al vaciarse la ventana; cola de 2 simultáneas + 50 esperando y rechazo con la cola llena; el intento con navegador conocido pasa delante y nunca se rechaza por cola llena; firma y verificación de la cookie `v1.<caducidad>.<hmac>` con clave HKDF de `SESSION_SECRET` y etiqueta `login-device` (caducada, manipulada o de otra clave → inválida)
- [ ] T074 [P] [US4] Ampliar `tests/contract/auth.test.ts`: con más fallos que el antiguo límite global, la credencial correcta entra (sin 429 global) tras el retardo; cola llena → 429 «Demasiados intentos. Inténtalo en unos segundos.» sin verificar; la cookie `__Host-chatbot-device` (`Secure` en producción, `HttpOnly`, `SameSite=Strict`, `Path=/`, 90 días) se pone al entrar y evita el retardo; se mantienen el límite de 5/min por dirección (ahora por /64), CSRF, Argon2id siempre y el error único 401; `login_throttled` sin dirección ni usuario, como mucho una vez por minuto
- [ ] T075 [P] [US4] Test de integración en `tests/integration/login-attack.test.ts` (SC-005): 200 fallos desde 50 direcciones simuladas en paralelo; el operador entra sin retardo con la cookie de navegador conocido aunque la cola esté llena; desde un navegador nuevo, con la cola por debajo de su capacidad, entra en < 30 s, y con la cola llena recibe 429 sin que cuente como fallo; el bot sigue respondiendo durante el ataque

### Implementation for User Story 4

- [ ] T076 [P] [US4] Crear `src/admin/auth/login-throttle.ts`: contador de fallos en memoria (15 min), `delayFor(failures)`, cola de verificación (2 + 50) con prioridad para el navegador conocido, y `signDeviceCookie`/`verifyDeviceCookie` con HKDF de `node:crypto` (T073 debe pasar)
- [ ] T077 [US4] En `src/admin/auth/routes.ts`: quitar el 429 por `GLOBAL_FAILURES_MAX`, aplicar en orden límite por dirección → CSRF → retardo (salvo cookie válida) → cola → verificación Argon2id y comparación en tiempo constante → error único; al entrar, poner la cookie de navegador conocido; registrar `login_throttled` (T074 y T075 deben pasar; depende de T012, T076)

**Checkpoint**: el operador nunca queda fuera del panel durante un ataque.

---

## Phase 7: User Story 8 - Los registros no guardan datos y la instancia no arranca insegura (Priority: P2)

**Goal**: errores con tipo y código; URL sin valores de consulta; reglas de secretos compartidas por
el arranque en producción y `instance:check`; `HEALTH_SECRET` obligatoria en producción.

**Independent Test**: errores con datos personales y secretos → el registro solo tiene tipo y código;
la verificación del webhook no deja el token; cada secreto débil, de ejemplo, repetido o ausente
impide el arranque en producción con el mismo veredicto que `instance:check`.

### Tests for User Story 8 ⚠️

- [ ] T078 [P] [US8] Test unitario en `tests/unit/app/logging.test.ts` (SC-009): el serializador `err` devuelve solo `{ type, code?, statusCode? }` para errores con mensaje, `stack`, `cause` y propiedades con teléfonos, correos, textos de cliente y tokens; `loggedUrl` devuelve la ruta con solo los nombres de los parámetros (`/webhooks/whatsapp?hub.mode&hub.verify_token&hub.challenge`) y `/handoff/:token`; ampliar `tests/unit/handoff/logged-url.test.ts` en consecuencia
- [ ] T079 [P] [US8] Prueba estática en `tests/unit/app/logger-calls.test.ts`: recorrer `src/**/*.ts` y fallar si alguna llamada a un logger (`log.`, `logger.`, `request.log.`, `app.log.`) pasa `.message`, `.stack` o un error fuera de la clave `err`
- [ ] T080 [P] [US8] Ampliar `tests/contract/whatsapp-webhook.test.ts`: tras `GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`, ninguna línea del registro capturado contiene el valor del token ni del reto
- [ ] T081 [P] [US8] Test unitario de las reglas en `tests/unit/config/secret-rules.test.ts` con la batería de T003: mínimos por variable de contracts/logging-and-startup.md, `too_short`, `example_value` (y comparación de la lista de ejemplos con los valores de `.env.example`), `trivial`, `reused` (sin distinguir mayúsculas), `health_secret_required`, contraseñas de `DATABASE_URL` y `SMTP_URL`; ningún mensaje contiene el valor
- [ ] T082 [P] [US8] Test de paridad en `tests/unit/config/startup-parity.test.ts` (SC-010, FR-035): para cada caso de la batería, `checkEnv` con `NODE_ENV=production` y `instance:check` (`src/provisioning/check.ts`) con perfil `production` dan las mismas incidencias de secretos y el mismo veredicto; con perfil `testing`, `instance:check` da las mismas incidencias como avisos y veredicto apto; fuera de producción, `checkEnv` no falla por calidad
- [ ] T083 [P] [US8] Ampliar `tests/integration/backup/startup.test.ts` (o crear `tests/integration/startup-secrets.test.ts`): en producción con un secreto débil o sin `HEALTH_SECRET` no arranca y el mensaje es `Configuración de la instancia no válida:` con `- <VARIABLE>: <regla en español>` sin el valor; en desarrollo arranca y registra `weak_secrets { findings: [{ variable, rule }] }`

### Implementation for User Story 8

- [ ] T084 [US8] Serializador `err` (`{ type: error.name, code, statusCode }`) y `loggedUrl` con solo nombres de parámetros en `src/app.ts`; revisar todas las llamadas a loggers de `src/` para que pasen el error solo como `{ err }` (T078, T079 y T080 deben pasar)
- [ ] T085 [US8] Crear `src/config/secret-rules.ts` moviendo las reglas de calidad de `src/provisioning/secrets.ts` (que pasa a importarlas para generar) y ampliándolas con `example_value`, `reused`, `health_secret_required`, las contraseñas de `DATABASE_URL`/`SMTP_URL` y los mínimos por variable; `checkSecrets(env): SecretFinding[]` sin exponer valores; actualizar `tests/unit/provisioning/secrets.test.ts`. La regla `reused` **sustituye** a `backup_key_equals_session`, `health_secret_equals_session` y `health_secret_equals_backup_key` de `src/config/env.ts` y a `secret_reused_within` de `src/provisioning/check.ts`: se eliminan esos códigos, sus mensajes y sus traducciones en `translateCoreIssue`, y sus pruebas pasan a `tests/unit/config/secret-rules.test.ts`. El mensaje de `reused` nombra las dos variables (`- HEALTH_SECRET: coincide con SESSION_SECRET`) sin el valor (T081 debe pasar)
- [ ] T086 [US8] En `src/config/env.ts` (`botSchema`/`checkEnv`): aplicar `checkSecrets` solo con `NODE_ENV=production`, hacer `HEALTH_SECRET` obligatoria en producción y formatear cada incidencia como `- <VARIABLE>: <regla en español>`; en `src/startup.ts`, fuera de producción, registrar `weak_secrets` y seguir (T083 debe pasar; depende de T085)
- [ ] T087 [US8] En `src/provisioning/check.ts`: sustituir `quality()` y la parte de secretos de `reusedWithin()` por `checkSecrets` de `src/config/secret-rules.ts` (T085), **para los dos perfiles**: en `production` cada `SecretFinding` es un error (las mismas incidencias que el arranque); en `testing` es un aviso (como hoy, la instancia de pruebas no se bloquea). Mantener fuera de `checkSecrets` la regla de `OPERATOR_PASSWORD_HASH` (formato del hash, no fortaleza) como comprobación propia de la 007. Actualizar `tests/unit/provisioning/check.test.ts` y `src/provisioning/messages.ts` (T082 debe pasar; depende de T086)

**Checkpoint**: registros sin datos y arranque seguro en producción.

---

## Phase 8: User Story 5 - Los servicios externos lentos o caídos no bloquean la instancia (Priority: P3)

**Goal**: plazos en toda llamada a la Graph API y al SMTP; reintentos de lotes con espera creciente
y abandono con disculpa; todo efecto externo marcado antes de enviarse.

**Independent Test**: con la Graph API o el SMTP sin responder, cada llamada termina en su plazo; un
lote que falla siempre se reintenta a los 5 s, 30 s, 2 min y 10 min, se abandona al quinto con una
sola disculpa, y nada se envía dos veces.

### Tests for User Story 5 ⚠️

- [ ] T088 [P] [US5] Ampliar `tests/unit/channels/graph-client.test.ts` con un servidor que no responde: cada petición se aborta a los 10 s; `sendText` termina en ≤ 30 s contando reintentos (1 s, 4 s, 15 s mientras quepan) con `ChannelSendError`; `GET /{media-id}` a los 5 s; la descarga respeta la señal recibida por `fetchAudio(mediaId, maxBytes, { signal })`; la señal del llamador se combina con la propia
- [ ] T089 [P] [US5] Test de integración en `tests/integration/outbound-timeouts.test.ts` (SC-006): Graph API y SMTP (servidor TCP que acepta y no contesta) sin responder; ninguna llamada queda abierta más que su plazo, la vía email falla con `failure: 'timeout'` en 15 s y el procesador sigue atendiendo el chat web mientras tanto
- [ ] T090 [P] [US5] Test de integración con reloj falso en `tests/integration/processor-retries.test.ts`: un lote que falla siempre registra `batch_retry_scheduled { attempt, delayMs, errorClass }` con esperas 5 s, 30 s, 2 min y 10 min (no se reclama antes de `process_after`); al quinto fallo, R-ERR una sola vez cubriendo los pendientes y `batch_abandoned { attempts, apologySent }`; tras un éxito el contador vuelve a 0; un entrante nuevo durante la espera se une al lote y tras el abandono empieza otro; con la BD caída al escribir el intento, la espera en memoria evita reclamar en bucle
- [ ] T091 [P] [US5] Test de integración «como mucho una vez» en `tests/integration/handoff/at-most-once.test.ts`: fallo justo después de enviar la respuesta, el reenvío o el recordatorio → el reintento no repite nada; fallo tras avisar al negocio y antes de confirmar → el reintento envía solo la confirmación (`alerts_sent_at` puesto, `customer_notified_at` nulo); fallo antes de saber si salió la alerta (`alerts_sent_at` nulo con derivación activa) → fin `interrupted` y R-HANDOFF-FAIL con contacto; ninguna vía entrega → la derivación se borra

### Implementation for User Story 5

- [ ] T092 [P] [US5] Plazos en `src/channels/whatsapp/graph-client.ts`: `AbortSignal.timeout(10 s)` por petición combinado con `AbortSignal.any` con la del llamador; plazo total de 30 s en `sendText`; 5 s en los metadatos de un audio; `fetchAudio` recibe `{ signal }` (T088 debe pasar)
- [ ] T093 [US5] Ampliar los puertos de `src/conversation/ports.ts` (`MediaFetcher.fetchAudio(mediaId, maxBytes, { signal })`, `ChannelSender.sendText(to, body, { canRetry, signal? })`) y pasar la señal del plazo de la transcripción desde `src/conversation/transcription.ts`; actualizar los dobles de `tests/helpers/fakes.ts` (depende de T092)
- [ ] T094 [P] [US5] Fijar con un test unitario en `tests/unit/mail/smtp-mailer.test.ts` los plazos de `src/mail/smtp-mailer.ts` (`connectionTimeout 10 s`, `greetingTimeout 10 s`, `socketTimeout 14 s`), sin cambiar el código si ya cumplen
- [ ] T095 [US5] Esperas de reintento en `src/conversation/settings.ts` (`batchRetryDelaysMs: [5 000, 30 000, 120 000, 600 000]`, `batchMaxAttempts: 5`) y, en `src/conversation/processor.ts`, al lanzar `processConversation`: sumar intento y `setProcessAfter(ahora + espera)` (con espera en memoria si la escritura falla); al quinto, R-ERR una vez con el contacto del negocio o de emergencia cubriendo los pendientes y `resetBatch`; en éxito, `resetBatch` (T090 debe pasar; depende de T016)
- [ ] T096 [US5] Alerta de derivación «como mucho una vez» en `src/handoff/service.ts` y `src/conversation/processor.ts`: `start` guarda la derivación con `alerts_sent_at` y `customer_notified_at` nulos **antes** de avisar; tras avisar marca `alerts_sent_at` o borra la derivación si ninguna vía entregó; la transacción del saliente de confirmación marca `customer_notified_at`; en un reintento aplica la tabla de contracts/outbound-and-retries.md (fin con causa `interrupted` o solo la confirmación; la etiqueta de `interrupted` la pone T061a) (T091 debe pasar; depende de T058, T095)

**Checkpoint**: un proveedor caído o un lote defectuoso ya no bloquean la instancia ni duplican envíos.

---

## Phase 9: User Story 6 - Importar una configuración tiene un coste acotado (Priority: P3)

**Goal**: máximos por lista comprobados antes del esquema, como mucho 50 errores visibles, y coste
lineal en validación, vista previa y aplicación. El formato no cambia (no sube `formatVersion`).

**Independent Test**: fichero con 301 servicios → error «Hay 301 servicios; el máximo es 300» sin
aplicar nada; con 1 000 errores → 50 y «Y 950 errores más»; fichero en su máximo → validar +
previsualizar < 5 s.

### Tests for User Story 6 ⚠️

- [ ] T097 [P] [US6] Ampliar `tests/unit/config-transfer/parse.test.ts`: cada lista de contracts/config-import-limits.md con un elemento de más se rechaza con `reason: 'invalid'` y **solo** los errores de longitud, uno por lista, con su sección y elemento; en su máximo pasa; los máximos del panel más bajos mandan
- [ ] T098 [P] [US6] Ampliar `tests/unit/config-transfer/schema.test.ts` (o `tests/contract/admin/config-import.test.ts`): con más de 50 errores se muestran 50 en el orden del fichero y la línea «Y N errores más. Corrige estos y vuelve a importar.»; `config_import_rejected` guarda el total en `issues`
- [ ] T099 [P] [US6] Test de coste lineal en `tests/unit/config-transfer/linear-cost.test.ts`: duplicar el número de errores repetidos y de elementos no más que duplica (con margen) el tiempo de la eliminación de repetidos y de la ordenación por posición
- [ ] T100 [P] [US6] Ampliar `tests/integration/config-transfer/performance.test.ts` (SC-007): fichero de 5 MB con las listas en su máximo; validar + previsualizar < 5 s y aplicar en tiempo acotado

### Implementation for User Story 6

- [ ] T101 [US6] Comprobación previa de longitudes en `src/config-transfer/parse.ts` (recorrido sin validar el esquema completo) con la tabla de máximos en `src/config-transfer/schema.ts`; mensaje `Hay N <lista>; el máximo es M` (T097 debe pasar)
- [ ] T102 [US6] Coste lineal en `src/config-transfer/parse.ts`/`src/config-transfer/schema.ts`: eliminación de repetidos con `Set` de `ruta|mensaje`, orden en el fichero con posiciones de clave precalculadas por nodo (`Map`), y como mucho 50 errores con el recuento del resto en la vista de importación (T098 y T099 deben pasar)
- [ ] T103 [US6] Pertenencias con `Set` en lugar de `includes` dentro de bucles en `src/config-transfer/replace.ts` (T100 debe pasar)

**Checkpoint**: la importación no puede dejar ocupada la instancia.

---

## Phase 10: User Story 7 - El bot no muestra enlaces que no haya verificado (Priority: P3)

**Goal**: una sola regla de enlaces para verificador, chat web y «Probar el bot»; WhatsApp verifica
también dominios sueltos.

**Independent Test**: con la batería de enlaces, todo lo que el chat web o «Probar el bot» muestran
como enlace lo ha identificado antes el verificador; las direcciones no registradas se rechazan en
cualquier forma.

### Tests for User Story 7 ⚠️

- [ ] T104 [P] [US7] Ampliar `tests/unit/conversation/grounding.test.ts`: con `linkCandidates`, una dirección registrada vale por URL normalizada o por host + ruta; una no registrada se rechaza como dato no registrado en todas las formas de la batería de T002 (con y sin protocolo, `www.`, dominio suelto, `xhttps://…`)
- [ ] T105 [P] [US7] Ampliar `tests/unit/channels/message-links.test.ts` y `tests/unit/channels/web-assets.test.ts`: `message-links.ts` da exactamente `displayLinks`; `links.js` servido con la regla inyectada (marcador `/*__LINK_RULE__*/` sustituido) y ejecutado en `node:vm` da lo mismo que `displayLinks` para toda la batería (SC-008); un texto que no es candidato no se pinta como enlace

### Implementation for User Story 7

- [ ] T106 [US7] Usar `linkCandidates` en la categoría `url` de `src/conversation/grounding.ts`, con la comparación por URL normalizada o host + ruta (T104 debe pasar)
- [ ] T107 [US7] Usar `displayLinks` en `src/admin/message-links.ts` (quitar la expresión propia) (depende de T015)
- [ ] T108 [US7] Sustituir la expresión de `src/channels/web/assets/links.js` por el marcador `/*__LINK_RULE__*/` e inyectar `DISPLAY_LINK_RULE` al servir el fichero en `src/channels/web/routes.ts` (una vez al arrancar; misma caché y cabeceras que hoy) (T105 debe pasar; depende de T015)

**Checkpoint**: todas las historias completas.

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: comprobaciones transversales, copias y documentación de cierre.

- [ ] T109 [P] Ampliar `tests/integration/backup/backup-restore.test.ts`: una copia con filas en `transcription_price`, `whatsapp_usage_day`, `handoff_limits`, `handoff_day` y `model_usage.audio_ms` se restaura y verifica con los mismos datos, y la restauración reaplica `0008` comparando su hash
- [ ] T110 [P] Ampliar `tests/integration/config-transfer/round-trip.test.ts`: exportar e importar no incluye ni modifica topes, límites de derivación ni precios de transcripción (FR-036)
- [ ] T111 [P] Comprobar que `src/` no contiene nombres ni límites de un sector o cliente (FR-038) con la prueba existente de núcleo genérico, y añadir los ficheros nuevos a su recorrido si hace falta
- [ ] T112 Ejecutar `pnpm lint`, `pnpm typecheck` y `pnpm test` (unit, contract e integration) y corregir lo que falle
- [ ] T113 Recorrer [quickstart.md](quickstart.md) escenarios 1–8 a mano (incluido `NODE_ENV=production` con un secreto trivial, `pnpm instance:check .env`, el bucle de `curl` del frame y el registro del webhook) y anotar cualquier desviación
- [ ] T114 **Avisar antes al usuario** y actualizar `docs/operacion-multicliente.md`: tabla 9.1 (012 con fecha), orden de 9.2, P8 marcada como hecha, §4.1 (tope obligatorio en producción, tope diario de WhatsApp, precios de transcripción), §5 (antes de cada tanda: configurar el tope y pasar `instance:check` para rotar secretos débiles) y sección nueva de límites de derivación con su tabla de valores por defecto, mínimos y máximos
- [ ] T115 **Avisar antes al usuario** y actualizar `README.md` con el estado de la feature 012

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias.
- **Foundational (Phase 2)**: depende de Setup (T002 para T013); **bloquea todas las historias**.
- **User Stories (Phase 3–10)**: dependen de Foundational. Orden de prioridad: US1 → US2 → US3 →
  US4 → US8 → US5 → US6 → US7.
- **Polish (Phase 11)**: depende de las historias que se entreguen.

### User Story Dependencies

- **US1 (P1)**: solo Foundational. Es el MVP.
- **US2 (P1)**: Foundational (`link-rule.ts`, `process_after`). T062 amplía `protection.ts` de US1
  (T031): si US2 se hace antes que US1, T062 se pospone hasta T031.
- **US3 (P2)**: Foundational (`clientKey`). Independiente del resto.
- **US4 (P2)**: Foundational (`clientKey`). Independiente del resto.
- **US8 (P2)**: independiente del resto.
- **US5 (P3)**: Foundational (`process_after`); T096 depende de T058 (US2), porque ambos cambian
  `start` en `src/handoff/service.ts`.
- **US6 (P3)**: independiente del resto.
- **US7 (P3)**: Foundational (`link-rule.ts`). Independiente del resto.

### Ficheros compartidos (no paralelizar entre historias)

- `src/conversation/processor.ts`: T035, T036 (US1), T059 (US2), T095, T096 (US5).
- `src/handoff/service.ts`: T058–T061 (US2), T096 (US5).
- `src/admin/routes/usage.ts` y `src/admin/views/usage.eta`: T040 (US1), T063 (US2).
- `src/usage/protection.ts`: T031 (US1), T062 (US2).
- `src/channels/web/routes.ts`: T071, T072 (US3), T108 (US7).
- `src/app.ts`: T012, T038, T072, T084.

### Within Each User Story

- Los tests se escriben primero y deben fallar.
- Dominio (`protection.ts`, `limits.ts`, `customer-text.ts`, `link-rule.ts`) antes que procesador,
  servicios y rutas.
- Servicios antes que rutas y vistas del panel.

### Parallel Opportunities

- Setup: T001, T002 y T003 en paralelo.
- Foundational: tras T004/T005, T006–T011, T013 y T014 en paralelo.
- Dentro de cada historia, todos los tests marcados [P] en paralelo.
- Con Foundational terminado, US3, US4, US6, US7 y US8 pueden avanzar en paralelo con US1/US2 (no
  comparten ficheros salvo `src/app.ts` y `src/channels/web/routes.ts`, ver arriba).

---

## Parallel Example: User Story 1

```bash
# Tests de US1 a la vez:
Task: "Tabla de casos de protectionState en tests/unit/usage/protection.test.ts"
Task: "Coste por minuto y duración Ogg/Opus en tests/unit/usage/transcription-cost.test.ts"
Task: "Solo contacto por motivo en tests/integration/protection/contact-only.test.ts"
Task: "Audios bloqueados y consumo en tests/integration/protection/transcription.test.ts"
Task: "Tope diario de WhatsApp en tests/integration/protection/whatsapp-daily-cap.test.ts"
Task: "Banda común en tests/contract/admin/protection-banner.test.ts"

# Dominio de US1 a la vez:
Task: "src/usage/transcription-cost.ts"
Task: "Esquemas nuevos en src/usage/schemas.ts"
```

## Parallel Example: User Story 2

```bash
Task: "customerQuote en tests/unit/handoff/customer-text.test.ts"
Task: "Reserva atómica en tests/integration/handoff/limits.test.ts"
Task: "Reenvío agrupado en tests/integration/handoff/grouped-forward.test.ts"
Task: "src/handoff/customer-text.ts"
Task: "src/handoff/limits.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1 (Setup) y Phase 2 (Foundational).
2. Phase 3 (US1): el gasto en producción queda acotado y falla cerrado.
3. **Parar y validar**: quickstart, escenarios 1 y 2.

### Incremental Delivery

1. Setup + Foundational.
2. US1 → validar (MVP).
3. US2 → validar: los dos vectores de gasto sin credenciales cerrados.
4. US3, US4, US8 → validar: saturación, acceso del operador y arranque seguro.
5. US5, US6, US7 → validar: proveedores lentos, importación y enlaces.
6. Polish: copias, documentación y README (avisando antes al usuario).

La instancia solo es **apta para producción** con todas las historias hechas: la feature cierra
los bloqueantes de la auditoría del 2026-10-05 en su conjunto.

---

## Notes

- [P] = ficheros distintos y sin dependencias pendientes.
- [Story] enlaza cada tarea con su historia para la trazabilidad.
- Comprobar que los tests fallan antes de implementar.
- Commit tras cada tarea o grupo lógico.
- Evitar: tareas vagas, conflictos en el mismo fichero y dependencias entre historias que rompan su
  independencia.
