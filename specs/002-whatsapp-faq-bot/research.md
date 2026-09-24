# Research: Atención automática de dudas y precios por WhatsApp

**Feature**: `002-whatsapp-faq-bot` | **Fecha**: 2026-09-24 | **Plan**: [plan.md](plan.md)

El stack base ya está fijado por la feature 001 (TypeScript strict, Node 22, Fastify 5,
PostgreSQL 16 + Drizzle, Zod, Vitest + Testcontainers). Aquí se deciden las piezas nuevas: el
canal de WhatsApp, el modelo de lenguaje, la transcripción de audios, la cola con espera de
agrupado, el límite por número, la retención y los registros técnicos. Cada decisión se evalúa
contra la constitución, en especial los Principios IV (solo información registrada) y V
(siempre hay salida a una persona).

---

## R1. Conexión con WhatsApp

- **Decision**: WhatsApp Business **Cloud API** de Meta, usada directamente (sin proveedor
  intermedio). Cada instancia tiene su propio número y sus credenciales en variables de
  entorno: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` (token de usuario de sistema),
  `WHATSAPP_APP_SECRET` (firma del webhook), `WHATSAPP_VERIFY_TOKEN` (alta del webhook) y
  `WHATSAPP_GRAPH_VERSION` (versión de la Graph API, fijada en `.env.example`).
  - Entrada: webhook `GET/POST /webhooks/whatsapp` ([contracts/whatsapp-webhook.md](contracts/whatsapp-webhook.md)).
  - Salida: `POST /{phone-number-id}/messages` con mensajes de texto, siempre como respuesta
    dentro de la ventana de atención de 24 horas (no hacen falta plantillas: el bot nunca
    inicia conversaciones, FR-005).
  - Las cinco variables van juntas: si falta alguna, la instancia arranca sin canal (el panel
    de la 001 sigue funcionando) y el arranque lo registra como aviso.
- **Rationale**: es la API oficial, sin coste de intermediario y con webhooks firmados
  (HMAC-SHA256 con el app secret). Las credenciales por variable de entorno siguen el mismo
  patrón que la credencial del operador y cumplen la asunción de la spec ("la configura el
  operador en la instancia"). Una instancia = un número = una BD mantiene el aislamiento.
- **Alternatives considered**:
  - *Twilio / 360dialog / otro BSP*: simplifican el alta del número, pero añaden coste por
    mensaje y un tercero más con acceso a las conversaciones. Se puede añadir más adelante
    como otro adaptador del mismo puerto `ChannelSender`/parser si un cliente lo necesita.
  - *Librerías no oficiales sobre WhatsApp Web (Baileys, whatsapp-web.js)*: incumplen los
    términos de WhatsApp y el número puede ser bloqueado. Descartado.
  - *Credenciales editables desde el panel*: cómodo, pero obliga a cifrar secretos en BD; no
    aporta nada mientras el operador ya gestiona las variables de la instancia.

## R2. Recepción: acuse rápido y procesamiento asíncrono

- **Decision**: el webhook verifica la firma sobre el cuerpo en bruto, valida el payload con
  Zod, **persiste** cada mensaje entrante en una transacción (deduplicado por el id de mensaje
  de WhatsApp) y responde `200` sin esperar a generar la respuesta. Un procesador en el mismo
  proceso (R5) genera y envía las respuestas.
  - El JSON solo se acepta en el contexto encapsulado de `/webhooks/whatsapp`, con su propio
    parser que conserva el `Buffer` para la firma; el resto de la app sigue sin API JSON
    (decisión de la 001).
  - Notificaciones de estado (`sent`, `delivered`, `read`), mensajes de grupos y eventos que
    no son mensajes se aceptan con `200` y se ignoran.
- **Rationale**: Meta reintenta si el webhook tarda o falla; persistir antes del `200`
  garantiza que no se pierde nada y la clave única del id de WhatsApp convierte los
  reintentos y duplicados del canal en no-operaciones (edge case "mensaje duplicado", FR-004).
  Guardar en BD en vez de en memoria permite reanudar tras una caída (FR-002a).
- **Alternatives considered**:
  - *Responder dentro de la petición del webhook*: supera los plazos de Meta con la espera de
    agrupado más la llamada al modelo y provoca reentregas.
  - *Cola externa (Redis/BullMQ, SQS)*: otra pieza de infraestructura por instancia para un
    volumen de decenas de mensajes al día; PostgreSQL con `FOR UPDATE SKIP LOCKED` basta.

## R3. Negocio en preparación y mensajes con retraso

- **Decision**:
  - En la recepción, el webhook consulta `KnowledgeReader.getSnapshot().status`. Si no es
    `active`, el mensaje **no se guarda**: solo se registra el descarte técnico (sin texto ni
    número en claro) y se responde `200` a Meta (FR-002).
  - En el procesamiento se vuelve a leer el snapshot. Si el negocio ha pasado a "en
    preparación" entre medias, los mensajes pendientes se borran sin respuesta (no pueden
    quedar guardados para contestarse después).
  - Al procesar, si han pasado más de 24 horas desde el último mensaje del cliente (marca
    `timestamp` que envía WhatsApp), los pendientes se marcan `discarded` sin respuesta
    (FR-002a). Si no, se contestan con el snapshot y la hora del momento de responder.
- **Rationale**: aplica literalmente FR-002 y FR-002a y respeta el contrato de la 001: el bot
  solo consulta el estado a través de `KnowledgeReader` (p95 < 50 ms, sin caché).
- **Alternatives considered**: comprobar el estado solo al procesar; obligaría a guardar
  mensajes recibidos en preparación, que la spec prohíbe.

## R4. Conversaciones

- **Decision**: una conversación agrupa los mensajes de un número; se abre una nueva cuando
  es su primer mensaje o han pasado más de 24 horas desde su último mensaje **entrante**
  (FR-019). El contexto para el modelo son los mensajes de la conversación en curso (máximo
  30 últimos, entrantes y salientes). Las marcas de tiempo de los mensajes son instantes y se
  guardan como `timestamptz`; la hora local del negocio solo se calcula para responder
  (horarios siguen sin pasar a UTC, convención de la 001).
- **Rationale**: 24 horas coincide con la ventana de atención de WhatsApp y con la asunción
  de la spec. El límite de 30 mensajes acota el coste del prompt sin afectar a
  conversaciones normales.
- **Alternatives considered**: conversación por día natural (rompe una conversación a
  medianoche); contexto sin límite (coste y latencia crecientes ante abuso, aunque el límite
  por número de R6 ya lo acota).

## R5. Espera de agrupado (debounce) y procesador

- **Decision**: **3 segundos** sin mensajes nuevos del mismo número antes de responder, con
  un tope de **8 segundos** desde el primer mensaje pendiente para que un cliente que escribe
  sin parar reciba respuesta. El procesador:
  1. se despierta con cada mensaje recibido (temporizador en memoria) y, como red de
     seguridad, cada segundo;
  2. reclama con `SELECT … FOR UPDATE SKIP LOCKED` las conversaciones cuyo último pendiente
     tiene ≥ 3 s (o el primero ≥ 8 s) y cuyos audios ya están transcritos (o han fallado);
  3. genera **una** respuesta que cubre todos esos entrantes (`reply_id` en cada uno) y la
     envía;
  4. atiende hasta 4 conversaciones en paralelo.
  Al arrancar, los pendientes que quedaron sin procesar se retoman con las reglas de R3.
- **Rationale**: FR-004 pide contestar junto lo que llega seguido; SC-003 pide p95 < 10 s
  contados desde el último mensaje e incluida la espera. 3 s de espera dejan ~7 s para leer
  el snapshot, transcribir y generar (R7, R8). Guardar el estado en BD hace el procesamiento
  reanudable y la marca `reply_id` garantiza que cada entrante queda cubierto por exactamente
  una respuesta.
- **Alternatives considered**:
  - *Sin espera*: una respuesta por mensaje, preguntas contestadas dos veces (incumple FR-004).
  - *5 s o más*: agrupa mejor, pero deja demasiado poco margen para SC-003.
  - *Temporizadores solo en memoria*: se pierden al reiniciar.

## R6. Límite de mensajes por número

- **Decision**: **30 mensajes entrantes en una ventana deslizante de 15 minutos** por número.
  Al entrar el mensaje 31 se envía una sola vez un aviso breve con el contacto del negocio
  (FR-016) y ese número no recibe más respuestas hasta que su tasa vuelve a estar bajo el
  límite. Los mensajes por encima del límite se guardan con estado `rate_limited` (cuentan
  para la retención de 30 días) y no se contestan nunca. El aviso se marca en
  `customer.rate_limit_notified_at` para no repetirlo dentro de la misma ventana.
- **Rationale**: una conversación normal (preguntas, aclaraciones, cortesías) no pasa de 10–15
  mensajes en 15 minutos; 30 es holgado y corta bucles con otros bots y envíos masivos. La
  cuenta sale de la tabla de mensajes, sin estado adicional.
- **Alternatives considered**: `@fastify/rate-limit` por IP (los webhooks llegan todos desde
  Meta; el límite tiene que ser por número); ventana fija (permite ráfagas de 2× en el borde).

## R7. Modelo de lenguaje: Claude con salida estructurada

- **Decision**: la interpretación de los mensajes y la redacción del cuerpo de la respuesta
  las hace **Claude** mediante el SDK oficial `@anthropic-ai/sdk`, detrás de un puerto de
  dominio `ChatModel` ([contracts/chat-model.md](contracts/chat-model.md)).
  - Modelo por defecto **`claude-sonnet-5`**, configurable con `LLM_MODEL`;
    `ANTHROPIC_API_KEY` por variable de entorno (decisión del usuario, 2026-09-24).
  - Pensamiento adaptativo (por defecto en Sonnet 5) con **`output_config.effort =
    "medium"`**, configurable con `LLM_EFFORT`. Se ajusta con los datos de la suite `eval` y
    de `latencyMs` en los registros: si falla SC-003 se prueba `low`; si falla calidad,
    `high` u otro modelo.
  - **Salida estructurada** (`output_config.format`, JSON Schema generado del esquema Zod y
    validado de nuevo con Zod al recibirla): cuerpo de la respuesta más banderas
    (`handoffRequested`, `offerContact`, `bookingRequested`, `needsRephrase`…). El código,
    no el modelo, decide el saludo, el bloque de contacto y los avisos fijos (R9).
  - `max_tokens` 4000 (incluye el pensamiento), petición sin streaming, `timeout` 12 s y
    1 reintento del SDK, con un plazo total de 20 s; si se agota, se aplica FR-029.
  - Rechazos de seguridad: `stop_reason: "refusal"` se trata como fallo de generación
    (FR-029, disculpa con contacto). No se usan fallbacks a otro modelo en esta versión.
- **Rationale**: interpretar faltas de ortografía, coloquialismos, preguntas encadenadas
  ("¿y el sábado?") y mezclas de temas (FR-022 – FR-027) requiere un modelo de lenguaje; un
  clasificador por reglas no alcanza SC-004. Separar banderas estructuradas del texto permite
  que las garantías de los Principios IV y V las aplique código determinista y probado.
- **Alternatives considered**:
  - *`claude-opus-5`*: más capaz, pero más lento y más caro para respuestas cortas; queda
    como opción de `LLM_MODEL` si la evaluación muestra errores de interpretación que Sonnet
    no resuelve con más esfuerzo.
  - *`claude-haiku-4-5`*: más rápido y barato; opción si SC-003 no se cumple.
  - *Plantillas deterministas completas (el modelo solo clasifica)*: máxima seguridad, pero
    respuestas rígidas, sin tono y peores con preguntas mixtas; se usa solo para los
    mensajes fijos (R9).
  - *Proveedor de LLM genérico con abstracción multi-proveedor*: el puerto `ChatModel` ya
    permite cambiarlo; no se añade una capa multi-proveedor sin necesidad.

## R8. Cómo se garantiza el Principio IV

- **Decision**: cuatro capas.
  1. **Contexto cerrado**: el modelo recibe solo el snapshot vigente, serializado de forma
     determinista, más **hechos derivados calculados por código**: fecha y hora local
     actuales, día de la semana, si está abierto ahora, franjas efectivas de los próximos 14
     días (`effectiveIntervals` de la 001, con cierres aplicados) y los precios ya
     formateados en la moneda del negocio con su tipo (fijo / "desde" / "a consultar" /
     sin importe). El modelo no calcula horarios ni formatea importes.
  2. **Instrucciones**: solo afirmar lo que está en el contexto; si no está, decirlo y marcar
     `offerContact`; prioridad del dato estructurado sobre las FAQ; los mensajes del cliente
     son datos, nunca instrucciones (FR-026).
  3. **Verificador de cifras** (`grounding guard`, determinista): extrae del cuerpo importes,
     horas, fechas, teléfonos, correos y cualquier número, y comprueba que cada uno figura en
     el conjunto de valores permitidos derivado del snapshot y los hechos calculados. Si
     algo no cuadra, se regenera una vez indicando el problema; si vuelve a fallar, se envía
     la respuesta segura de "no dispongo de esa información" con el contacto. Cada rechazo se
     registra (sin texto).
  4. **Pruebas**: unitarias del verificador y de la composición, y la suite de evaluación con
     el modelo real (R12) para SC-001, SC-002 y SC-004.
- **Rationale**: los errores más dañinos (un precio o un horario inventado) son cifras, y las
  cifras se pueden verificar de forma determinista. Las afirmaciones no numéricas ("hay
  aparcamiento") se cubren con contexto cerrado, instrucciones y evaluación.
- **Alternatives considered**: segunda llamada al modelo como juez (duplica la latencia y
  sigue siendo probabilística); citas del API (incompatibles con la salida estructurada).

## R9. Cómo se garantiza el Principio V y lo que decide el código

- **Decision**: el código compone la respuesta final
  (`saludo? + cuerpo + aviso de archivo? + bloque de contacto?`) con plantillas en español
  con variantes tú/usted ([contracts/bot-replies.md](contracts/bot-replies.md)).
  - **Bloque de contacto** (FR-016): canales del contacto efectivo del snapshot
    (`handoff.channels`) y su horario de atención formateado. Se añade una sola vez si el
    modelo marca `handoffRequested`, `offerContact` o `bookingRequested`, si algún servicio
    citado tiene precio "a consultar" o sin importe, o si el **detector determinista** de
    petición de persona encuentra expresiones genéricas ("hablar con una persona", "con
    alguien", "un humano", "atención al cliente"…). El detector es una red de seguridad: basta
    con que uno de los dos lo detecte.
  - **Saludo** (FR-020): lo pone el código en la primera respuesta de cada conversación, con
    el nombre del negocio y la forma de trato; el modelo recibe la indicación de no saludar.
  - **Mensajes fijos sin modelo**: aviso de límite superado (con contacto), solo texto y
    audios, audio no entendido, disculpa por fallo (FR-029; incluye el contacto si el
    snapshot se pudo leer).
- **Rationale**: SC-005 y SC-008 piden el 100 %; con un modelo solo se alcanza de forma
  probabilística. El código lo garantiza y se prueba con tests unitarios.
- **Alternatives considered**: dejar que el modelo escriba el contacto (puede omitirlo,
  cambiar un dígito o no incluir el horario).

## R10. Audios (desactivados por defecto)

- **Decision**: la atención de audios es un **interruptor por instancia**,
  `AUDIO_TRANSCRIPTION=on|off`, por defecto `off` (FR-028, decisión de negocio). Con `off`
  el audio se guarda como `kind = other` (`other_type = audio`), no se descarga y recibe el
  aviso de "solo texto" (FR-028a); no hace falta ninguna clave de transcripción. Con `on`,
  `STT_API_KEY` pasa a ser obligatoria y se aplica lo siguiente.
- **Diseño para cuando se active**: puerto `SpeechToText` con un adaptador sobre la **API de
  transcripción de OpenAI** (`whisper-1`, configurable con `STT_MODEL`; clave
  `STT_API_KEY`), llamada con `fetch` + `FormData` de Node 22, sin SDK adicional.
  - El audio se descarga de la Graph API en cuanto llega, **en paralelo con la espera de
    agrupado**, y se transcribe en memoria; nunca se escribe en disco ni en BD (asunción de
    la spec). Solo se guarda el texto.
  - Límites: 2 MB de fichero y 120 s de duración (la notificación de voz típica ocupa
    ~15 KB/10 s). Por encima, o si la transcripción falla, sale vacía o no está en español
    (idioma detectado ≠ `es`), el audio se trata como no entendido (FR-028).
  - Timeout de transcripción 10 s; el procesador no espera a un audio más de ese tiempo.
- **Rationale**: Claude no acepta audio como entrada, así que hace falta un servicio de voz a
  texto. Whisper es maduro en español coloquial y devuelve el idioma detectado, necesario para
  aplicar la asunción de idioma. El puerto permite cambiar de proveedor sin tocar el dominio.
- **Alternatives considered**:
  - *Whisper local (whisper.cpp / faster-whisper)*: sin tercero, pero multiplica CPU y
    memoria de cada contenedor de instancia y su latencia en CPU no cabe en SC-003.
  - *Otros servicios (Deepgram, ElevenLabs Scribe, Google STT)*: equivalentes; se pueden
    añadir como adaptadores.
- **Riesgo**: con los audios activados, el audio del cliente sale a un tercero más. Antes de
  activarlo, el operador necesita el contrato de encargado del tratamiento con ese proveedor
  (igual que con Meta y Anthropic). Queda anotado en el quickstart y en el README.
- **Alcance de la implementación**: el interruptor, el camino desactivado y el adaptador se
  implementan y prueban en esta feature (con `SpeechToText` falso); la suite `eval` de audios
  (SC-009, parte de audios) solo se ejecuta cuando se decida activarlos.

## R11. Retención y registros técnicos

- **Decision**:
  - **Borrado automático** (FR-030): tarea en el propio proceso cada hora que borra en una
    transacción las conversaciones con `last_message_at` anterior a hace 30 días (sus
    mensajes caen por `ON DELETE CASCADE`) y después los clientes sin conversaciones. Margen
    declarado para SC-011: **24 horas** (cubre ejecuciones horarias y reinicios).
  - **Registros** (FR-030a): eventos estructurados con el logger de Fastify (pino), catálogo
    cerrado en [contracts/activity-log.md](contracts/activity-log.md). Nunca incluyen el
    texto de mensajes ni respuestas. El número aparece como **seudónimo**
    `HMAC-SHA256(teléfono)` truncado a 12 caracteres hex, con una clave derivada por HKDF de
    `SESSION_SECRET` (sin secreto nuevo); así se correlacionan eventos del mismo cliente sin
    poder revertirlo.
- **Rationale**: 30 días es lo que fijó la clarificación; una tarea horaria es trivial y no
  requiere `pg_cron` ni un contenedor aparte. El seudónimo cumple "enmascarado o
  seudonimizado" y es más útil que un enmascarado parcial para investigar incidencias.
- **Alternatives considered**: `pg_cron` (extensión adicional en cada BD); registrar el número
  enmascarado (`+34******678`), ambiguo entre clientes.

## R12. Pruebas y evaluación

- **Decision**: además de las tres suites existentes, una cuarta, **`eval`**, opcional y
  fuera de `pnpm test`:
  - `unit`: verificador de cifras, detector de petición de persona, composición y plantillas,
    hechos derivados (hora actual con zona horaria y cierres), reglas de conversación y
    límite, parser del webhook.
  - `contract`: webhook con `fastify.inject` (firma, verificación del alta, duplicados,
    estados, grupos, negocio en preparación).
  - `integration` (Testcontainers, `ChatModel`, `SpeechToText` y `ChannelSender` falsos,
    reloj controlable): agrupado, una respuesta por entrante, límite, retrasos, reanudación
    tras reinicio, borrado a 30 días, frescura de datos entre turnos, registros sin texto.
  - `eval` (`pnpm test:eval`, requiere `ANTHROPIC_API_KEY`; `STT_API_KEY` solo para
    `pnpm test:eval -- audio`): juegos de preguntas contra el modelo real con los negocios de
    ejemplo de tres sectores de `tests/fixtures/`, que miden SC-001, SC-002, SC-004, SC-006 –
    SC-010. Sus resultados son requisito para dar la feature por terminada, no para cada
    commit (coste y no determinismo). Se ejecuta desde la máquina del desarrollador (o un job
    manual de CI) con una clave de API propia de evaluación, separada de las de producción.
- **Rationale**: la constitución exige pruebas de IV y V antes de terminar la feature; las
  garantías deterministas se prueban en CI y las lingüísticas solo pueden medirse con el
  modelo real.

## R13. Idioma de atención

- **Decision**: en esta versión el idioma de atención es el **español**: las plantillas del
  código están en español y el modelo responde en español aunque el cliente escriba en otro
  idioma (edge case de la spec). La 001 no registra un idioma y su asunción es que la
  información está en el idioma de atención.
- **Rationale**: todos los clientes previstos atienden en español y CLAUDE.md fija los
  mensajes en español. Atender otro idioma será una ampliación genérica del núcleo (campo de
  idioma más catálogo de plantillas), con su propia spec.

## R14. Herramienta de prueba local

- **Decision**: comando `pnpm bot:chat` que conversa en la terminal con el bot de la
  instancia local usando la misma cadena (recepción → espera → respuesta) con un
  `ChannelSender` de consola, sin WhatsApp. Opción `--as <número>` para simular clientes y
  `--flood <n>` para enviar `n` mensajes seguidos y probar el límite por número.
- **Rationale**: permite validar escenarios del quickstart sin número de Meta ni túnel.

---

## Resumen de decisiones

| Tema | Resolución |
|------|------------|
| Canal | WhatsApp Cloud API directa; credenciales por variables de entorno (R1) |
| Recepción | Webhook firmado, persistir y acusar; procesamiento asíncrono (R2) |
| Estado y retrasos | Descartar en preparación sin guardar; ventana de 24 h al procesar (R3) |
| Conversación | Nueva tras 24 h sin mensajes del cliente; contexto de 30 mensajes (R4) |
| Espera de agrupado | 3 s sin mensajes, tope 8 s; cola en PostgreSQL con `SKIP LOCKED` (R5) |
| Límite por número | 30 mensajes / 15 min deslizantes; aviso único con contacto (R6) |
| Modelo | Claude `claude-sonnet-5`, effort `medium`, salida estructurada (R7) |
| Principio IV | Contexto cerrado + hechos calculados + verificador de cifras + evaluación (R8) |
| Principio V | Contacto y saludo compuestos por código; detector determinista de respaldo (R9) |
| Audio | Desactivado por defecto (`AUDIO_TRANSCRIPTION=off`); si se activa, Whisper (API) tras un puerto; 2 MB / 120 s; nada se guarda (R10) |
| Retención | Borrado horario a 30 días, margen de 24 h (R11) |
| Registros | Eventos pino sin texto, número seudonimizado con HMAC (R11) |
| Pruebas | unit / contract / integration + suite `eval` con el modelo real (R12) |
| Idioma | Español en esta versión (R13) |
| Rendimiento | SC-003: 3 s de espera + ~7 s para transcribir y generar; medido en `eval` e integración |
