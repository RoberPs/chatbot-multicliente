---

description: "Lista de tareas de la feature 010: consumo y coste por instancia"
---

# Tasks: Consumo y coste por instancia

**Input**: documentos de diseño de `/specs/010-usage-cost-cap/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Ámbito**: Núcleo

**Tests**: sí. El plan (§ Technical Context → Testing) pide pruebas unitarias, de contrato e
integración, y la constitución exige pruebas de integración para los Principios IV y V (ruta con el
tope alcanzado). Las pruebas de cada historia se escriben antes de su implementación y deben fallar
primero.

**Organización**: por historia de usuario (US1 medir, US2 ver, US3 limitar), cada una probable por
separado.

## Formato: `[ID] [P?] [Story] Descripción`

- **[P]**: se puede hacer en paralelo (ficheros distintos, sin dependencias pendientes)
- **[Story]**: historia a la que pertenece (US1, US2, US3)

## Convenciones de rutas

Monolito modular: `src/` y `tests/` en la raíz. Dominio nuevo en `src/usage` (sin HTTP); rutas del
panel en `src/admin`. Textos, comentarios y mensajes en español. Nada de sectores ni clientes en
`src/`.

---

## Phase 1: Setup (infraestructura compartida)

**Purpose**: esquema de BD y utilidades de fecha compartidas.

- [ ] T001 Mover `localDay` y `localMonthRange` de `src/webchat/usage.ts` a `src/knowledge/time/local-date.ts` (mismas firmas), reexportarlas o actualizar los imports en `src/webchat/usage.ts` y sus usuarios, y mover sus pruebas de `tests/unit/webchat/usage.test.ts` a `tests/unit/time/local-date.test.ts` (research R6)
- [ ] T002 Añadir a `src/db/schema.ts` el enum `usage_purpose` (`reply`, `handoff_summary`) y las tablas `model_usage`, `model_price` y `usage_settings` con columnas, `check` (no negativos, `calls >= 1`, `(cost_pico is null) = (currency is null)`, `id = 1`, `not cap_enabled or monthly_cap_cents > 0`) e índice `model_usage_day_idx (day)` según [data-model.md](data-model.md) §1; `model_usage.channel` reutiliza el enum `customer_channel`
- [ ] T003 Generar `src/db/migrations/0006_usage.sql` con `pnpm db:generate` (y su entrada en `src/db/migrations/meta/`), añadiendo a mano el `insert into usage_settings (id) values (1)`; comprobar que no edita migraciones publicadas y que `0006_usage` es el esquema esperado por `src/health/version.ts` (o lo que fije el índice/etiqueta esperados en la 009)

---

## Phase 2: Foundational (prerrequisitos bloqueantes)

**Purpose**: tipos, unidades y dobles de prueba que usan las tres historias.

**⚠️ CRITICAL**: ninguna historia empieza antes de terminar esta fase.

- [ ] T004 [P] Crear `src/usage/types.ts` con `TokenUsage`, `ResponseUsage`, `UsagePurpose`, `UsageRecordInput`, `ModelPrice`, `UsageSettings`, `SpendCapLevel`, `SpendCapState`, `UsageRow` y `UsageSummary` ([data-model.md](data-model.md) §2), y una función `addTokenUsage(a, b)`
- [ ] T005 [P] Escribir `tests/unit/usage/money.test.ts`: `costPico` exacto en enteros (`bigint`) con los cuatro tipos de token; decimal → millonésimas (hasta 6 decimales, 3,75 → 3 750 000; rechaza 7 decimales, negativos y > 1 000 000); decimal → céntimos (hasta 2 decimales, > 0, ≤ 10 000 000); formato de billonésimas con 4 decimales y redondeo a la mitad hacia arriba (incluido un coste de una respuesta que no queda en 0,0000 cuando corresponde); umbrales `reached`/`warning` y porcentaje `floor` en los bordes exactos de 80 % y 100 % y por encima de 100 % (research R4)
- [ ] T006 Implementar `src/usage/money.ts`: `costPico(tokens, price)`, `parseMicrosPerMtok`, `parseCapCents`, `formatPico(pico, decimals = 4)`, `formatMicros`, `formatCents`, `capLevel(spentPico, capCents, enabled)` y `capPercent(spentPico, capCents)` sin coma flotante (pasa T005)
- [ ] T007 [P] Añadir a `BotEvent` en `src/conversation/activity-log.ts` los eventos `usage_record_failed { purpose }` y `spend_cap_reached { month }`, y `spend_cap` como valor de `handoff_summary_fallback.reason`, con sus niveles (`error`, `warn`) según [contracts/usage-recording.md](contracts/usage-recording.md) y [contracts/spend-cap-conversation.md](contracts/spend-cap-conversation.md); ampliar `tests/unit/conversation/activity-log.test.ts` para fijar que no llevan importes ni textos
- [ ] T008 [P] Ampliar los dobles en `tests/helpers/fakes.ts`: `FakeChatModel` y `FakeSummarizer` aceptan en cada paso un `usage?: TokenUsage` que entregan por `opts.onUsage` (también en pasos que fallan tras "recibir respuesta"), y cuentan las llamadas; añadir `RecordingUsageMeter` (y una variante que lanza) para pruebas sin BD
- [ ] T009 [P] Escribir `tests/integration/conversation/migration-0006.test.ts` (como `migration-0002.test.ts`): la migración aplica sobre una BD con datos de la 0005, crea la fila 1 de `usage_settings` con `USD` y tope desactivado, y las restricciones rechazan negativos, `calls = 0`, coste sin moneda y tope activo sin importe

**Checkpoint**: esquema, tipos, unidades y dobles listos.

---

## Phase 3: User Story 1 - Cada llamada al modelo queda registrada sin textos (Priority: P1) 🎯 MVP

**Goal**: cada respuesta con modelo y cada resumen de derivación deja un registro en `model_usage`
con canal, uso, modelo, llamadas, tokens y coste congelado (o «sin precio»), sin datos personales, y
sin retrasar ni impedir la respuesta.

**Independent Test**: enviar mensajes por WhatsApp, chat web y "Probar el bot" (y una derivación con
resumen) y comprobar un registro por respuesta con los tokens del doble del modelo, el reintento
sumado y ninguna columna con textos o identificadores.

### Tests for User Story 1 ⚠️

- [ ] T010 [P] [US1] Ampliar `tests/unit/llm/anthropic-chat-model.test.ts`: `onUsage` se llama una vez con `response.usage` mapeado (`cache_*` nulos → 0) en respuesta válida; una vez y **antes** de lanzar con `refusal`, `max_tokens`, JSON o esquema no válidos; nunca con error HTTP, corte, plazo agotado o abortado ([contracts/usage-recording.md](contracts/usage-recording.md))
- [ ] T011 [P] [US1] Crear `tests/unit/llm/anthropic-summarizer.test.ts` con los mismos casos de `onUsage` para el resumidor
- [ ] T012 [P] [US1] Ampliar `tests/unit/conversation/responder-compose.test.ts` (o crear `tests/unit/conversation/responder-usage.test.ts`): una respuesta con reintento del verificador devuelve `response.usage` con `calls = 2` y los tokens sumados; un intento que no informa tokens no cuenta; sin tokens en ningún intento, `usage` es `undefined`; `R-SAFE`/`R-ERR` tras llamadas con tokens conservan `usage`
- [ ] T013 [P] [US1] Crear `tests/unit/usage/model-usage-columns.test.ts`: recorre las columnas de `model_usage` en `src/db/schema.ts` y falla si aparece alguna fuera de la lista permitida (`id`, `at`, `day`, `channel`, `purpose`, `model`, `calls`, cuatro de tokens, `cost_pico`, `currency`) y comprueba que no tiene claves ajenas (FR-003)
- [ ] T014 [P] [US1] Crear `tests/integration/usage/meter.test.ts`: `UsageMeter.record` inserta con el precio vigente (coste = `costPico`, moneda de `usage_settings`) o con `cost_pico`/`currency` nulos sin precio; cambiar el precio después no altera filas anteriores ni las «sin precio» (FR-011, FR-012); `day` es el día local de la zona dada cerca de medianoche; si la inserción falla no lanza y registra `usage_record_failed`
- [ ] T015 [P] [US1] Crear `tests/integration/usage/recording.test.ts`: un registro `reply` por respuesta en WhatsApp, web y playground con el canal correcto, el modelo de la configuración y los tokens del doble; el reintento del verificador queda en un solo registro con `calls = 2`; ningún registro para `R-MEDIA`, `R-LIMIT`, `R-UNAVAILABLE`, fuera de horario ni reenvíos de una derivación activa; llamada fallida que informó tokens sí registra, sin tokens no; con el meter que falla la respuesta se entrega igual (FR-001 – FR-005, SC-001)
- [ ] T016 [P] [US1] Crear `tests/integration/usage/handoff-summary.test.ts`: una derivación con resumen del modelo deja un registro `handoff_summary` en el canal de la conversación (WhatsApp y playground); si el resumen falla tras informar tokens, se registran y el aviso lleva el extracto literal (US1-4)
- [ ] T017 [P] [US1] Crear `tests/integration/usage/retention.test.ts`: con reloj falso en la zona del negocio, la pasada de retención borra los registros con `day` anterior al primer día del mes local de hace 12 meses y conserva ese mes, los 11 siguientes y el actual; sin negocio usa UTC; no toca `model_price` ni `usage_settings` (FR-006, R14)

### Implementation for User Story 1

- [ ] T018 [P] [US1] Añadir `onUsage?: (u: TokenUsage) => void` a las opciones de `ChatModel.reply` en `src/conversation/ports.ts` y de `HandoffSummarizer.summarize` en `src/handoff/ports.ts`
- [ ] T019 [P] [US1] En `src/llm/anthropic-chat-model.ts`, llamar a `opts.onUsage` con `response.usage` mapeado a `TokenUsage` en cuanto hay respuesta del proveedor, antes de cualquier descarte que lance `ChatModelError` (pasa T010)
- [ ] T020 [P] [US1] Lo mismo en `src/llm/anthropic-summarizer.ts` (pasa T011)
- [ ] T021 [US1] En `src/conversation/responder.ts`, acumular el `TokenUsage` de cada intento con `addTokenUsage` y devolver `usage?: ResponseUsage` en `Response` (tipo en `src/conversation/types.ts`) (pasa T012)
- [ ] T022 [US1] Crear `src/usage/meter.ts` con `createUsageMeter({ db, activityLog })`: `record(input)` hace un único `INSERT … SELECT` desde `usage_settings` con `left join model_price` (research R5), calcula `day` con `localDay` de `src/knowledge/time/local-date.ts`, y nunca lanza (try/catch → `usage_record_failed { purpose }`)
- [ ] T023 [US1] Crear `src/usage/retention.ts` con `purgeModelUsage(tx, now, timezone)` y llamarla desde la pasada horaria de `src/conversation/retention.ts` con la zona de `business` (UTC si no hay negocio) (pasa T017)
- [ ] T024 [US1] En `src/conversation/processor.ts`, aceptar un `usageMeter?: UsageMeter` y, cuando `response.usage` existe, llamar a `usageMeter.record({ channel, purpose: 'reply', model, usage, at, timezone })` justo después de `responder.respond` y antes de `deliver`, fuera de la transacción del saliente (research R3)
- [ ] T025 [US1] En `src/handoff/summary.ts` y `src/handoff/service.ts`, recoger el uso del resumen por `onUsage` y registrarlo con `purpose: 'handoff_summary'` y el canal de la conversación tras `summarizeHandoff` (`HandoffService` recibe `usageMeter?` y el modelo)
- [ ] T026 [US1] Componer en `src/bot.ts` un `UsageMeter` y pasarlo al procesador y a `createHandoffService` junto con `LLM_MODEL`; `src/cli/bot-chat.ts` y el eval no lo pasan
- [ ] T027 [US1] Pasar el `UsageMeter` (o permitir uno de prueba) en `createTestBot` de `tests/helpers/bot.ts` para que T015 y T016 pasen

**Checkpoint**: US1 completa; `select * from model_usage` muestra el consumo real por canal.

---

## Phase 4: User Story 2 - El operador ve el consumo y el coste en el panel (Priority: P2)

**Goal**: pantalla `/admin/usage` con hoy, mes en curso y meses conservados por canal y por día,
tabla de precios por modelo y moneda de coste.

**Independent Test**: con registros conocidos de varios canales, días y precios, abrir la pantalla y
comprobar que totales y costes coinciden exactamente con el cálculo a mano.

### Tests for User Story 2 ⚠️

- [ ] T028 [P] [US2] Crear `tests/unit/usage/schemas.test.ts`: esquema de precio (modelo 1–200 tras recortar, cuatro decimales ≥ 0 con hasta 6 decimales y ≤ 1 000 000 → millonésimas) y de moneda (3 letras ISO 4217 en mayúsculas) con errores por campo ([data-model.md](data-model.md) §4)
- [ ] T029 [P] [US2] Crear `tests/integration/usage/summary.test.ts`: con registros sembrados en WhatsApp, web y playground, `reply` y `handoff_summary`, con y sin precio y en dos monedas, el resumen del día y del mes da por canal, «Clientes finales» e «Instancia» las respuestas, resúmenes, tokens y coste exactos (sumados antes de redondear, SC-002), lista los modelos sin precio y separa el coste por moneda; los límites de día y mes son los de la zona del negocio (`Pacific/Auckland` frente a servidor en UTC, US2-6); `?month` devuelve el desglose por día; los meses conservados con consumo se listan (FR-009)
- [ ] T030 [P] [US2] Crear `tests/contract/admin/usage.test.ts` (`fastify.inject`): sin sesión redirige al login; `GET /admin/usage` muestra el aviso de estimación, las tablas de hoy y del mes con canales sin consumo a cero, «sin precio» (nunca 0) y el aviso que nombra el modelo, el modelo actual marcado y el botón para añadir su precio; `?month=AAAA-MM` válido muestra el mes y por día; mes mal formado o no conservado → 200 con el mes en curso y "Mes no disponible"; `POST /admin/usage/prices` sin CSRF → 403, con errores → 422 por campo, válido → 303 "Guardado"; `POST /admin/usage/prices/delete` → 303 o 404; `POST /admin/usage/settings` cambiando la moneda con precios → 422 con "Para cambiar la moneda, borra antes los precios: están en {moneda}."; sin `ANTHROPIC_API_KEY`, "Esta instancia no tiene bot: no hay consumo." con precios editables; la página no muestra identificadores de conversación ni de cliente ([contracts/admin-usage-screen.md](contracts/admin-usage-screen.md))
- [ ] T031 [P] [US2] Crear `tests/unit/config-transfer/usage-tables.test.ts`: `model_usage`, `model_price` y `usage_settings` no están en las tablas del formato de la 008, la exportación no contiene precios, moneda ni tope, y `formatVersion` no cambia (FR-024, R15)

### Implementation for User Story 2

- [ ] T032 [P] [US2] Crear `src/usage/schemas.ts` con los esquemas Zod de precio y de moneda que convierten a millonésimas con `parseMicrosPerMtok` (pasa T028)
- [ ] T033 [US2] Crear `src/usage/settings.ts`: `readUsageSettings`, `listPrices`, `upsertPrice`, `deletePrice` y `saveCurrency` (rechaza cambiar la moneda si hay precios), cada escritura en su transacción y con `updated_at`
- [ ] T034 [US2] Crear `src/usage/summary.ts`: `summarizePeriod(tx, { first, last })` (agrupa por `channel` y `purpose`; `customers` y `instance`; coste por moneda; `unpricedModels`), `summarizeDays(tx, month)` y `retainedMonths(tx, now, timezone)`; consultas por `day` con `localDay`/`localMonthRange` (pasa T029)
- [ ] T035 [P] [US2] Crear `src/admin/views/partials/usage-table.eta` (filas WhatsApp, Chat web, Probar el bot, Clientes finales, Instancia; columnas de respuestas, resúmenes, cuatro tipos de token y coste con `formatPico`; «sin precio» y «(hay consumo sin precio)»)
- [ ] T036 [US2] Crear `src/admin/views/usage.eta`: aviso de estimación, Hoy, Este mes, aviso de modelos sin precio, tabla de precios editable en la moneda de coste con el modelo actual marcado, formulario de moneda, selector de meses conservados y vista `?month` por canal y por día; estado "sin bot"
- [ ] T037 [US2] Crear `src/admin/routes/usage.ts` con `GET /admin/usage`, `POST /admin/usage/prices`, `POST /admin/usage/prices/delete` y `POST /admin/usage/settings` (moneda) usando `submitForm`/`formErrorResponse` y CSRF como el resto del panel; registrarla en `src/admin/routes/index.ts` (pasa T030)
- [ ] T038 [US2] Añadir la entrada **Consumo** (`/admin/usage`) tras "Chat web" en la navegación de `src/admin/views/layout.eta`

**Checkpoint**: US1 y US2 funcionan; el operador puede facturar el consumo del mes.

---

## Phase 5: User Story 3 - Tope mensual de gasto para toda la instancia (Priority: P3)

**Goal**: tope mensual común a todos los canales; al alcanzarlo, WhatsApp responde `R-CAP` con
contacto sin modelo (derivación incluida), el chat web pasa a "no disponible", el panel avisa en
todas las pantallas y `/health` e `instance:versions` informan del estado.

**Independent Test**: fijar un tope bajo, consumir hasta pasarlo y comprobar que WhatsApp y web
responden con contacto sin llamar al modelo, que una petición de persona se deriva sin resumen del
modelo y que al subir el tope (o cambiar de mes) el siguiente mensaje vuelve al modelo.

### Tests for User Story 3 ⚠️

- [ ] T039 [P] [US3] Ampliar `tests/unit/usage/schemas.test.ts` con el esquema de ajustes del tope: `capEnabled` exige `monthlyCap` > 0 con hasta 2 decimales y ≤ 10 000 000 → céntimos; desactivar conserva el importe
- [ ] T040 [P] [US3] Ampliar `tests/unit/conversation/templates.test.ts` y `tests/unit/conversation/reply-trace.test.ts`: `R-CAP` = `unavailableReply(forma)` + contacto del negocio, o el de emergencia si no tiene, sin saludo, `contact.reason = 'template'`; y `tests/unit/handoff/decision.test.ts`: con la salida sintética de `R-CAP` y `handoffDetected` del detector, `handoffTurn` pide datos o inicia la derivación con vías y deja `R-CAP` sin vías ni petición ([contracts/spend-cap-conversation.md](contracts/spend-cap-conversation.md))
- [ ] T041 [P] [US3] Ampliar `tests/unit/conversation/channels.test.ts`: `ChannelPolicy.spendCap` es `true` en WhatsApp y web y `false` en playground
- [ ] T042 [P] [US3] Ampliar `tests/unit/provisioning/versions.test.ts`: columna **Tope** al final con `sin tope`, `normal`, `≥80 %`, `alcanzado` y `—` (nulo, ausente o desconocido); `spendCap` en `--json`; el tope no cambia la clasificación de la fila, el código de salida ni `--annotate` ([contracts/health-spend-cap.md](contracts/health-spend-cap.md))
- [ ] T043 [P] [US3] Ampliar `tests/unit/health/report.test.ts`: `spendCap` solo en la vista completa, `null` si el sondeo no lo pudo leer o el esquema no es el esperado, y `status` no cambia por el tope
- [ ] T044 [P] [US3] Crear `tests/integration/usage/spend-cap-state.test.ts`: `spendCapState` en una sola consulta da `none`/`normal`/`warning`/`reached` en los bordes, suma playground y resúmenes, ignora registros sin precio y los de otra moneda, y usa el mes local; `markNotified` devuelve `true` una sola vez por mes aunque se llame en paralelo (R7, R10)
- [ ] T045 [P] [US3] Crear `tests/integration/usage/cap-whatsapp.test.ts`: con el tope alcanzado, 0 llamadas al doble del modelo; la respuesta es `R-CAP` con contacto (y el de emergencia si el negocio no tiene), `reply_sent { template: 'R-CAP' }` y ningún registro de consumo nuevo; "quiero hablar con una persona" con vías inicia la derivación y el aviso al negocio lleva el extracto literal con `handoff_summary_fallback { reason: 'spend_cap' }` y 0 llamadas al resumidor; sin vías, `R-CAP`; un único `spend_cap_reached { month }` en el mes (US3-2, US3-4, US3-5, US3-10, SC-004)
- [ ] T046 [P] [US3] Crear `tests/integration/usage/cap-web.test.ts`: con solo el tope de gasto alcanzado, la recepción descarta con `message_discarded { reason: 'spend_cap' }`, los mensajes ya aceptados reciben `R-UNAVAILABLE` sin modelo y `webChatAvailability` devuelve `reason: 'quota'` con el contacto de la 004; con los dos topes a la vez, el mismo estado (FR-017)
- [ ] T047 [P] [US3] Crear `tests/integration/usage/cap-resume.test.ts`: con el tope alcanzado, subir el tope por encima del gasto o desactivarlo hace que el siguiente mensaje llame al modelo; con reloj falso en la zona del negocio, el primer mensaje del mes siguiente también, y el evento puede volver a emitirse ese mes; "Probar el bot" sigue llamando al modelo y su consumo suma (US3-7, US3-8, US3-9, SC-005)
- [ ] T048 [P] [US3] Crear `tests/integration/usage/cap-concurrency.test.ts`: varias respuestas simultáneas cerca del tope (con `processorConcurrency` > 1) terminan y se registran, y el exceso queda acotado a las que estaban en curso (SC-007)
- [ ] T049 [P] [US3] Crear `tests/contract/admin/spend-banner.test.ts`: en varias pantallas del panel (inicio, negocio, servicios, consumo, probar el bot) aparece un solo aviso, el más grave: `reached` ("Tope de gasto alcanzado ({p} %)…"), tope activo con `LLM_MODEL` sin precio ("El modelo «{m}» no tiene precio…") o `warning` ("Gasto del mes al {p} % del tope."); no cambia el contador de `computeWarnings` ni impide activar el negocio; si la consulta falla, la página se sirve sin aviso; "Probar el bot" muestra el recordatorio con `reached` (FR-019 – FR-021)
- [ ] T050 [P] [US3] Ampliar `tests/contract/admin/usage.test.ts`: `POST /admin/usage/settings` activando el tope sin precio de `LLM_MODEL` → 422 con "No se puede activar el tope: el modelo «{LLM_MODEL}» no tiene precio."; tope 0 → 422; con precio → 303; un tope menor que el gasto se acepta; la pantalla muestra estado, gasto, tope y porcentaje; borrar el precio del modelo actual con el tope activo se permite (FR-013, FR-014)
- [ ] T051 [P] [US3] Ampliar `tests/contract/health.test.ts`: sin credencial la respuesta sigue siendo solo `{status}`; con `Authorization: Bearer` incluye `spendCap` sin importes, precios ni moneda (US3-12, FR-023a)
- [ ] T052 [P] [US3] Ampliar `tests/contract/web-chat-limits.test.ts`: la API del chat web y `GET /chat/...` (frame) devuelven el estado "no disponible" con `reason: 'quota'` y contacto cuando solo está alcanzado el tope de gasto

### Implementation for User Story 3

- [ ] T053 [US3] Crear `src/usage/spend-cap.ts` con `spendCapState(tx, now, timezone)` (una consulta: ajustes + `sum(cost_pico) filter (where currency = s.currency)` del mes local, nivel con `capLevel`) y `markNotified(tx, monthFirstDay)` (`UPDATE … WHERE cap_notified_month IS DISTINCT FROM $mes RETURNING 1`) (pasa T044)
- [ ] T054 [US3] Ampliar `src/usage/schemas.ts` y `src/usage/settings.ts` con el esquema y el guardado de `capEnabled`/`monthlyCap` en transacción; activar exige fila en `model_price` para el modelo actual (error de campo que lo nombra) (pasa T039)
- [ ] T055 [P] [US3] Añadir `spendCap: boolean` a `ChannelPolicy` en `src/conversation/channels.ts` (WhatsApp y web `true`, playground `false`) (pasa T041)
- [ ] T056 [P] [US3] Añadir `R-CAP` a `REPLY_TEMPLATES` en `src/conversation/types.ts` y su composición (`capResponse`: `unavailableReply` + `contactBlock` o contacto de emergencia, sin saludo) en `src/conversation/templates.ts` y `src/conversation/responder.ts` (pasa T040)
- [ ] T057 [US3] Añadir `modelSummary: boolean` a la entrada de `HandoffService.start` en `src/handoff/service.ts`: con `false`, usar `fallbackSummary` sin llamar al resumidor ni registrar consumo y emitir `handoff_summary_fallback { reason: 'spend_cap' }`; los llamantes actuales pasan `true`
- [ ] T058 [US3] En `src/conversation/processor.ts`, para canales con `policy.spendCap`, comprobar `spendCapState` antes de llamar al modelo (tras el tope de respuestas de la 004): con `reached`, emitir `spend_cap_reached` si `markNotified` lo concede; en web responder `R-UNAVAILABLE`; en WhatsApp construir `R-CAP` con la salida sintética y `handoffDetected` del detector determinista, decidir con `handoffTurn` e iniciar la derivación con `modelSummary: false` (pasa T045, T047, T048)
- [ ] T059 [US3] Añadir `spend_cap` a `DiscardReason` y comprobar el tope de gasto en `src/conversation/intake.ts` para web (`policy.spendCap && policy.usageCap`) tras el tope de respuestas; en `src/webchat/availability.ts`, tope de gasto alcanzado → `no('quota', snapshot)` (pasa T046, T052)
- [ ] T060 [US3] Completar `src/admin/views/usage.eta` y `src/admin/routes/usage.ts` con la sección **Tope mensual** (estado, gasto, tope, porcentaje y formulario `capEnabled`/`monthlyCap`) (pasa T050)
- [ ] T061 [US3] En `src/admin/render.ts`, calcular en `renderPage` `layout.spend` (nivel, porcentaje y "¿`LLM_MODEL` tiene precio?") con `spendCapState`, tolerando errores; crear `src/admin/views/partials/spend-banner.eta` con el aviso más grave e incluirlo en `src/admin/views/layout.eta`, fuera de `computeWarnings`
- [ ] T062 [US3] En `src/admin/routes/playground.ts` y `src/admin/views/playground.eta`, mostrar con `reached` el recordatorio "Los clientes finales están recibiendo solo el contacto del negocio…" (pasa T049)
- [ ] T063 [US3] En `src/health/report.ts`, ampliar el sondeo de la 009 para leer `spendCapState` con la zona de `business` solo si el esquema aplicado es el esperado, dentro del mismo `READ ONLY` y tope de 2 s, y añadir `spendCap` solo a la vista completa sin tocar `status` (pasa T043, T051)
- [ ] T064 [US3] En `src/provisioning/versions.ts`, leer `spendCap` del informe (valor desconocido → `null`), añadir la columna **Tope** y el campo en `--json`, sin que intervenga en la clasificación, el código de salida ni `--annotate` (pasa T042)

**Checkpoint**: las tres historias funcionan; el tope protege el gasto con salida a una persona.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: rendimiento, copias, neutralidad y documentación.

- [ ] T065 [P] Ampliar `tests/integration/performance.test.ts`: mediana del tiempo de respuesta con y sin medición (consulta del tope + inserción), diferencia < 100 ms (SC-006); y la consulta de `/admin/usage` con 50 000 registros en el mes responde en < 500 ms
- [ ] T066 [P] Ampliar `tests/integration/backup/backup-restore.test.ts` (o `verify.test.ts`): tras copiar y restaurar, `model_usage`, `model_price` y `usage_settings` vuelven y el gasto del mes es el de los registros restaurados; `0006_usage` se reaplica con su hash (FR-025)
- [ ] T067 [P] Comprobar que `tests/integration/sector-neutrality.test.ts` sigue pasando con `src/usage` y que el núcleo no trae precios ni topes de ningún cliente (FR-026)
- [ ] T068 Ejecutar `pnpm lint && pnpm typecheck && pnpm test` y corregir lo que falle
- [ ] T069 Validar a mano [quickstart.md](quickstart.md) §2–§6 (panel, precios, tope, `/health`, `instance:versions`, exportación y copia) y anotar el resultado
- [ ] T070 Avisar al usuario y actualizar `README.md` con el estado de la feature 010
- [ ] T071 Actualizar `docs/operacion-multicliente.md`: tabla 9.1 con la 010 y su fecha, orden de 9.2, P4 marcada como hecha, y las secciones de operación del panel (pantalla Consumo, precios y tope) y de la consulta del parque (columna Tope)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias. T002 → T003.
- **Foundational (Phase 2)**: depende de Setup; bloquea las historias. T005 → T006.
- **US1 (Phase 3)**: tras Foundational. Es la base de US2 y US3 (sin registros no hay coste ni tope).
- **US2 (Phase 4)**: tras Foundational; sus pruebas siembran registros directamente, así que puede
  avanzar en paralelo con US1, pero solo aporta valor real con US1 hecha.
- **US3 (Phase 5)**: tras Foundational; T058 se apoya en T024 (procesador de US1) y T060 en T036/T037
  (pantalla de US2).
- **Polish (Phase 6)**: tras las historias que se quieran entregar.

### User Story Dependencies

- **US1 (P1)**: independiente.
- **US2 (P2)**: lee `model_usage`; se prueba con registros sembrados, independiente de US1 en tests.
- **US3 (P3)**: el gasto sale de `model_usage` (US1); la sección del tope se añade a la pantalla de
  US2. La cadena de conversación con tope se prueba con registros sembrados.

### Within Each User Story

- Pruebas primero, fallando.
- Puertos y adaptadores → responder → meter → procesador/derivación → composición (US1).
- Esquemas → settings/summary → vistas → rutas (US2).
- Estado del tope → cadena de conversación → panel → salud y parque (US3).

### Parallel Opportunities

- Fase 2: T004, T007, T008, T009 en paralelo; T005 en paralelo con ellos.
- US1: pruebas T010–T017 en paralelo; T018, T019, T020 en paralelo.
- US2: pruebas T028–T031 en paralelo; T032 y T035 en paralelo.
- US3: pruebas T039–T052 en paralelo; T055 y T056 en paralelo; T063 y T064 en paralelo con T060–T062.
- Polish: T065, T066, T067 en paralelo.

---

## Parallel Example: User Story 1

```bash
# Pruebas de US1 a la vez:
Task: "onUsage del adaptador en tests/unit/llm/anthropic-chat-model.test.ts"
Task: "onUsage del resumidor en tests/unit/llm/anthropic-summarizer.test.ts"
Task: "lista cerrada de columnas en tests/unit/usage/model-usage-columns.test.ts"
Task: "registro por canal en tests/integration/usage/recording.test.ts"

# Adaptadores a la vez:
Task: "onUsage en src/llm/anthropic-chat-model.ts"
Task: "onUsage en src/llm/anthropic-summarizer.ts"
```

## Parallel Example: User Story 3

```bash
Task: "R-CAP en tests/unit/conversation/templates.test.ts"
Task: "columna Tope en tests/unit/provisioning/versions.test.ts"
Task: "tope en WhatsApp en tests/integration/usage/cap-whatsapp.test.ts"
Task: "tope en web en tests/integration/usage/cap-web.test.ts"
Task: "aviso del layout en tests/contract/admin/spend-banner.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Fase 1 y Fase 2.
2. Fase 3 (US1).
3. **Parar y validar**: quickstart §2; `model_usage` tiene el consumo real sin textos.
4. Ya se puede facturar consultando la BD.

### Incremental Delivery

1. Setup + Foundational → base lista.
2. US1 → medir (MVP).
3. US2 → ver y valorar en el panel.
4. US3 → limitar el gasto con salida a una persona.
5. Polish → rendimiento, copias, README y docs.

---

## Notes

- [P] = ficheros distintos y sin dependencias pendientes.
- Migración de solo añadir; `0006_usage` no se edita una vez publicada.
- Las tablas nuevas no son configuración del negocio: no suben `formatVersion` (R15, fijado por T031).
- Ningún registro, evento ni salida de salud lleva textos, identificadores personales ni importes
  fuera del panel.
- Commit tras cada tarea o grupo lógico.
