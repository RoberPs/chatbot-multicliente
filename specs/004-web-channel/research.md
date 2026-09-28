# Research: Canal web del bot de atención

**Feature**: `004-web-channel` | **Fecha**: 2026-09-25 | **Plan**: [plan.md](plan.md)

El stack está fijado por la 001 y la 002 (TypeScript strict, Node 22, Fastify 5, PostgreSQL 16
+ Drizzle, Zod, Eta + htmx, Vitest + Testcontainers, Claude por `@anthropic-ai/sdk`). Aquí se
decide cómo generalizar el núcleo de conversación a varios canales sin cambiar WhatsApp, cómo
se construye la página "Probar el bot" y cómo se publica un chat anónimo en webs de terceros
con límites y protección. Cada decisión se contrasta con la constitución (v1.1.0), en especial
la restricción "Canales" y los Principios IV y V.

---

## R1. Modelo de canales en el dominio

- **Decision**: un tipo cerrado `Channel = 'whatsapp' | 'web' | 'playground'` en
  `src/conversation/channels.ts`. El cliente final se identifica por `(channel,
  channel_user_id)` (FR-001):
  - `whatsapp`: el teléfono E.164, como hoy.
  - `web`: `SHA-256` del identificador de sesión del navegador (R4); nunca el token en claro.
  - `playground`: un UUID aleatorio por conversación de prueba del operador (R6).

  Lo que cambia entre canales se concentra en una **política de canal** (`ChannelPolicy`) que
  el procesador y la recepción consultan, en vez de ramas por canal repartidas por el código:

  | Regla | `whatsapp` | `web` | `playground` |
  |-------|-----------|-------|--------------|
  | Entrega (`ChannelSender`) | Graph API | guardada; el navegador la recoge (R5) | guardada; el panel la recoge |
  | Ventana de 24 h para responder (FR-002a de la 002) | sí | no (FR-003) | no |
  | Exige negocio activo | sí | sí (FR-022) | no (FR-011) |
  | Exige chat web activado | no | sí (FR-022) | no |
  | Tope de uso diario/mensual | no | sí (FR-026) | no (FR-012) |
  | Límite por cliente (30 / 15 min) | sí | sí (FR-024) | sí |
  | Tipos de mensaje | texto, audio, otros, grupos | solo texto (FR-020) | solo texto |

  El resto de la cadena (agrupado, snapshot sin caché, hechos calculados, modelo, verificador,
  plantillas, saludo, contacto, registros) es un único código para los tres (FR-002).
- **Rationale**: la tabla hace explícito y comprobable qué es propio de cada canal (FR-002,
  FR-003) y deja el comportamiento de WhatsApp idéntico: sus valores de la política son los que
  hoy están fijos en el código (FR-004, SC-001). Un canal nuevo en el futuro es una fila más y
  un adaptador, sin tocar el responder.
- **Alternatives considered**:
  - *Tabla `customer` separada por canal (`web_visitor`, …)*: duplica recepción, límite y
    retención, y rompe la regla de una sola cadena. Descartado.
  - *Canal como texto libre*: pierde la comprobación de tipos y el `CHECK` de la BD.
  - *Tratar el playground como `web` con una bandera*: mezclaría pruebas con clientes reales en
    topes y cifras de uso, justo lo que prohíbe FR-012.

## R2. Migración de datos existentes (FR-005)

- **Decision**: migración `0002_channels` sin copiar datos:
  - `customer`: nuevo enum `customer_channel`; `ALTER TABLE customer RENAME COLUMN phone TO
    channel_user_id`; `ADD COLUMN channel customer_channel NOT NULL DEFAULT 'whatsapp'` (rellena
    las filas existentes) y después `DROP DEFAULT`; se sustituye el `UNIQUE(phone)` por
    `UNIQUE(channel, channel_user_id)`.
  - `message`: `RENAME COLUMN wa_message_id TO channel_message_id` (con su restricción única) y
    `ADD COLUMN reply_trace jsonb` (R7).
  - Tablas nuevas `web_chat_settings` y `web_usage_day` (R8, R9).
- **Rationale**: renombrar y añadir con valor por defecto conserva todas las filas, ids,
  estados y relaciones sin pasos de copia (FR-005). Se prueba con un test de integración que
  carga datos con el esquema `0001`, aplica `0002` y comprueba conversaciones, mensajes y
  estado intactos.
- **Alternatives considered**: *tabla nueva `channel_identity` enlazada a `customer`*: más
  flexible para relacionar identidades entre canales, que está fuera de alcance; añade un
  `JOIN` a cada consulta sin beneficio hoy.

## R3. Arquitectura del chat web público: `<script>` + `<iframe>` propio

- **Decision**: el fragmento que el negocio pega es una sola línea
  `<script src="https://<instancia>/chat/widget.js" defer></script>` (FR-016). `widget.js`
  (≈ 2 KB, sin dependencias) solo crea un `<iframe>` fijo en una esquina que apunta a
  `https://<instancia>/chat/frame`, y lo agranda o encoge cuando el iframe se lo pide por
  `postMessage` (comprobando el origen del mensaje). Toda la interfaz del chat (botón, aviso,
  mensajes, caja de texto) vive **dentro del iframe**, servida por la instancia.
  - La página del iframe envía `Content-Security-Policy: frame-ancestors <webs permitidas>`
    (o `'none'` si el chat está desactivado): es el navegador el que impide mostrar el chat
    fuera de las webs permitidas (FR-015, US2 escenario 4).
  - El iframe llama a la API `/chat/api/*` de su propio origen: no hace falta CORS. La API solo
    acepta peticiones con `Origin` igual al de la instancia y `Sec-Fetch-Site: same-origin`
    cuando el navegador lo envía; una web ajena que llame a la API directamente recibe `403`
    sin que se guarde nada (FR-027).
  - Al cargar el frame se comprueba además el origen del `Referer` (los navegadores envían
    el origen por defecto) contra la lista; si llega y no está permitido, se sirve la vista
    "no disponible" sin crear sesión.
  - Mensajes del visitante y del bot se pintan con `textContent`, nunca con HTML (FR-020,
    edge case de contenido con código). CSP del frame: `script-src 'self'`, sin inline,
    `connect-src 'self'`.
- **Rationale**: el iframe aísla el chat de la web del negocio en los dos sentidos: los estilos
  y scripts de la web no rompen el chat, y nada de lo que escriba un visitante puede
  ejecutarse en la web del negocio. `frame-ancestors` es la forma estándar y aplicada por el
  navegador de restringir dónde se inserta. Al ser mismo origen, la API no necesita cookies de
  terceros ni CORS.
- **Alternatives considered**:
  - *Widget que pinta el chat directamente en el DOM de la web del negocio y llama a la API
    con CORS*: los estilos del negocio lo rompen, el contenido del visitante entra en el DOM
    del negocio (superficie de XSS) y la comprobación de `Origin` queda como única barrera.
  - *Enlace a una página de chat completa (sin insertar)*: más simple, pero no cumple "un chat
    que el negocio inserta en su propia web".
  - *Web Components con Shadow DOM*: aísla estilos, pero no scripts ni CSP.

## R4. Sesión anónima del visitante (FR-018, FR-019, FR-029)

- **Decision**: token de sesión **firmado por la instancia**, sin tabla de sesiones:
  - `POST /chat/api/session` devuelve `token = base64url(id aleatorio de 16 bytes) + "." +
    base64url(HMAC-SHA256(id))`, con clave derivada por HKDF de `SESSION_SECRET`
    (`info = "web-session"`, R11 de la 002).
  - El iframe lo guarda en `localStorage` (particionado por web del negocio en los navegadores
    actuales) y lo envía en la cabecera `Authorization: Bearer <token>`; nunca en la URL ni en
    una cookie.
  - El servidor verifica la firma y usa `channel_user_id = hex(SHA-256(id))`. La BD no guarda
    el token ni nada que permita reconstruirlo.
  - Sin almacenamiento disponible (modo privado), el token vive en memoria de la página: la
    conversación no se conserva al recargar (edge case).
  - Varias pestañas comparten `localStorage` y, por tanto, sesión y conversación; la
    deduplicación (R5) evita respuestas duplicadas.
  - Continuidad: la sesión no caduca por sí misma; la conversación sí (24 h sin mensajes del
    visitante, FR-019, misma regla de la recepción que en WhatsApp). La retención borra las
    conversaciones y el cliente web a los 30 días (FR-028).
- **Rationale**: pedir la sesión al servidor hace que crear sesiones cueste una petición
  limitada por origen (FR-025): sin eso, un cliente podría inventarse identificadores y
  esquivar el límite por visitante. La firma evita guardar sesiones que nunca escriben. Al ir
  en cabecera y no en cookie, no hay CSRF posible ni dependencia de cookies de terceros (que
  Safari y Chrome bloquean en iframes).
- **Alternatives considered**:
  - *Cookie `SameSite=None; Partitioned` en el iframe*: soporte desigual y consentimiento
    más discutible; además obliga a CSRF.
  - *Identificador generado por el navegador*: gratis de falsificar y multiplicar.
  - *Tabla `web_session`*: guarda más datos de los necesarios (FR-029) sin aportar nada que
    la firma no dé.
  - *Cambiar `SESSION_SECRET` como forma de revocar*: aceptado como efecto: invalida las
    sesiones web y cada visitante empieza una conversación nueva.

## R5. Entrega de respuestas en la web: sondeo corto mientras se espera

- **Decision**: las respuestas web y del playground se **guardan** como salientes `sent` en el
  momento de generarse (el `ChannelSender` de estos canales no llama a nada externo) y el
  cliente las recoge:
  - Tras enviar un mensaje, el iframe consulta `GET /chat/api/messages?after=<cursor>` cada
    1,5 s mientras espera, mostrando "escribiendo…" (FR-021), y deja de consultar al recibir
    la respuesta. Tras 45 s sin respuesta muestra la disculpa con el contacto que ya tiene de
    `GET /chat/api/state` (FR-021: fallo sin respuesta).
  - Al abrir o recargar, `GET /chat/api/messages` devuelve los mensajes de la conversación
    vigente (menos de 24 h), así que el visitante ve su historial y lo que llegó mientras
    estaba desconectado (edge case "conexión cortada", US3 escenario 5).
  - Cada mensaje del visitante lleva un `clientMessageId` (UUID del navegador); se guarda como
    `channel_message_id = "web:" + channel_user_id + ":" + clientMessageId`, con la misma
    restricción única que deduplica WhatsApp. Reintentos y varias pestañas no duplican nada
    (FR-023).
  - La espera de agrupado de 3 s y el tope de 8 s son los de la 002 (US3 escenario 3).
- **Rationale**: reutiliza sin cambios la cola persistente de la 002 (espera, reclamación con
  `SKIP LOCKED`, reanudación tras reinicio): la web solo añade cómo se lee el resultado. El
  sondeo solo ocurre mientras hay una respuesta en camino (unos 5 s de media), así que la
  carga es despreciable para decenas de visitantes simultáneos y no necesita conexiones
  abiertas ni configuración especial en el proxy.
- **Alternatives considered**:
  - *Server-Sent Events / WebSocket*: menos latencia de entrega (≤ 1,5 s de diferencia, dentro
    de SC-004), a cambio de conexiones largas, tiempos de espera del proxy y reconexión.
    Pueden sustituir al sondeo más adelante sin cambiar el dominio.
  - *Responder dentro de la misma petición `POST`*: rompe el agrupado de varios mensajes
    seguidos y deja la petición abierta 3–10 s.

## R6. Página "Probar el bot" (US1)

- **Decision**: página del panel `/admin/playground` con htmx, sobre el canal `playground`:
  - El id de la conversación de prueba (UUID) se guarda en la sesión cifrada del operador;
    "Nueva conversación" genera otro (FR-010) y el anterior queda sin uso hasta que lo borre
    la retención (FR-012).
  - `POST /admin/playground/messages` (con CSRF, FR-013) pasa el texto por la **misma
    recepción y el mismo procesador** que los demás canales (FR-008) y devuelve el mensaje del
    operador más un elemento que consulta cada segundo `GET /admin/playground/messages?after=`
    hasta que llega la respuesta, con su información técnica (FR-009, R7).
  - Funciona con el negocio "en preparación" (política del canal, R1) y lo indica con un aviso
    fijo en la página (FR-011).
  - Sin `ANTHROPIC_API_KEY` la página explica que falta la clave del modelo y no deja escribir.
- **Rationale**: pasar por la cola real (y no llamar al responder directamente) es lo que
  garantiza que el operador ve exactamente lo que vería un cliente, incluida la espera de
  agrupado y la continuidad de la conversación (US1 escenarios 2 y 4).
- **Alternatives considered**: *llamar al responder de forma síncrona desde la ruta*: más
  rápido de construir, pero se salta el agrupado, el historial guardado y el saludo por
  conversación, y dejaría de ser "la misma cadena".

## R7. Información técnica de cada respuesta (FR-009)

- **Decision**: el responder devuelve, además de lo que ya devuelve (`template`,
  `contactBlock`, `greeting`, `modelMs`), `contactReason` y `groundingRejections`, y el
  procesador guarda un **`reply_trace`** (`jsonb`) en cada saliente, en todos los canales:

  ```json
  { "template": "R-SAFE" | null, "greeting": true,
    "contact": { "added": true, "reason": "handoff_requested" },
    "groundingRejections": 1, "modelMs": 3200, "latencyMs": 6100 }
  ```

  `reason` ∈ `handoff_requested` · `offer_contact` · `booking_requested` ·
  `price_on_request` · `template`. `needsContact` pasa a devolver el motivo (o `null`) en vez de
  un booleano, con la misma precedencia que hoy. Nunca se guardan los valores rechazados por el
  verificador. Solo la página de pruebas lo muestra.
- **Rationale**: el procesador es asíncrono; la página lee el resultado después, así que tiene
  que quedar guardado. No contiene datos personales ni textos, y se borra con la conversación
  (FR-012, FR-028). Guardarlo en todos los canales mantiene una sola ruta de código y sirve
  para diagnosticar.
- **Alternatives considered**: *sacarlo de los registros técnicos*: los registros van al
  logger, no a la BD, y no están pensados para leerse desde el panel.

## R8. Configuración del chat web (FR-014 – FR-016, FR-026)

- **Decision**: tabla singleton `web_chat_settings` gestionada desde `/admin/web-chat`:
  `enabled` (por defecto `false`), `allowed_origins text[]`, `privacy_url`, `daily_cap`
  (200), `monthly_cap` (3 000). Validación con Zod en `src/webchat/schemas.ts`:
  - Origen = esquema + host + puerto (sin ruta); `https` obligatorio salvo `http://localhost`
    y `http://127.0.0.1` para pruebas; máximo 10; se normalizan a minúsculas y sin barra.
  - `privacy_url`: URL `https` absoluta.
  - Topes: enteros ≥ 1, con `monthly_cap ≥ daily_cap`.
  - Activar exige al menos un origen y la URL de privacidad (FR-015, US2 escenario 2); el
    formulario explica qué falta.
  - No forma parte del `KnowledgeSnapshot` ni pasa por `computeWarnings`: es configuración del
    canal, no información del negocio que el bot pueda decir.
- **Rationale**: es configuración por instancia que el operador cambia sin desplegar
  (Principio II) y solo el operador (Principio VI). Leerla de la BD en cada petición sigue la
  regla de la casa de no cachear.
- **Alternatives considered**: *variables de entorno*: obligarían a redesplegar para activar
  o cambiar una web permitida, y el operador no podría hacerlo desde el panel.

## R9. Topes de uso diario y mensual (FR-026, FR-026a)

- **Decision**: tabla `web_usage_day(day date PK, replies int)` con el día **en la zona
  horaria del negocio**. Cada saliente del canal `web` generado por la cadena suma 1 en la
  misma transacción que lo guarda. El mes es la suma de los días del mes local.
  - La recepción web comprueba los topes antes de guardar: si se ha alcanzado alguno, no guarda
    el mensaje y devuelve `unavailable: quota` con el contacto (US4 escenario 3).
  - El procesador vuelve a comprobarlos antes de llamar al modelo (los mensajes aceptados justo
    antes de llegar al tope): si ya se ha alcanzado, contesta con la plantilla fija
    **R-UNAVAILABLE** (sin modelo, con contacto) y esa respuesta no cuenta. Así ningún mensaje
    genera una llamada al modelo con el tope alcanzado (SC-006).
  - El panel muestra el uso del día y del mes frente a los topes en `/admin/web-chat`, y un
    aviso en la portada cuando se ha alcanzado alguno (FR-026, FR-026a).
  - Filas de más de 400 días se borran con la retención.
- **Rationale**: un contador propio no depende de la retención de conversaciones (que borraría
  cuentas del mes) y no guarda datos personales. Contar en la zona del negocio sigue la
  convención de no pasar a UTC.
- **Alternatives considered**: *contar salientes en `message`*: la retención de 30 días y las
  conversaciones borradas lo falsean a final de mes; *coste en euros*: descartado en la
  clarificación de la spec.

## R10. Límites por origen de red (FR-025, FR-029)

- **Decision**: `@fastify/rate-limit` (ya es dependencia) con almacén **en memoria** y clave
  `request.ip` (con `TRUST_PROXY`, como el login):
  - Sesiones nuevas: **20 por hora** por IP en `POST /chat/api/session`.
  - Mensajes: **120 cada 15 min** por IP en `POST /chat/api/messages` (cuatro visitantes al
    límite individual de 30; holgado para oficinas y datos móviles con IP compartida).
  - Al superarlo: `429` con el contacto de derivación en el cuerpo; nada se guarda y el modelo
    no se llama. El iframe lo muestra una vez y deja de enviar hasta la hora indicada en
    `Retry-After`.
  - Resto de la API del chat (estado y lectura): 600 cada 15 min por IP, solo contra abuso.
  - La IP nunca se escribe en la BD ni en los registros: el serializador de peticiones del
    logger de Fastify deja de incluir `remoteAddress` y `remotePort` en toda la app (SC-008).
- **Rationale**: una instancia es un proceso, así que la memoria basta y evita guardar IP.
  Tras un reinicio los contadores empiezan de cero, lo que solo relaja el límite un rato; el
  tope por instancia (R9) sigue acotando el coste.
- **Alternatives considered**: *contadores en PostgreSQL*: guardaría la IP (o un hash
  reversible por fuerza bruta en IPv4) junto a datos de la instancia, contra FR-029; *CAPTCHA*:
  fricción para el cliente y un tercero más; queda como opción si se ve abuso real.

## R11. Arranque del bot sin WhatsApp

- **Decision**: el bot (recepción, procesador, retención) se crea cuando hay
  `ANTHROPIC_API_KEY`; WhatsApp pasa a ser un canal opcional dentro de él. Cambios en el
  entorno:
  - `EMERGENCY_CONTACT_PHONE` pasa a ser obligatoria **con `ANTHROPIC_API_KEY`** (antes: con
    WhatsApp), porque la web también la necesita cuando no se puede leer el snapshot (FR-022).
  - `ANTHROPIC_API_KEY` sigue siendo obligatoria con WhatsApp.
  - Nueva `PUBLIC_BASE_URL` opcional (URL `https` de la instancia) para escribir el fragmento
    del chat; sin ella se toma del origen de la petición del panel.
  - Sin `ANTHROPIC_API_KEY`: sin bot; el panel funciona, "Probar el bot" lo explica y el chat
    web muestra "no disponible" con el contacto.
- **Rationale**: hoy sin WhatsApp no hay bot, y precisamente el objetivo es poder usarlo sin
  Meta. Exigir el contacto de emergencia con el modelo mantiene el Principio V en todos los
  canales.
- **Alternatives considered**: *interruptor `WEB_CHANNEL=on` en el entorno*: duplicaría el
  interruptor del panel (R8), que es donde la spec pone la activación.

## R12. Registros técnicos por canal (FR-006, FR-028, SC-008)

- **Decision**: todos los eventos con cliente llevan un campo nuevo `via` (`whatsapp` · `web`
  · `playground`); el campo `channel: "bot"` existente se mantiene como categoría del logger.
  El seudónimo `customer` pasa a calcularse sobre `channel + ":" + channel_user_id` (para la
  web ya es un hash; se vuelve a pasar por el HMAC). Eventos nuevos en
  [contracts/activity-log.md](contracts/activity-log.md): `web_rejected`,
  `web_session_created`, `web_quota_reached`; `message_discarded` añade `quota` y `disabled`;
  `reply_sent` añade `groundingRejections`.
- **Rationale**: saber el canal de cada evento sin aumentar lo que se registra de la persona.
  Cambiar la entrada del HMAC evita que el mismo valor en dos canales dé el mismo seudónimo.
  Consecuencia asumida: los seudónimos de WhatsApp cambian una vez al desplegar.
- **Alternatives considered**: *renombrar `channel`*: rompería consultas de registros ya
  existentes.

## R13. Mismo comportamiento en todos los canales (SC-001, SC-002)

- **Decision**:
  - `InboundEvent` se generaliza (`channel`, `channelUserId`, `channelMessageId`, …); el
    adaptador de WhatsApp lo rellena igual que hoy. Los tests de la 002 se adaptan solo en la
    construcción de eventos y en los nombres de columnas; sus aserciones no cambian (SC-001).
  - Un test de integración parametrizado envía la misma conversación por los tres canales con
    el modelo falso y compara textos, plantillas, saludo, contacto y eventos (salvo `via`).
  - El arnés de `eval` acepta el canal (`EVAL_CHANNEL=web`) y la suite se ejecuta también con `web` para los
    criterios SC-001, SC-002 y SC-005 a SC-008 de la 002 (SC-002 de esta spec).
- **Rationale**: la igualdad entre canales se comprueba en CI con el modelo falso y se
  confirma con el modelo real fuera de CI, igual que en la 002.

## R14. Duración del sondeo y medición de latencia (SC-003, SC-004)

- **Decision**: latencia en la web = desde el último mensaje del grupo hasta que la respuesta
  queda guardada (`reply_sent.latencyMs`, como en WhatsApp) más el intervalo de sondeo
  (≤ 1,5 s; ≤ 1 s en el playground). Presupuesto: 3 s de espera + p95 del modelo ≈ 5 s +
  1,5 s ⇒ < 10 s. El test de latencia de la 002 se amplía al canal `web`.

---

## R15. Enlaces pulsables en las respuestas del bot (FR-020a, enmienda 2026-09-28)

- **Decision**: una misma regla, implementada dos veces con la misma tabla de casos:
  `src/admin/message-links.ts` (servidor, para "Probar el bot") y
  `src/channels/web/assets/links.js` (navegador, para el chat web; se carga antes de
  `frame.js` y expone `window.ChatLinks.split`). La regla parte el texto en trozos
  `{ text, href? }`:
  - Candidato: `https://` seguido de caracteres que no sean espacio ni `< > " ' )`, sin
    distinguir mayúsculas en el esquema. Se corta donde lo hace el verificador de cifras
    (`grounding.ts`), así que el enlace pulsable es el mismo que el verificador dio por bueno.
  - Se quitan del final los signos que cierran la frase y no forman parte del enlace:
    `. , ; : ! ? ] } »` (por ejemplo, "aquí: https://maps.example.com/abc.").
  - Solo es enlace si `new URL()` lo acepta con protocolo `https:`, un dominio con punto y sin
    usuario ni contraseña: la misma comprobación que el campo "Enlace a mapa" de la 003 (R7).
    Si no, el trozo queda como texto.
  - `http://`, `mailto:`, teléfonos y dominios sin esquema no se enlazan.
  - Solo en mensajes del bot. Los del visitante (y los del operador en "Probar el bot") no
    pasan por la regla.
  - El `<a>` lleva `target="_blank"` y `rel="noopener noreferrer nofollow"`, y su texto es el
    enlace tal cual.
  - En el chat web el `<a>` se crea con `createElement`, `href` y `textContent`; sigue sin
    usarse `innerHTML` ni similares (garantía 9 del contrato). En el panel, la plantilla Eta
    escribe cada trozo con `<%= %>`, que escapa.
- **Rationale**: es lo que ya hace WhatsApp con los enlaces del bot, y el caso que lo motiva es
  el enlace a mapa de la 003. Limitarlo a `https://` y a las respuestas del bot deja fuera los
  enlaces que pueda escribir un visitante y cualquier `javascript:`/`data:`. Los assets del
  chat son JavaScript de navegador sin paso de compilación, así que no pueden importar el
  módulo del servidor: la duplicación se controla con una sola tabla de casos que se ejecuta
  contra las dos implementaciones.
- **Alternatives considered**:
  - *Que la API devuelva los trozos ya partidos*: cambia el contrato de
    `GET /chat/api/messages` y no evita la regla en el panel.
  - *Enlazar también lo que escribe el visitante*: no aporta nada al visitante y abre la puerta
    a que el chat muestre como enlace texto ajeno al negocio.
  - *Librería de autoenlazado (linkifyjs…)*: dependencia nueva en el navegador para una regla
    de pocas líneas.

## Tabla de decisiones

| Tema | Decisión |
|------|----------|
| Canales | `whatsapp` · `web` · `playground`, con `ChannelPolicy` (R1) |
| Identidad | `(channel, channel_user_id)`; web = SHA-256 del id de sesión (R1, R4) |
| Migración | `0002_channels`: renombrar y añadir columnas, sin copias (R2) |
| Chat público | `widget.js` + iframe propio con `frame-ancestors` (R3) |
| Sesión web | Token firmado HMAC, en `localStorage`, cabecera `Authorization` (R4) |
| Entrega web | Saliente guardado + sondeo 1,5 s mientras se espera (R5) |
| Pruebas | `/admin/playground` con htmx sobre la cola real (R6) |
| Info técnica | `reply_trace jsonb` en cada saliente (R7) |
| Configuración | `web_chat_settings` en el panel, desactivado por defecto (R8) |
| Topes | `web_usage_day` en hora local; 200/día y 3 000/mes por defecto; R-UNAVAILABLE (R9) |
| Límite por IP | 20 sesiones/h y 120 mensajes/15 min, en memoria (R10) |
| Longitud máxima | 1 000 caracteres por mensaje web; cuerpo JSON ≤ 8 KB |
| Arranque | Bot con `ANTHROPIC_API_KEY`; `EMERGENCY_CONTACT_PHONE` obligatoria con ella; `PUBLIC_BASE_URL` opcional (R11) |
| Registros | Campo `via`, eventos `web_*`, sin IP en los registros de peticiones (R12) |
| Enlaces | Solo `https://` en respuestas del bot, pestaña nueva, sin `innerHTML`; `links.js` + `message-links.ts` con una tabla de casos común (R15) |
