---

description: "Lista de tareas de la feature 004: canal web del bot de atención"
---

# Tasks: Canal web del bot de atención

**Input**: documentos de diseño de `/specs/004-web-channel/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Ámbito**: Núcleo

**Tests**: se incluyen. El plan fija las suites `unit`, `contract`, `integration` y `eval`, y la
constitución exige pruebas de los Principios IV y V (paridad entre canales y contacto en todos
los caminos de "no disponible") antes de cerrar la feature. Los tests de cada historia se
escriben primero y deben fallar antes de implementar.

**Organization**: por historia de usuario. La generalización del núcleo a varios canales
([contracts/conversation-channels.md](contracts/conversation-channels.md)) es la fase
fundacional: la necesitan las cuatro historias y debe dejar WhatsApp exactamente igual
(FR-004, SC-001) antes de empezar ninguna.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede hacer en paralelo (ficheros distintos, sin dependencias pendientes)
- **[Story]**: historia a la que pertenece (US1…US4)
- Rutas desde la raíz del repositorio (proyecto único: `src/`, `tests/`)

## Reglas que aplican a todas las tareas

- En `src/` no puede haber nombres ni lógica de sector o cliente (test
  `tests/unit/sector-neutrality.test.ts`, que también recorre `src/webchat`, `src/channels/web`
  y sus assets); los ejemplos sectoriales solo en `tests/fixtures/`.
- `src/conversation` y `src/webchat` no importan Fastify ni hacen `fetch`: lo que conoce HTTP,
  cabeceras o el navegador vive en `src/channels/web` y `src/admin`.
- Ninguna regla de respuesta depende del canal: las diferencias van solo en la tabla de
  `ChannelPolicy` (FR-002, R1). Nada de `if (channel === 'web')` en el responder.
- Contenido del visitante y del bot siempre como texto: en los assets del chat, solo
  `textContent`; nunca `innerHTML`, `outerHTML`, `insertAdjacentHTML` ni `document.write`.
- La IP no se guarda en la BD ni aparece en los registros (FR-029, SC-008). Ningún registro
  contiene texto de mensajes, teléfonos, tokens ni `channel_user_id` en claro
  ([contracts/activity-log.md](contracts/activity-log.md)).
- Configuración del chat y snapshot leídos sin caché en cada petición. Días y meses de los
  topes en la zona horaria del negocio, nunca en UTC.
- Textos, comentarios y mensajes en español.

---

## Phase 1: Setup (infraestructura compartida)

**Purpose**: variables de entorno documentadas y empaquetado de los assets nuevos.

- [ ] T001 [P] Actualizar .env.example: volver a documentar `ANTHROPIC_API_KEY=` (la línea se perdió en el último cambio) indicando que ahora basta ella para tener bot (WhatsApp opcional, R11); cambiar el comentario de `EMERGENCY_CONTACT_PHONE` a "obligatoria con `ANTHROPIC_API_KEY`"; añadir `PUBLIC_BASE_URL=` (opcional, URL `https` de la instancia, usada para escribir el fragmento del chat web)
- [ ] T002 [P] Ampliar scripts/copy-assets.mjs para copiar también `src/channels/web/views` y `src/channels/web/assets` a `dist/src/channels/web/`

---

## Phase 2: Foundational (prerrequisitos bloqueantes)

**Purpose**: núcleo de conversación multicanal, migración `0002_channels`, contadores del chat
web y composición del bot sin WhatsApp. Al terminar, WhatsApp se comporta igual que antes y
los tres canales comparten una sola cadena.

**⚠️ CRITICAL**: ninguna historia puede empezar hasta terminar esta fase.

### Configuración

- [ ] T003 Cambiar `loadEnv` en src/config/env.ts: `EMERGENCY_CONTACT_PHONE` obligatoria cuando hay `ANTHROPIC_API_KEY` (mensaje "EMERGENCY_CONTACT_PHONE es obligatoria con ANTHROPIC_API_KEY"), `ANTHROPIC_API_KEY` sigue obligatoria con WhatsApp, y nueva `PUBLIC_BASE_URL` opcional (URL absoluta `https`, o `http` solo con `localhost`/`127.0.0.1`; se guarda sin barra final)
- [ ] T004 [P] Añadir casos a tests/unit/env.test.ts: clave del modelo sin WhatsApp y sin contacto de emergencia (error), clave del modelo sin WhatsApp con contacto (válido), `PUBLIC_BASE_URL` con ruta o `http` público (error), ausente (válido); mantener los casos existentes de WhatsApp

### Datos y migración

- [ ] T005 Modificar src/db/schema.ts según [data-model.md](data-model.md): enum `customer_channel` (`whatsapp`, `web`, `playground`); en `customer`, `channel` NOT NULL y `channel_user_id` (antes `phone`) con `UNIQUE(channel, channel_user_id)` en lugar de `customer_phone_unique`; en `message`, `channel_message_id` (antes `wa_message_id`, único) y `reply_trace jsonb` nullable; tablas `web_chat_settings` (singleton `id smallint` con `CHECK (id = 1)`, `enabled`, `allowed_origins text[]`, `privacy_url`, `daily_cap` 200 con `CHECK >= 1`, `monthly_cap` 3000 con `CHECK >= daily_cap`, `updated_at`) y `web_usage_day` (`day date` PK, `replies integer` default 0); `conversationTableNames` pasa a `['message', 'conversation', 'customer', 'web_usage_day']`
- [ ] T006 Generar con `pnpm db:generate` la migración src/db/migrations/0002_channels.sql (y `meta/0002_snapshot.json`, `_journal.json`) y editarla a mano para que **renombre** (`RENAME COLUMN phone TO channel_user_id`, `RENAME COLUMN wa_message_id TO channel_message_id` con su restricción) en vez de borrar y crear; `ADD COLUMN channel … NOT NULL DEFAULT 'whatsapp'` seguido de `DROP DEFAULT`; sustituir el único; crear las dos tablas y la fila `INSERT INTO web_chat_settings (id) VALUES (1)` (R2, FR-005)
- [ ] T007 Actualizar `resetDb` en tests/helpers/db.ts: truncar también `web_usage_day` y restablecer `web_chat_settings` a sus valores por defecto con un `UPDATE` (no se trunca: es singleton)
- [ ] T008 [P] Test de integración tests/integration/conversation/migration-0002.test.ts: base con solo `0000`+`0001`, cargar clientes, conversaciones y mensajes con varios estados, aplicar `0002` y comprobar mismos recuentos, `channel = 'whatsapp'`, `channel_user_id` = teléfono, `channel_message_id` = id de Meta, estados y relaciones intactos y fila única de `web_chat_settings` desactivada (FR-005, garantía 3)

### Dominio: canales, tipos y puertos

- [ ] T009 [P] Crear src/conversation/channels.ts: tipo `Channel`, `channelUserIdSchema(channel)` con Zod (E.164 con libphonenumber-js · `^[0-9a-f]{64}$` · UUID), `ChannelPolicy` y `ChannelPolicies` según [contracts/conversation-channels.md](contracts/conversation-channels.md), y `buildChannelPolicies({ whatsappSender, stored })` con los valores de R1 (WhatsApp solo si hay sender; ventana 24 h desde `settings.ts`)
- [ ] T010 Generalizar src/conversation/ports.ts: `ChannelSender.sendText(to, body, opts)` devuelve `{ channelMessageId }`; exportar `Channel`/`ChannelPolicy` desde channels.ts y el sender `storedDelivery` que no llama a nada externo y devuelve `out:<uuid>` (depende de T009)
- [ ] T011 Generalizar src/conversation/types.ts: `InboundEvent` con `channel`, `channelUserId` y `channelMessageId` (en lugar de `from` y `waMessageId`), validando `channelUserId` con `channelUserIdSchema`; añadir `ContactReason`, `ReplyTrace` y `replyTraceSchema` (Zod) de data-model.md (depende de T009)
- [ ] T012 [P] Test unitario tests/unit/conversation/channels.test.ts: validación de `channel_user_id` por canal, tabla de políticas exacta de R1 (entrega, ventana, negocio activo, chat activado, tope), WhatsApp ausente sin política, `storedDelivery` devuelve ids `out:` distintos
- [ ] T013 [P] Test unitario tests/unit/conversation/reply-trace.test.ts: `replyTraceSchema` acepta los casos de data-model.md, rechaza `reason` con `added = false` distinto de `null` y `groundingRejections` fuera de 0–2

### Registros técnicos

- [ ] T014 Modificar src/conversation/activity-log.ts según [contracts/activity-log.md](contracts/activity-log.md): `EventContext` = `{ channel, customerKey, conversationId }`; campo `via` en todo evento con cliente o conversación; seudónimo = 12 hex de `HMAC(channel + ":" + channel_user_id)`; eventos nuevos `web_session_created` (debug), `web_rejected` (warn, `reason`), `web_quota_reached` (warn, `period`, `cap`); `message_discarded.reason` admite `disabled` y `quota`; `reply_sent` añade `groundingRejections` y `template` admite `R-UNAVAILABLE`
- [ ] T015 [P] Actualizar tests/unit/conversation/activity-log.test.ts: mismo `channel_user_id` en dos canales da seudónimos distintos, `via` presente, niveles de los eventos nuevos, sin campos de texto libre
- [ ] T016 Quitar `remoteAddress` y `remotePort` del serializador de peticiones del logger de Fastify en src/app.ts, manteniendo `method`, `url` y `hostname` (R10, SC-008)

### Repositorios

- [ ] T017 [P] Modificar src/conversation/repositories/customer.ts: `upsertByPhone` → `upsertByChannel(tx, channel, channelUserId)`; `deleteOrphans` sin cambios de lógica (borra huérfanos de cualquier canal)
- [ ] T018 [P] Modificar src/conversation/repositories/message.ts: `waMessageId` → `channelMessageId` en inserciones y deduplicación; guardar `replyTrace` al crear salientes; nueva `listForConversation(tx, conversationId, afterCursor?)` que devuelve entrantes `pending`/`answered`/`rate_limited` y salientes `sent` ordenados, con cursor opaco (lo usan playground y web)
- [ ] T019 [P] Ajustar src/conversation/repositories/conversation.ts y cualquier consulta que una `customer.phone` para leer `(channel, channel_user_id)` del cliente al reclamar una conversación

### Chat web: configuración leída y contadores (dominio sin HTTP)

- [ ] T020 [P] Crear src/webchat/settings.ts con `readWebChatSettings(tx)` (lee la fila singleton sin caché) y el tipo `WebChatSettings`; la escritura se añade en US2
- [ ] T021 [P] Crear src/webchat/usage.ts: `localDay(now, timezone)` y `localMonthRange(now, timezone)` sin pasar a UTC, `incrementWebUsage(tx, now, timezone)` (`INSERT … ON CONFLICT (day) DO UPDATE SET replies = replies + 1`), `readWebUsage(tx, now, timezone)` → `{ today, month }` y `capReached(usage, settings)` → `null | 'day' | 'month'`, `purgeWebUsage(tx, now)` (> 400 días)
- [ ] T022 [P] Test unitario tests/unit/webchat/usage.test.ts: 23:59 y 00:00 locales caen en días distintos aunque en UTC sea el mismo día (y al revés), cambio de mes local, cambio de hora de verano, `capReached` con tope diario, mensual y ninguno (garantía 8)

### Plantillas y responder

- [ ] T023 [P] Añadir R-UNAVAILABLE a src/conversation/templates.ts: "Ahora mismo no puedo atenderte por este chat. {CONTACTO}" (usted: "atenderle"), con bloque de contacto o CONTACTO-EMERGENCIA si el snapshot no se lee, sin saludo; y `unavailableContact(snapshot | null, emergencyPhone)` que devuelve el texto plano del contacto para el objeto `unavailable`
- [ ] T024 [P] Casos nuevos en tests/unit/conversation/templates.test.ts: R-UNAVAILABLE en tú y usted, siempre con contacto, con emergencia si no hay snapshot, sin saludo
- [ ] T025 Modificar src/conversation/responder.ts: `RespondInput.phone` → `customerKey`; `needsContact` devuelve `ContactReason | null` con la precedencia del contrato (`handoff_requested` > nada si `needsRephrase` > `offer_contact` > `booking_requested` > `price_on_request`; plantillas con contacto → `template`); `Response` añade `contactReason` y `groundingRejections` (número de borradores rechazados, sin valores); sin ninguna condición por canal
- [ ] T026 [P] Test unitario tests/unit/conversation/contact-reason.test.ts: cada motivo, la precedencia y que `needsRephrase` anula `offer_contact`; `groundingRejections` 0, 1 y 2; actualizar tests/unit/conversation/responder-compose.test.ts si usa `phone`

### Recepción y procesador

- [ ] T027 Modificar src/conversation/intake.ts: recibir `policies: ChannelPolicies`; por evento, en este orden, `requiresActiveBusiness` y negocio no activo → `discarded/not_active`; `requiresWebChatEnabled` y chat desactivado (`readWebChatSettings`) → `discarded/disabled`; `usageCap` y `capReached` → `discarded/quota`; si no, guardar como hoy con `upsertByChannel`, límite 30/15 min, conversación de 24 h y deduplicación por `channelMessageId`; `handle` devuelve `IntakeOutcome[]` (`stored` · `duplicate` · `rate_limited` · `discarded`); `message_discarded` con el motivo y `via`
- [ ] T028 Modificar src/conversation/processor.ts: `policies` en lugar de `sender`; con la política del canal del cliente aplicar negocio activo (regla de la 002), chat desactivado → pendientes `discarded` (`disabled`) sin respuesta, ventana de respuesta solo si `replyWindowMs` no es `null`, y `usageCap` con tope alcanzado → R-UNAVAILABLE sin llamar al modelo; en la transacción del saliente guardar `reply_trace` (template, greeting, contact, groundingRejections, modelMs, latencyMs) en todos los canales e `incrementWebUsage` si `usageCap` y no es R-UNAVAILABLE; `sendRateLimitNotice` igual para todos (depende de T021, T023, T025, T027)
- [ ] T029 Añadir la purga de `web_usage_day` (> 400 días) a la pasada horaria de src/conversation/retention.ts (FR-028)

### Adaptadores y composición

- [ ] T030 [P] Adaptar src/channels/whatsapp/payload.ts y src/channels/whatsapp/webhook.ts para producir el `InboundEvent` generalizado (`channel: 'whatsapp'`, `channelUserId` E.164, `channelMessageId` = id de Meta) e ignorar el `IntakeOutcome` (mismas respuestas `200`/`503`, FR-004); `graph-client.ts` devuelve `{ channelMessageId }`
- [ ] T031 Modificar src/bot.ts: crear el bot cuando hay `ANTHROPIC_API_KEY` (WhatsApp opcional dentro de él; sin clave, `null` y aviso en el log); construir las políticas con `buildChannelPolicies`; transcriptor solo con WhatsApp y audios activados; exponer en `Bot` la recepción, el lector del snapshot, `emergencyContactPhone` y `clock` que usarán las rutas del chat y del panel; actualizar `BotHttp` en src/app.ts (el webhook se registra solo si hay WhatsApp)
- [ ] T032 [P] Adaptar src/cli/bot-chat.ts al `InboundEvent` generalizado (sigue simulando WhatsApp con `channel: 'whatsapp'`)

### Tests de la 002 y paridad

- [ ] T033 Adaptar los dobles y helpers en tests/helpers/fakes.ts (`FakeChannelSender` devuelve `{ channelMessageId }`; `RecordingActivityLog` con `customerKey`), tests/helpers/bot.ts (`createTestBot` monta `policies`, con opciones para chat web activado, topes y canal) y tests/helpers/whatsapp.ts, sin cambiar lo que comprueban
- [ ] T034 Adaptar a los nombres nuevos (`channel_user_id`, `channel_message_id`, `InboundEvent`, `customerKey`) solo la construcción de eventos y consultas de tests/contract/whatsapp-webhook.test.ts, tests/unit/conversation/payload.test.ts, tests/eval/harness.ts y tests/integration/conversation/*.test.ts, sin tocar sus aserciones; ejecutar `pnpm test` y dejar todo en verde (FR-004, SC-001, garantía 2)
- [ ] T035 Test de integración tests/integration/conversation/channel-parity.test.ts parametrizado por `whatsapp`, `web` y `playground` con el modelo falso: misma conversación (saludo, horario, dato sin registrar, petición de persona, verificador que rechaza un borrador) → mismos textos, plantillas, saludo, contacto y `reply_trace` salvo latencias, y mismos eventos salvo `via`; la ventana de 24 h descarta solo en WhatsApp; con negocio "en preparación" responde playground y no web ni WhatsApp; con el chat web desactivado, web descarta (`disabled`) y los otros no (garantías 1, 4 y 5; SC-002 en CI)
- [ ] T036 Test de integración tests/integration/conversation/web-quota-core.test.ts: tope alcanzado en la recepción → `discarded/quota` sin guardar; tope alcanzado entre la recepción y el procesado → R-UNAVAILABLE y cero llamadas al modelo falso, sin incrementar el contador; playground nunca escribe en `web_usage_day` ni le afectan los topes; WhatsApp sigue respondiendo con el tope web alcanzado (garantías 6 y 7, SC-006, US4 escenario 4)

**Checkpoint**: WhatsApp igual que antes (toda la suite de la 002 en verde) y el núcleo acepta
eventos de los tres canales con una sola cadena.

---

## Phase 3: User Story 1 - Probar el bot desde el panel (Priority: P1) 🎯 MVP

**Goal**: el operador conversa con el bot desde `/admin/playground` con los datos reales y ve
junto a cada respuesta su información técnica.

**Independent Test**: con un negocio activo y sesión de operador, abrir "Probar el bot",
preguntar horario, precio, algo sin dato y pedir una persona; las respuestas coinciden con las
de WhatsApp y cada una muestra saludo, plantilla, contacto y motivo, rechazos y tiempo.

### Tests for User Story 1 ⚠️

> Escribirlos primero y comprobar que fallan.

- [ ] T037 [P] [US1] Test de contrato tests/contract/admin/playground.test.ts según [contracts/admin-web-channel.md](contracts/admin-web-channel.md): sin sesión las cuatro rutas redirigen al login (o `401` + `HX-Redirect`) y no se guarda nada (US1-7); `POST` sin CSRF → `403` (FR-013); texto vacío o > 1 000 → `422`; con htmx el `POST` devuelve el mensaje y el indicador con `hx-get` y `hx-trigger="every 1s"`, sin htmx `303`; `GET …/messages?after=` devuelve `204` mientras no hay respuesta y el fragmento sin `hx-trigger` cuando llega; aviso de "en preparación" (FR-011) y aviso con formulario deshabilitado sin bot; la información técnica nunca muestra valores rechazados (garantía 6)
- [ ] T038 [P] [US1] Test de integración tests/integration/conversation/playground.test.ts con el modelo falso: primera respuesta con saludo y nombre del negocio; segunda sin saludo y con el historial (US1-2); "Nueva conversación" vuelve a saludar sin historial (US1-4); precio cambiado en el panel aparece en la siguiente respuesta (US1-5); dato sin registrar → contacto con motivo `offer_contact` en `reply_trace` (US1-3); negocio "en preparación" responde (US1-6); nada en `web_usage_day`

### Implementation for User Story 1

- [ ] T039 [P] [US1] Crear las vistas src/admin/views/playground.eta (conversación, caja de texto con `maxlength=1000`, botón "Nueva conversación", aviso de "en preparación" y de falta de clave) y src/admin/views/partials/playground-message.eta y src/admin/views/partials/playground-trace.eta (texto del bot como texto escapado y la tabla de información técnica: "Saludo añadido/Sin saludo", "Plantilla: … (R-…)"/"Redactada por el modelo", "Contacto añadido: pidió hablar con una persona / el modelo ofreció el contacto / pidió reservar / precio a consultar / lo incluye la plantilla"/"Sin contacto", "El verificador rechazó N borrador(es)"/"Sin rechazos", "Respondió en 6,1 s (modelo 3,2 s)" con coma decimal)
- [ ] T040 [US1] Crear src/admin/routes/playground.ts: `GET /admin/playground` (lee o crea `playgroundId` UUID en la sesión cifrada, carga mensajes con `listForConversation`), `POST /admin/playground/messages` (valida 1–1 000 caracteres, llama a la recepción del bot con `channel: 'playground'`, `channelUserId = playgroundId`, `channelMessageId = pg:<id>:<uuid>`, `sentAt` = hora del servidor; respuesta htmx o `303`), `GET /admin/playground/messages?after=` (`204` o fragmento con respuesta y `reply_trace`), `POST /admin/playground/reset` (nuevo `playgroundId`, `303`); sin bot, las rutas de escritura responden con el aviso y no guardan (depende de T039)
- [ ] T041 [US1] Registrar las rutas del playground en src/admin/routes/index.ts y añadir el enlace "Probar el bot" a la navegación de src/admin/views/layout.eta; pasar el bot a las rutas del panel desde src/app.ts
- [ ] T042 [P] [US1] Estilos de la conversación y de la información técnica en src/admin/views/app.css (burbujas cliente/bot, indicador "escribiendo…", tabla técnica discreta)

**Checkpoint**: US1 completa y validable sola: el operador prueba el bot sin WhatsApp (MVP).

---

## Phase 4: User Story 2 - Activar el chat web e insertarlo en la web del negocio (Priority: P2)

**Goal**: el operador activa el chat, indica webs permitidas y política de privacidad, y copia
el fragmento; el chat solo se muestra en las webs permitidas y deja de atender al desactivarlo.

**Independent Test**: con el chat desactivado la web no muestra el chat; activarlo con una web
permitida hace que el fragmento muestre el chat en esa web y no en otra; desactivarlo muestra
"no disponible" con el contacto.

### Tests for User Story 2 ⚠️

- [ ] T043 [P] [US2] Test unitario tests/unit/webchat/schemas.test.ts de `webChatSettingsSchema`: origen con ruta, con `http` público, repetido (tras normalizar mayúsculas y barra) o más de 10 → error en la línea; `http://localhost` y `http://127.0.0.1` aceptados; `privacy_url` no `https` → error; `monthly_cap < daily_cap` → error en el mensual; activar sin orígenes o sin enlace → errores por campo con los mensajes del panel; desactivar siempre válido y conserva los valores
- [ ] T044 [P] [US2] Test de contrato tests/contract/admin/web-chat.test.ts: sin sesión redirige y sin CSRF `403`; estado "Desactivado" por defecto (FR-014); activar sin webs o sin enlace → `422` y la fila sigue `enabled = false` (US2-2); guardado válido → `303` con aviso; el fragmento usa `PUBLIC_BASE_URL` si está definida y el origen de la petición si no, con la nota "No mostrará nada hasta que actives el chat" cuando está desactivado; uso "Hoy: N de 200 · Este mes: M de 3 000" leído de `web_usage_day` en la zona del negocio (garantía 5); la portada `/admin` muestra "Chat web: desactivado" / "activado en N webs"
- [ ] T045 [P] [US2] Test de contrato tests/contract/web-chat-frame.test.ts: `GET /chat/widget.js` siempre `200` con `text/javascript` y `Cache-Control: public, max-age=3600`; `GET /chat/frame` con chat desactivado, negocio no activo o sin bot → vista "no disponible" con contacto (o emergencia) y `frame-ancestors 'none'`; activado → `frame-ancestors` con exactamente los orígenes configurados y el resto de la CSP del contrato, sin `X-Frame-Options`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`; `Referer` de origen no permitido → "no disponible" y `'none'`; el resto de la app mantiene `X-Frame-Options: DENY`; al desactivar, la siguiente petición ya ve "no disponible" (US2-5, sin caché)

### Implementation for User Story 2

- [ ] T046 [P] [US2] Crear src/webchat/schemas.ts con `webChatSettingsSchema` (Zod) según data-model.md: orígenes desde textarea (una por línea, vacías fuera), normalizados a `url.origin` en minúsculas, sin duplicados, máximo 10, `https` salvo `localhost`/`127.0.0.1`; `privacy_url` `https`; topes enteros ≥ 1 con `monthly_cap ≥ daily_cap`; `enabled` exige orígenes y enlace con los mensajes "Indica al menos una web donde se mostrará el chat" y "Indica el enlace a la política de privacidad del negocio"
- [ ] T047 [US2] Añadir `saveWebChatSettings(tx, input)` a src/webchat/settings.ts (valida con el esquema y actualiza la fila con `updated_at`) (depende de T046)
- [ ] T048 [P] [US2] Crear src/webchat/availability.ts: `webChatAvailability({ tx, reader, botPresent, emergencyPhone, now })` → `{ available: true, settings, snapshot }` o `{ available: false, unavailable: { reason: 'disabled' | 'not_active' | 'quota' | 'no_bot', message, contact } }`, con `contact` de `unavailableContact` (snapshot o emergencia) y `message` "Ahora mismo el chat no está disponible." (FR-022)
- [ ] T049 [US2] Crear src/admin/views/web-chat.eta (estado, formulario con webs permitidas en textarea, enlace de privacidad, topes, casilla "Activar el chat en estas webs", errores por campo, uso del día y del mes, fragmento en `<textarea readonly>` con botón "Copiar", aviso sin bot) y src/admin/routes/web-chat.ts (`GET` y `POST /admin/web-chat` según el contrato; uso con `readWebUsage` en la zona del negocio; URL del fragmento con `PUBLIC_BASE_URL` o el origen de la petición) (depende de T047)
- [ ] T050 [US2] Registrar las rutas del chat web en src/admin/routes/index.ts, añadir "Chat web" a la navegación de src/admin/views/layout.eta y la línea de estado del chat web con enlace en src/admin/routes/dashboard.ts y src/admin/views/dashboard.eta (no es un aviso de `computeWarnings`)
- [ ] T051 [P] [US2] Crear src/channels/web/assets/widget.js (vanilla, ≈ 2 KB): añade al final del `<body>` un `<iframe src="{origen}/chat/frame" title="Chat con el asistente" allow="">` fijo abajo a la derecha en tamaño cerrado; escucha `message` solo de `{origen}` con `{type: "chat:resize", open}` para cambiar el tamaño; no lee cookies ni el DOM de la web; `{origen}` sale de `document.currentScript.src`
- [ ] T052 [P] [US2] Crear src/channels/web/views/frame.eta con dos vistas (chat: botón para abrir, aviso fijo de asistente automático con el nombre del negocio, borrado a los 30 días y enlace a la política de privacidad — FR-017, SC-005 —, lista de mensajes vacía y caja de texto; "no disponible": mensaje y contacto como texto) enlazando `/chat/assets/frame.js` y `/chat/assets/frame.css`, sin scripts ni estilos inline
- [ ] T053 [P] [US2] Crear src/channels/web/guards.ts con `frameAncestors(settings)` y la comprobación del origen del `Referer` contra la lista (lo que conoce cabeceras vive aquí, no en `src/webchat`)
- [ ] T054 [US2] Crear src/channels/web/routes.ts como plugin encapsulado de Fastify con `GET /chat/widget.js`, `GET /chat/assets/*` (frame.js, frame.css) y `GET /chat/frame` (disponibilidad sin caché, CSP del contrato con `frame-ancestors`, sin `X-Frame-Options` solo aquí, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`) (depende de T048, T052, T053)
- [ ] T055 [US2] Registrar el plugin `/chat` en src/app.ts (también sin bot, para servir `widget.js` y la vista "no disponible" con el contacto de emergencia) y ajustar la cabecera `X-Frame-Options: DENY` global para que no se aplique a `/chat/frame`

**Checkpoint**: el operador activa y configura el chat; el iframe aparece solo en las webs
permitidas y muestra "no disponible" con el contacto al desactivarlo.

---

## Phase 5: User Story 3 - El cliente final conversa en la web del negocio (Priority: P2)

**Goal**: un visitante anónimo conversa desde la web del negocio con las mismas respuestas que
por WhatsApp y retoma la conversación desde el mismo navegador.

**Independent Test**: en una web permitida con el chat activado, abrir el chat en un navegador
nuevo, preguntar horario, un precio "a consultar" y pedir una persona; comprobar saludo,
respuestas y contacto; recargar y comprobar que la conversación sigue sin repetir el saludo.

**Depende de US2** (chat activado y frame servido).

### Tests for User Story 3 ⚠️

- [ ] T056 [P] [US3] Test unitario tests/unit/webchat/session-token.test.ts: token `base64url(id).base64url(HMAC)` con clave HKDF de `SESSION_SECRET` (`info = "web-session"`); firma alterada, formato inválido o otro secreto → rechazo; `channel_user_id` = 64 hex de `SHA-256(id)` y estable; dos sesiones distintas → ids distintos
- [ ] T057 [P] [US3] Test estático tests/unit/channels/web-assets.test.ts: los ficheros de src/channels/web/assets/ no contienen `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` ni `eval` (garantía 9)
- [ ] T058 [P] [US3] Crear tests/helpers/web.ts: `createWebSession(app)`, `postWebMessage(app, token, text, clientMessageId?)`, `getWebMessages(app, token, after?)` y `webHeaders()` con `Origin` de la instancia y `Sec-Fetch-Site: same-origin`, usando `fastify.inject`
- [ ] T059 [P] [US3] Test de contrato tests/contract/web-chat.test.ts según [contracts/web-chat-http.md](contracts/web-chat-http.md): `POST /session` → `201` con token, o `200 {unavailable}` sin token si no está disponible; `GET /state` con `available`, `businessName`, `privacyUrl`, `contact` siempre, `maxLength: 1000`; `POST` con `Origin` ajeno o `Sec-Fetch-Site: cross-site` → `403` y cero filas (FR-027, garantía 3); token alterado → `401` (garantía 4); texto vacío o > 1 000 → `400 {"error":"text","maxLength":1000}`; mismo `clientMessageId` dos veces → `202` y una sola fila (FR-023, garantía 5); desactivado o no activo → `200 {accepted:false, unavailable}` sin guardar; snapshot ilegible → `503` con contacto de emergencia; `GET /messages` nunca incluye `reply_trace` y el texto con `<script>` vuelve tal cual; cuerpo > 8 KB rechazado; `Content-Type` y `Cache-Control: no-store`
- [ ] T060 [P] [US3] Test de integración tests/integration/conversation/web-conversation.test.ts con el modelo falso: primera respuesta con saludo y nombre del negocio (US3-2); tres mensajes en < 3 s → una sola respuesta (US3-3); petición de persona → contacto y horario (US3-4); tras reconectar, `GET /messages` sin cursor devuelve historial y respuesta llegada mientras tanto y la siguiente no repite saludo (US3-5); más de 24 h sin mensajes → conversación nueva con saludo (FR-019); negocio "en preparación" → `unavailable` con contacto (US3-6); dos "pestañas" con el mismo token no duplican respuestas; `waiting` es `true` hasta que hay respuesta
- [ ] T061 [P] [US3] Test de integración tests/integration/conversation/web-privacy.test.ts: conversación web completa (sesión, mensajes, límite por visitante, tope) capturando todos los registros; no aparecen el token, el `channel_user_id` en claro, los textos enviados ni la IP de `fastify.inject`; todos los eventos con conversación llevan `via: "web"` (SC-008, garantías 1–3 de activity-log)
- [ ] T062 [P] [US3] Ampliar tests/integration/conversation/latency.test.ts al canal `web`: `reply_sent.latencyMs` desde el último mensaje del grupo cumple el mismo presupuesto que WhatsApp (R14, SC-004)

### Implementation for User Story 3

- [ ] T063 [P] [US3] Crear src/webchat/session-token.ts: `issueWebSession(secret)` → token con 16 bytes aleatorios y HMAC-SHA256 con clave HKDF (`info = "web-session"`), `verifyWebSession(secret, token)` → `channelUserId` (`hex(SHA-256(id))`) o `null`, comparación en tiempo constante; el token no se guarda en ningún sitio
- [ ] T064 [US3] Ampliar src/channels/web/guards.ts con `requireSameOrigin` (en `POST`, `Origin` igual al de la instancia; `Sec-Fetch-Site` distinto de `same-origin` si llega → `403 {"error":"forbidden"}` y `web_rejected{reason:"origin"}`) y `requireWebSession` (`Authorization: Bearer`, `verifyWebSession`; si falla `401 {"error":"session"}` y `web_rejected{reason:"session"}`) (depende de T063)
- [ ] T065 [US3] Añadir a src/channels/web/routes.ts la API JSON bajo `/chat/api` con parser JSON solo en este plugin y `bodyLimit` 8 KB: `POST /session` (`201` + `web_session_created`, o `200 {unavailable}`), `GET /state`, `GET /messages?after=` (conversación vigente de < 24 h con `listForConversation`, `from: visitor|bot`, `cursor`, `waiting`), `POST /messages` (Zod: `clientMessageId` UUID, `text` recortado 1–1 000; `channelMessageId = web:<channelUserId>:<clientMessageId>`, `sentAt` = hora del servidor; traduce `IntakeOutcome` a `202`/`200 {accepted:false, unavailable}`; snapshot ilegible → `503` con emergencia; `web_rejected{reason:"invalid"}` en `400`); todas con `Cache-Control: no-store` (depende de T064)
- [ ] T066 [P] [US3] Crear src/channels/web/assets/frame.js (vanilla, solo `textContent`): abre y cierra con `postMessage({type:"chat:resize", open})` al padre; pide sesión y la guarda en `localStorage` (en memoria si no hay almacenamiento); carga `/state` y el historial; envía con `clientMessageId` (`crypto.randomUUID()`), valida longitud en cliente y explica el motivo; mientras `waiting`, sondea cada 1,5 s mostrando "escribiendo…" y a los 45 s muestra la disculpa R-ERR con `contact` y deja de sondear; `401` → pide sesión nueva; `unavailable` → muestra mensaje y contacto; `429` → aviso una vez y no envía hasta `Retry-After`
- [ ] T067 [P] [US3] Crear src/channels/web/assets/frame.css (botón flotante, panel del chat, burbujas, aviso de privacidad, "escribiendo…", vista "no disponible"; legible en móvil)
- [ ] T068 [US3] Adaptar tests/eval/harness.ts para aceptar `EVAL_CHANNEL` (`whatsapp` por defecto, `web`), enviando los eventos con `channel`, `channelUserId` y `channelMessageId` del canal elegido y con el chat web activado en la BD de la evaluación (SC-002)

**Checkpoint**: un visitante conversa por la web con las mismas respuestas que por WhatsApp y
retoma la conversación al recargar.

---

## Phase 6: User Story 4 - Protección del chat web contra abuso y exceso de coste (Priority: P3)

**Goal**: límites por visitante y por IP y topes diario y mensual visibles para el operador,
sin afectar a WhatsApp ni al playground.

**Independent Test**: un visitante que supera el límite recibe un único aviso con el contacto y
luego silencio; 21 sesiones en una hora desde la misma IP dan `429` con contacto; con el tope
alcanzado el chat muestra el contacto, el panel lo avisa y WhatsApp sigue respondiendo.

### Tests for User Story 4 ⚠️

- [ ] T069 [P] [US4] Test de contrato tests/contract/web-chat-limits.test.ts: 21.ª `POST /chat/api/session` en una hora desde la misma IP → `429 {"unavailable":{"reason":"ip_limit",…}}` con contacto y `Retry-After`, y `web_rejected{reason:"session_limit"}` (garantía 6, SC-007); 121.º `POST /chat/api/messages` en 15 min → `429` sin guardar ni llamar al modelo (`ip_limit`); IPs distintas no se afectan; el límite general de 600/15 min en `state` y `messages`
- [ ] T070 [P] [US4] Test de integración tests/integration/conversation/web-limits.test.ts: 31 mensajes seguidos de un visitante → R-LIMIT una sola vez por ventana como saliente, el resto `rate_limited` sin respuesta, y vuelve a responder al bajar el ritmo (US4-1, FR-024); los mensajes del playground no cuentan para los límites del chat público
- [ ] T071 [P] [US4] Test de integración tests/integration/conversation/web-quota.test.ts: con tope diario 3, la cuarta pregunta por `POST /chat/api/messages` → `accepted:false` con `quota` y contacto (US4-3); `web_quota_reached{period:"day"}` se emite una sola vez; al empezar el día local siguiente vuelve a responder; tope mensual igual con `period:"month"`; el panel muestra "Hoy: 3 de 3" y el aviso de tope en `/admin/web-chat` y en la portada

### Implementation for User Story 4

- [ ] T072 [US4] Añadir los límites por IP en memoria con `@fastify/rate-limit` (clave `request.ip` con `TRUST_PROXY`) a src/channels/web/routes.ts: 20/h en `POST /chat/api/session`, 120/15 min en `POST /chat/api/messages`, 600/15 min en el resto de `/chat/api`; `errorResponseBuilder` → `429` con el objeto `unavailable` (`ip_limit`, contacto) y `Retry-After`; `web_rejected{reason:"session_limit"|"ip_limit"}` sin IP en el registro; la IP no se pasa a ninguna capa de dominio (R10, FR-025, FR-029)
- [ ] T073 [US4] Emitir `web_quota_reached{period, cap}` una vez por periodo y proceso (memoria) cuando la recepción o el procesador detectan el tope, en src/webchat/usage.ts o en quien llame a `capReached` dentro de src/conversation/intake.ts y src/conversation/processor.ts
- [ ] T074 [US4] Mostrar en src/admin/views/web-chat.eta el aviso destacado de tope alcanzado ("El chat web ha alcanzado el tope diario: no responde hasta mañana. Los clientes ven el contacto del negocio." y su versión mensual) y en src/admin/routes/dashboard.ts y src/admin/views/dashboard.eta el estado "tope alcanzado (diario|mensual)" (FR-026, FR-026a)

**Checkpoint**: el chat público está listo para publicarse en una web real.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: verificación final, evaluación con el modelo real y documentación.

- [ ] T075 [P] Comprobar que tests/unit/sector-neutrality.test.ts recorre también los `.js`, `.css` y `.eta` de src/channels/web y src/webchat (recorre todo `src/`; añadir una aserción que lo confirme si hace falta)
- [ ] T076 Revisión de seguridad de `/chat/*` y de las páginas nuevas del panel con el agente `security-auditor` (CSP y `frame-ancestors`, comprobación de origen, firma de sesión, límites, ausencia de IP y tokens en registros, escapado en vistas Eta y assets) y corregir lo que encuentre
- [ ] T077 Ejecutar `pnpm lint && pnpm typecheck && pnpm test` y dejar todo en verde, incluidas las pruebas de la 002 (SC-001)
- [ ] T078 Ejecutar `pnpm test:eval` y `EVAL_CHANNEL=web pnpm test:eval` con el modelo real y comparar los porcentajes de SC-001, SC-002 y SC-005 a SC-008 de la 002 entre canales (SC-002; tiene coste, fuera de `pnpm test`)
- [ ] T079 Recorrer [quickstart.md](quickstart.md) en el navegador (escenarios 1 a 6), incluida la página de otro origen no permitido, el texto con `<script>` y la ventana privada, y anotar desviaciones
- [ ] T080 Avisar al usuario y actualizar README.md con el estado de la feature 004 (canal web y "Probar el bot"), las variables `PUBLIC_BASE_URL` y `EMERGENCY_CONTACT_PHONE` obligatoria con `ANTHROPIC_API_KEY`, y cómo activar el chat e insertar el fragmento

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias.
- **Foundational (Phase 2)**: depende de Setup; bloquea todas las historias. Orden interno:
  configuración (T003–T004) → esquema y migración (T005–T008) → canales, tipos y puertos
  (T009–T013) → registros (T014–T016) y repositorios (T017–T019) → contadores (T020–T022) →
  plantillas y responder (T023–T026) → recepción y procesador (T027–T029) → adaptadores y
  composición (T030–T032) → tests de la 002 y paridad (T033–T036).
- **US1 (Phase 3)**: depende solo de Foundational.
- **US2 (Phase 4)**: depende solo de Foundational; puede ir en paralelo con US1.
- **US3 (Phase 5)**: depende de Foundational y de US2 (frame, disponibilidad, configuración).
- **US4 (Phase 6)**: depende de US3 (API del chat) y de la página de US2 para los avisos.
- **Polish (Phase 7)**: depende de todas las historias.

### User Story Dependencies

- **US1 (P1)**: independiente; es el MVP.
- **US2 (P2)**: independiente de US1 (comparten solo index.ts y layout.eta del panel).
- **US3 (P2)**: necesita US2; no necesita US1, aunque conviene validarlo antes desde el panel.
- **US4 (P3)**: necesita US3; el tope en el núcleo ya está en Foundational (T027, T028, T036),
  aquí se añaden los límites por IP, el evento y los avisos.

### Within Each User Story

- Tests primero, fallando.
- Dominio (`src/webchat`) → rutas y guardas (`src/channels/web`, `src/admin/routes`) → vistas y
  assets → registro en `app.ts`/`index.ts`.

### Parallel Opportunities

- Setup: T001 y T002.
- Foundational: T004, T008, T012, T013, T015, T017–T022, T024, T026, T030, T032 en cuanto sus
  dependencias estén hechas.
- US1 y US2 pueden hacerse a la vez por personas distintas tras Foundational.
- Dentro de cada historia, todos los tests marcados [P] y las vistas/assets marcados [P].

---

## Parallel Example: User Story 2

```bash
# Tests de US2 a la vez:
Task: "Test unitario de webChatSettingsSchema en tests/unit/webchat/schemas.test.ts"
Task: "Test de contrato del panel en tests/contract/admin/web-chat.test.ts"
Task: "Test de contrato de widget y frame en tests/contract/web-chat-frame.test.ts"

# Piezas independientes de US2 a la vez:
Task: "webChatSettingsSchema en src/webchat/schemas.ts"
Task: "Disponibilidad en src/webchat/availability.ts"
Task: "widget.js en src/channels/web/assets/widget.js"
Task: "Vista del frame en src/channels/web/views/frame.eta"
```

## Parallel Example: User Story 3

```bash
Task: "Test de session-token en tests/unit/webchat/session-token.test.ts"
Task: "Test estático de assets en tests/unit/channels/web-assets.test.ts"
Task: "Contrato de la API en tests/contract/web-chat.test.ts"
Task: "Integración de la conversación web en tests/integration/conversation/web-conversation.test.ts"
Task: "frame.js en src/channels/web/assets/frame.js"
Task: "frame.css en src/channels/web/assets/frame.css"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1 Setup.
2. Phase 2 Foundational: WhatsApp sin cambios y núcleo multicanal (CRÍTICO).
3. Phase 3 US1: "Probar el bot".
4. **STOP y VALIDAR**: escenario 1 del quickstart; el operador prueba el bot sin Meta.

### Incremental Delivery

1. Setup + Foundational → la suite de la 002 en verde con el núcleo generalizado.
2. US1 → probar el bot desde el panel (MVP).
3. US2 → activar y configurar el chat; el iframe aparece solo en webs permitidas.
4. US3 → los visitantes conversan (no publicar en una web real todavía).
5. US4 → límites y topes: ya se puede publicar el chat.
6. Polish → evaluación con el modelo real por la web y README.

### Parallel Team Strategy

Tras Foundational: una persona con US1 y otra con US2; US3 y US4 en secuencia después de US2.

---

## Notes

- [P] = ficheros distintos y sin dependencias pendientes.
- Las tareas que tocan src/admin/routes/index.ts y layout.eta en US1 y US2 no son [P] entre sí.
- Hacer commit tras cada tarea o grupo lógico; parar en cada checkpoint para validar.
- `README.md` se actualiza solo en T080, y avisando antes al usuario (CLAUDE.md).
