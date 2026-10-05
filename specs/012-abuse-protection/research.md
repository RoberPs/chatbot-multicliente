# Research: Protección frente a abuso y saturación

**Feature**: 012-abuse-protection · **Fecha**: 2026-10-05 · **Ámbito**: núcleo

Cada decisión parte del código actual (auditoría completa del 2026-10-05, guía de operación §11.6).
Las referencias `Rn` las usan el plan, el modelo de datos y los contratos.

---

## R1. «Producción» y estado de protección único

- **Decision**: «producción» es `NODE_ENV=production` (ya existe y lo comprueba `instance:check`).
  Todo lo que decide si un canal de clientes finales puede usar el modelo se reúne en un módulo de
  dominio nuevo, `src/usage/protection.ts`, con una función `protectionState(tx, input)` que
  devuelve el **estado de protección** (calculado, nunca guardado): motivos de «solo contacto»
  (`cap_disabled`, `model_unpriced`, `stt_unpriced`, `spend_unreadable`), nivel del tope de gasto
  (010), tope diario de WhatsApp alcanzado y contadores de derivación del día. Lo consultan el
  procesador, la recepción, la transcripción, la disponibilidad del chat web, el panel y `/health`.
- **Rationale**: hoy cada sitio comprueba el tope por su cuenta (`checkSpendCap` en intake,
  procesador y disponibilidad). Con cuatro motivos nuevos, repetir las reglas en cada sitio haría
  fácil que uno se quede sin aplicar alguno; una sola función se prueba una vez con su tabla de
  casos.
- **Alternatives considered**: una variable `REQUIRE_SPEND_CAP` independiente de `NODE_ENV`
  (rechazada: otra variable que olvidar; la spec define producción por el entorno); ampliar
  `spendCapState` sin módulo nuevo (rechazada: mezcla el nivel del tope con reglas de producción y
  de canal).

## R2. Falla cerrado: lectura con plazo y sin caché

- **Decision**: `protectionState` hace **una consulta** (ajustes, gasto del mes, existencia de precio
  para `LLM_MODEL` y, con audios, para `STT_MODEL`, respuestas de WhatsApp del día) con un plazo de
  **2 s** (`PROTECTION_READ_TIMEOUT_MS`). Si la consulta falla o vence, el estado es
  `{ contactOnly: ['spend_unreadable'] }` en cualquier entorno y se registra
  `protection_read_failed` (con `errorClass`, sin datos) una vez por minuto como mucho. Sin caché
  (FR-004, 010 FR-020).
- **Rationale**: la spec exige fallar cerrado aunque no se pueda leer si el tope está activo; leer
  los ajustes forma parte de la misma consulta, así que «no se pudo leer» siempre lleva a contacto.
  El límite de un evento por minuto evita inundar el registro durante una caída de la BD.
- **Alternatives considered**: reutilizar el último estado leído (rechazada: es una caché y abre la
  puerta a gastar con datos viejos); fallar cerrado solo con el tope activo (imposible de saber
  sin leer).

## R3. Avisos críticos de protección fuera de `computeWarnings`

- **Decision**: las condiciones de FR-001 y FR-008 se expresan como avisos críticos de **instancia**
  (`SPEND_CAP_REQUIRED`, `MODEL_UNPRICED`, `STT_MODEL_UNPRICED`) que calcula
  `protectionWarnings(state)` a partir del estado de protección. Se muestran en todas las pantallas
  del panel (banda común del layout, como el aviso de gasto de la 010) y en la lista de avisos del
  inicio; `activateBusiness` los comprueba además de `computeWarnings` y rechaza la activación con
  `ActivationBlockedError`. **No** entran en `guardedTransaction`.
- **Rationale**: `computeWarnings(state)` es una función pura del conocimiento del negocio y su
  regla (revertir cualquier escritura con un crítico si el negocio está activo) bloquearía todas las
  ediciones del panel de una instancia recién actualizada sin tope, justo cuando el operador tiene
  que poder trabajar. El tope se arregla en «Consumo», que no es una escritura protegida.
- **Alternatives considered**: meterlos en `KnowledgeState` vía `LoadStateOptions` como las vías de
  aviso (rechazada por el bloqueo de todas las escrituras); un aviso normal (rechazada: la spec pide
  crítico que impida activar).
- **Rechazo de cambios (FR-003)**: en producción y con el negocio activo, `saveUsageSettings`
  rechaza `capEnabled = false` y `deletePrice`/`deleteTranscriptionPrice` rechazan borrar el precio
  de `LLM_MODEL` o, con audios, de `STT_MODEL`, con `FieldConflictError` y un mensaje que lo
  explica. Desactivado el negocio, se permite (queda el aviso crítico).

## R4. Qué responde cada canal con «solo contacto»

- **Decision**: cualquier motivo de «solo contacto» o tope alcanzado se trata en el procesador como
  hoy el tope de gasto de la 010: WhatsApp responde **R-CAP** (plantilla fija + contacto, con la
  salida sintética que deja derivar con el detector determinista); el chat web, «no disponible»
  (`quota`) en la recepción, la API y el frame. La traza de la respuesta añade `capReason`
  (`spend_cap`, `whatsapp_daily`, `cap_disabled`, `model_unpriced`, `stt_unpriced`,
  `spend_unreadable`). El contacto es el del negocio; si no se puede leer el snapshot, el de
  emergencia (R-ERR, como hoy). «Probar el bot» no se corta (010 FR-019) y su pantalla avisa.
- **Rationale**: R-CAP ya es genérica y está probada con la derivación (005); no hace falta un texto
  nuevo por motivo, y la spec pide «como con el tope alcanzado».
- **Alternatives considered**: plantillas distintas por motivo (rechazada: más textos sin ganancia
  para el cliente final, que no necesita saber por qué).

## R5. Tope diario de WhatsApp

- **Decision**: contador `whatsapp_usage_day(day, replies)` en la hora local del negocio, como
  `web_usage_day` (004). Se suma **en la transacción del saliente** cuando la respuesta llamó al
  modelo (`response.modelCalled`), haya o no registro de consumo (FR-005). El tope vive en
  `usage_settings.whatsapp_daily_cap`: por defecto **200**, entre **1 y 10 000**; no tiene
  interruptor, así que no se puede desactivar en ningún entorno (FR-009). Alcanzado: R-CAP con
  `capReason = whatsapp_daily`, evento `whatsapp_quota_reached` una vez por día (marca persistida
  `whatsapp_cap_notified_day`, como `cap_notified_month`). El tope del chat web (004) ya no se puede
  desactivar (mínimo 1): FR-011 se fija con una prueba.
- **Rationale**: contar desde `model_usage` fallaría FR-005 (si el registro falla, no se cuenta).
  Contar en la transacción del saliente es lo que ya hace el chat web y es atómico con la respuesta.
- **Alternatives considered**: generalizar `web_usage_day` con una columna de canal (rechazada:
  migración de una tabla publicada y su clave primaria; dos tablas pequeñas son más simples).

## R6. Transcripción dentro del tope

- **Decision**:
  1. **Antes de descargar** (en `createTranscriber`), `protectionState` para el canal del audio:
     con motivo de solo contacto, tope de gasto alcanzado o tope diario del canal alcanzado, no se
     descarga ni transcribe; el audio queda `transcription = failed` con el motivo nuevo `blocked`
     (`transcription_failed` con `reason: 'blocked'`) y el procesador, que vuelve a comprobar,
     responde R-CAP. No hay respuesta extra al cliente.
  2. **Consumo**: tras transcribir (bien o mal, si el proveedor respondió), un registro en
     `model_usage` con `purpose = 'transcription'`, `model = STT_MODEL`, `calls = 1`, tokens a 0 y
     `audio_ms` (duración). Coste con el precio por minuto de `transcription_price`:
     `cost_pico = ceil(audio_ms × micros_por_minuto × 50 / 3)` (1 millonésima/min =
     10⁶ billonésimas / 60 000 ms), congelado al insertar, nulo sin precio (010 R5).
  3. **Duración**: la que informa el proveedor (`duration`); si no la informa, la del archivo
     Ogg/Opus (última `granule_position` / 48 000, que es como llegan las notas de voz de WhatsApp);
     si tampoco se puede, `audioMaxSeconds` (120 s): se sobreestima, nunca se infraestima.
  4. **Producción** con audios activados y `STT_MODEL` sin precio: motivo `stt_unpriced` → aviso
     crítico (R3) y los audios se responden como con el tope alcanzado; el texto sigue atendiéndose.
- **Rationale**: la comprobación antes de descargar ahorra la descarga y la llamada; registrar
  también las transcripciones fallidas tras responder el proveedor refleja lo que se cobra.
- **Alternatives considered**: precio por minuto como columna nullable de `model_price` (rechazada:
  esa tabla exige los cuatro precios por token, que no tienen sentido para un modelo de audio);
  duración estimada por tamaño del fichero (rechazada: depende del códec y puede infraestimar).

## R7. Derivaciones: límites, agrupado y conservación

- **Decision**: ajustes en una fila única nueva `handoff_limits` (no viaja en la 008), editables en
  «Consumo»:

  | Límite | Defecto | Mín. | Máx. |
  |---|---|---|---|
  | Derivaciones nuevas por día local (`daily_max`) | 20 | 1 | 200 |
  | Minutos entre avisos de una derivación (`forward_interval_minutes`) | 15 | 5 | 240 |
  | Avisos al negocio por día local (`notices_daily_max`) | 60 | 10 | 500 |

  1. **Derivación nueva** (FR-013): antes de `service.start`, se reserva una plaza con
     `INSERT … ON CONFLICT … DO UPDATE … WHERE started < daily_max RETURNING` en `handoff_day`. Sin
     plaza: no se avisa, la respuesta es R-HANDOFF-FAIL con CONTACTO (la misma salida que con las
     vías caídas, Principio V), `handoff_day.refused + 1` y `handoff_not_started` con
     `reason: 'daily_limit'`; el evento `handoff_daily_limit` sale una vez al día (marca en la
     fila). Pedir persona con una derivación ya activa no es derivación nueva (va por el reenvío).
  2. **Reenvío agrupado** (FR-014): la derivación guarda `last_notice_at`. Si el procesador encuentra
     pendientes y no han pasado `forward_interval_minutes` desde el último aviso de esa derivación,
     **no** reenvía: deja los mensajes `pending` y pone `conversation.process_after =
     last_notice_at + intervalo`. Al vencer, un solo reenvío con todo lo acumulado. La alerta de
     inicio y cada recordatorio también ponen `last_notice_at`; un recordatorio no espera al
     intervalo, pero lo reinicia.
  3. **Tope diario de avisos** (FR-014, FR-015): cada aviso (alerta, reenvío o recordatorio; **uno
     por aviso**, salgan por una o por dos vías) reserva plaza en `handoff_day.notices` igual que en
     1. Sin plaza: no se envía, `notices_held + 1`, evento `business_notices_held` una vez al día,
     y el panel avisa. Un reenvío retenido deja los mensajes pendientes con `process_after` en el
     inicio del día local siguiente; un recordatorio retenido se da por enviado (no se acumula).
     Una alerta de derivación nueva sin plaza se trata como en 1 (contacto al cliente).
  4. **Fin de la derivación con mensajes pendientes**: al terminar (negocio, inactividad, panel),
     los entrantes `pending` de esa conversación anteriores al fin pasan a `held` (estado nuevo de
     mensaje): no se reenvían, el bot no los contesta y se ven en el panel y en «Probar el bot»
     como «retenido».
  5. **Simulado**: las derivaciones de «Probar el bot» (vía simulada) no cuentan ni se limitan.
  6. **Límite por cliente** (FR-012): ya se cumple — la recepción cuenta todos los entrantes de la
     ventana y guarda los que la superan como `rate_limited`, que nunca se reenvían. Se fija con una
     prueba de integración con derivación activa.
- **Rationale**: reservar antes de enviar hace el límite exacto con concurrencia y da a la vez
  «como mucho una vez» (R11). `process_after` reutiliza la columna de los reintentos (R10) para
  que el procesador no reclame la conversación cada segundo mientras espera.
- **Alternatives considered**: contar desde `handoff_notice` (rechazada: una fila por vía, y sin
  reserva atómica); un estado de mensaje «esperando reenvío» (rechazada: `pending` +
  `process_after` ya expresa lo mismo sin tocar las consultas de la conversación).

## R8. Texto del cliente en los avisos

- **Decision**: función pura `customerQuote(text)` en `src/handoff/customer-text.ts`:
  1. Desactiva enlaces y correos: quita el protocolo (`https://`, `http://`, `ftp://`…), cambia cada
     `.` del host por `[.]` y `@` por `[@]` (`https://ejemplo.com/a` → `ejemplo[.]com/a`;
     `ana@ejemplo.com` → `ana[@]ejemplo[.]com`). Reconoce los mismos candidatos que la regla de
     enlaces de R12 en su forma amplia (con y sin protocolo, `www.`, dominios sueltos).
  2. Se aplica a todo lo que escribe o elige el cliente: el texto reenviado, el resumen (del modelo
     o literal) y el nombre de contacto/perfil.
  3. Delimitado: en el email, bloque `El cliente escribió:` con cada línea sangrada y entre `«»`;
     en las variables de las plantillas de WhatsApp, `El cliente escribió: «…»` dentro de la propia
     variable (las plantillas aprobadas por Meta no cambian). El motivo del aviso pasa a
     `Motivo (según el cliente): «…»`.
- **Rationale**: los programas de correo y WhatsApp convierten en enlace cualquier dominio
  reconocible; quitar el protocolo no basta, el `[.]` sí. Meter el marcado en la variable evita
  volver a aprobar plantillas en cada instancia.
- **Alternatives considered**: eliminar las URL (rechazada: el negocio necesita saber qué escribió
  el cliente); HTML en el email (rechazada: los avisos son texto plano desde la 005).

## R9. Rutas públicas, IPv6 y base de datos

- **Decision**:
  1. **Límites por dirección** con `@fastify/rate-limit` (comprobados en `onRequest`, antes de
     cualquier consulta): `/chat/frame` 60/min, `/chat/design.css` 120/min,
     `/chat/design/:slot/:file` 120/min. Respuesta 429 de texto plano sin consultar la BD; el frame
     rechazado lleva la CSP de respaldo (nadie puede incrustarlo).
  2. **IPv6 /64**: un `keyGenerator` común, `clientKey(request.ip)`, para todas las rutas con
     límite (login, salud, chat, enlaces de derivación): IPv4 tal cual; IPv6 reducida a su /64
     (`2001:db8:1:2::/64`); IPv4 mapeada en IPv6 (`::ffff:a.b.c.d`) como IPv4.
  3. **Imagen del diseño**: se lee primero solo la cabecera del hueco (`sha256`, tipo) con
     `readDesignImageMeta`; si la versión de la URL no es la vigente, 404 sin leer los bytes ni
     validarlos; solo si coincide se leen los bytes.
  4. **Pools**: el pool principal pasa a tener `max = 10`, `connectionTimeoutMillis = 5 000`,
     `statement_timeout = 15 s` e `idle_in_transaction_session_timeout = 60 s`. Las lecturas
     públicas del chat web (frame, hoja y diseño, disponibilidad, historial de la API) usan un
     **pool público** propio de `max = 3` y `statement_timeout = 5 s`, con su propio lector del
     snapshot. Migraciones, copias y comprobación de salud siguen con sus conexiones propias, sin
     esos plazos. La recepción de mensajes del chat web sigue en el pool principal (tiene límite por
     dirección desde la 004).
- **Rationale**: aunque un atacante reparta la carga entre muchas direcciones, el pool público solo
  puede ocupar 3 conexiones; el panel, WhatsApp y el procesador conservan las suyas (SC-004).
- **Alternatives considered**: solo límites por dirección (rechazada: no protege de muchas
  direcciones); caché del frame (rechazada: el frame se lee sin caché por diseño, 004/011).

## R10. Lotes que fallan: reintentos con espera y «como mucho una vez»

- **Decision**:
  1. `conversation.batch_attempts` y `conversation.process_after`. Si `processConversation` lanza,
     se suma un intento y `process_after = ahora + espera`, con esperas **5 s, 30 s, 2 min, 10 min**;
     `claimReady` excluye las conversaciones con `process_after > ahora`. Si la escritura del
     intento también falla (BD caída), una espera en memoria hace lo mismo para ese proceso.
  2. Al **quinto** fallo se abandona: los pendientes se cubren con una disculpa **R-ERR** con el
     contacto del negocio (o el de emergencia), una sola vez, `batch_abandoned` en el registro
     (sin datos) y el contador vuelve a 0. Un mensaje nuevo empieza un lote nuevo.
  3. Al terminar bien (saliente guardado o reenvío marcado) el contador vuelve a 0.
  4. **Como mucho una vez** (FR-027): todo efecto externo se marca antes de enviarse.
     - Respuesta al cliente: ya es así (saliente guardado y entrantes cubiertos antes de enviar).
     - Reenvío: los entrantes pasan a `forwarded` y se reserva el aviso **antes** de enviar.
     - Recordatorio: ya se marca antes (`claimDueReminders`).
     - Alerta de derivación nueva: `start()` guarda la derivación **antes** de avisar, con
       `alerts_sent_at` y `customer_notified_at` nulos; tras avisar marca `alerts_sent_at` (si
       ninguna vía entrega, la borra); la transacción del saliente de confirmación marca
       `customer_notified_at`. En un reintento: con la derivación activa y `alerts_sent_at` nulo,
       no se sabe si el negocio recibió el aviso → se cierra con la causa nueva `interrupted` y el
       cliente recibe el contacto (R-HANDOFF-FAIL); con `alerts_sent_at` y sin
       `customer_notified_at`, solo se envía la confirmación, sin volver a avisar.
- **Rationale**: el reintento sin espera actual (barrido cada segundo) martillea a la BD y al
  proveedor; la causa más frecuente del fallo es transitoria, y cinco intentos en ~13 min la cubren.
  Guardar antes de enviar es la única forma de no repetir avisos de pago si el fallo llega después
  de enviar.
- **Alternatives considered**: tabla de lotes con su propio ciclo de vida (rechazada: el lote ya es
  «los pendientes de una conversación»); repetir la alerta si no consta (rechazada: viola FR-027).

## R11. Llamadas salientes con plazo

- **Decision**:
  - Graph API (`graph-client.ts`): cada petición con `AbortSignal.timeout(10 s)` combinado con el
    del llamador; `sendText` con plazo total de **30 s** contando reintentos; la consulta de
    metadatos de un audio, **5 s**; la descarga, dentro del plazo de la transcripción (el
    `MediaFetcher` recibe la señal: hoy no la recibe).
  - Plantillas de avisos: ya tienen el plazo de 15 s por vía (005 R5).
  - SMTP: ya tiene `connectionTimeout 10 s`, `greetingTimeout 10 s`, `socketTimeout 14 s` y el plazo
    de 15 s por vía. Se fija con pruebas.
  - Modelo y transcripción: ya tienen plazo (002, 010).
- **Rationale**: hoy un `sendText` o un `fetchAudio` sin respuesta deja una petición abierta sin
  límite y ocupa una de las 4 plazas del procesador.

## R12. Una sola regla de enlaces

- **Decision**: módulo `src/conversation/link-rule.ts` con dos reglas exportadas y sus pruebas:
  - **`displayLinks(text)`** — lo que el chat web y «Probar el bot» muestran como enlace: solo
    `https://` con host con punto y sin credenciales, signos finales fuera (la regla actual de
    `message-links.ts` y `links.js`, ahora sin el borde de palabra que hoy les separa del
    verificador).
  - **`linkCandidates(text)`** — lo que el verificador trata como enlace: `displayLinks` **más**
    `http://`, `www.` y dominios sueltos con un dominio de primer nivel de la lista IANA embebida
    (`src/conversation/tlds.ts`), que es lo que WhatsApp convierte en enlace.
  - `grounding.ts` usa `linkCandidates`; un candidato vale si su URL normalizada, o su host y ruta,
    coincide con una dirección registrada. `message-links.ts` usa `displayLinks`. `links.js` se
    sirve con la expresión de `displayLinks` inyectada al arrancar (marcador en el fichero), así que
    no hay una segunda copia que mantener.
  - Propiedad probada: para todo texto de la batería, `displayLinks(t) ⊆ linkCandidates(t)`.
- **Rationale**: la diferencia actual (`\b(?:https?:\/\/|www\.)` en el verificador frente a
  `https:\/\/` sin borde en la vista) permite que `xhttps://otra.web` se pinte como enlace sin que el
  verificador lo vea. WhatsApp enlaza dominios sueltos que hoy no se verifican.
- **Alternatives considered**: no pintar nunca enlaces (rechazada: rompe la 004, FR-020a); copiar la
  expresión en `links.js` con una prueba que compare (rechazada: la spec pide una sola regla).

## R13. Registros sin datos

- **Decision**:
  - Serializador `err` del logger de Fastify: `{ type: error.name, code: error.code }` (y
    `statusCode` si lo hay); nunca `message` ni `stack`. Los `{ err: error }` existentes pasan por él.
  - `loggedUrl` registra la ruta y, de la consulta, **solo los nombres** de los parámetros
    (`/webhooks/whatsapp?hub.mode&hub.verify_token&hub.challenge`), además de ocultar el token de
    `/handoff/` como hoy.
  - Prueba de catálogo: ninguna llamada a un logger en `src/` pasa `error.message`, `err.stack` ni el
    objeto de error fuera de la clave `err`.
- **Rationale**: un mensaje de error de la BD o de un proveedor puede llevar el texto de un cliente,
  un teléfono o una credencial; el tipo y el código bastan para diagnosticar.

## R14. Secretos débiles: mismas reglas en el arranque y en `instance:check`

- **Decision**: las reglas de calidad de `src/provisioning/secrets.ts` se mueven a
  `src/config/secret-rules.ts` (las usan el arranque y `instance:check`; el aprovisionamiento sigue
  usándolas para generar) y se amplían:
  - Secretos: `SESSION_SECRET`, `BACKUP_KEY`, `BACKUP_KEYS_PREVIOUS`, `HEALTH_SECRET`,
    `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `ANTHROPIC_API_KEY`,
    `STT_API_KEY`, la contraseña de `DATABASE_URL` y la de `SMTP_URL`.
  - Reglas: `too_short` (longitud y variedad mínimas actuales por variable), `example_value`
    (coincide con un valor de ejemplo de `.env.example` o de la documentación; una prueba compara
    la lista con `.env.example`), `trivial` (relleno, carácter repetido o secuencia: reglas a–d de
    la 007) y `reused` (igual a otro secreto de la lista, sin distinguir mayúsculas).
  - En producción, `HEALTH_SECRET` pasa a obligatoria (`health_secret_required`), como ya lo eran las
    copias.
  - `botSchema` las aplica solo con `NODE_ENV=production`; el mensaje nombra la variable y la regla
    sin el valor. Fuera de producción, el arranque registra `weak_secrets` con la lista de
    variables y reglas y sigue.
  - `instance:check` deja de calcular la calidad por su cuenta y usa `checkSecrets` en sus dos
    perfiles: en `production`, errores con el mismo veredicto que el arranque (FR-035); en
    `testing`, avisos (como hoy). `reused` sustituye a las reglas de coincidencia que había
    (`backup_key_equals_session`, `health_secret_equals_*`, `secret_reused_within`). La regla del
    formato de `OPERATOR_PASSWORD_HASH` sigue siendo propia de la 007.
- **Rationale**: hoy la calidad solo la mira `instance:check`; una instancia arrancada sin pasarla,
  o actualizada con secretos antiguos, funciona con secretos débiles.

## R15. Importación de configuración acotada

- **Decision**:
  - Tamaño: el máximo actual de 5 MB se mantiene.
  - Listas con máximo (holgados para cualquier negocio pequeño; si el panel ya tiene uno menor para
    esa lista, manda el del panel): horario semanal 70 franjas, cierres 366,
    servicios 300, recursos 100 (cada uno con 300 servicios, 70 franjas y 366 ausencias), preguntas
    frecuentes 300, medios de pago 30, canales de derivación 10, webs permitidas 10 (ya). Se
    comprueban **antes** del esquema completo con un recorrido de longitudes; superar uno rechaza el
    fichero con un error por lista que nombra la lista y el máximo, sin validar el resto ni aplicar.
  - Errores: como mucho **50** en la vista; el resto se cuenta («y 128 errores más»).
  - Coste lineal: la eliminación de errores repetidos usa un `Set` de `ruta + mensaje`; el orden en
    el fichero usa las posiciones de las claves precalculadas por nodo (`Map`); en `replace.ts` las
    pertenencias por recurso usan `Set`. Prueba de rendimiento con el fichero en su máximo
    (SC-007 < 5 s) y prueba de que duplicar el tamaño no más que duplica el tiempo de detección de
    repetidos.
- **Rationale**: los `findIndex` dentro de `filter` y los `includes` dentro de bucles son
  cuadráticos; con listas sin máximo, un fichero de 5 MB puede ocupar la instancia minutos.
- **Formato**: no cambia ninguna columna ni el formato del fichero: **no sube `formatVersion`**; los
  máximos son reglas de validación.

## R16. Login: retardo creciente en lugar de bloqueo

- **Decision**:
  1. Se mantiene el límite por dirección (5/min, ahora con la clave /64 de R9), la verificación
     Argon2id siempre, la comparación en tiempo constante y el mensaje único.
  2. El contador global de fallos (15 min, en memoria) ya no bloquea: cada intento espera
     `min(5 s, 250 ms × max(0, fallos − 5))` antes de verificar.
  3. Verificaciones simultáneas: como mucho **2**; las demás esperan en cola de hasta **50**; con la
     cola llena, 429 «Demasiados intentos. Inténtalo en unos segundos.» sin verificar.
  4. **Navegador conocido**: al entrar bien se pone una cookie firmada `__Host-chatbot-device`
     (HMAC con clave derivada de `SESSION_SECRET`, caducidad 90 días, sin datos del operador). Un
     intento con esa cookie válida no espera el retardo global y pasa delante en la cola (nunca se
     le rechaza por cola llena). Sigue sujeto al límite por dirección y al mensaje único.
- **Rationale**: el retardo frena a un atacante que espera respuesta, pero no a uno que envía sin
  esperar desde muchas direcciones; la cola acota la CPU (Argon2id es caro) y la cookie de
  navegador conocido (recomendación OWASP para el bloqueo de cuentas) garantiza que el operador
  entra desde su equipo habitual durante un ataque (SC-005). Desde un navegador nuevo entra en
  cuanto hay hueco en la cola.
- **Alternatives considered**: bloqueo por dirección más largo (no ayuda contra muchas
  direcciones); reto anti-bot (fuera de alcance en la spec).

## R17. Salud y versiones

- **Decision**: `spendCap` del informe completo de `/health` gana el valor **`"blocked"`** cuando la
  instancia responde solo con el contacto por FR-001 o FR-008 (o no puede leer el gasto).
  `instance:versions` lo muestra como `bloqueado`; no cambia la clasificación de la fila ni el
  código de salida (como el resto de la columna, 010). Sin credencial, `/health` no cambia.
- **Rationale**: es lo que necesita ver el operador antes de dar por buena una tanda (FR-037).

## R18. Valores por defecto y documentación

- **Decision**: todos los límites nuevos son genéricos (ninguno depende de un sector) y se documentan
  en la guía de operación: sección 4.1 (tope obligatorio, WhatsApp, transcripción), sección 5 (antes
  de cada tanda: configurar el tope y pasar `instance:check` para rotar secretos débiles) y una
  sección nueva de límites de derivación con su tabla de valores.

---

## Incógnitas

Ninguna. Todos los valores que la spec dejaba al plan (límites por defecto, plazos, reglas de
secreto débil, máximos de la importación, retardo del login) quedan fijados arriba.
