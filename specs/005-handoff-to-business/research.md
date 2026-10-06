# Research: Derivación de la conversación al negocio

**Feature**: `005-handoff-to-business` | **Plan**: [plan.md](plan.md) | **Spec**: [spec.md](spec.md)

Decisiones técnicas para convertir la salida a una persona de la 002 en una derivación activa.
Parte del código actual: la cadena común de la 004 (`intake` → cola → `processor` → `responder`),
`ChannelPolicy`, el detector determinista de petición de persona, `contactBlock(snapshot)` y el
webhook de WhatsApp. Cada decisión sigue el formato Decisión / Motivo / Alternativas.

---

## R1. Dónde vive la derivación: módulo de dominio `src/handoff`

**Decisión**: módulo de dominio nuevo, `src/handoff`, sin HTTP ni SDK, hermano de
`src/conversation` y `src/webchat`. Contiene el estado de la derivación, la decisión de cada
turno, la composición de avisos, el cálculo de horarios, los tokens y el barrido de plazos. Habla
con el exterior por puertos (`AlertRoute`, `HandoffSummarizer`, `Clock`). El procesador de la 004
recibe un `HandoffService` por inyección y lo consulta en cada lote.

**Motivo**: la derivación afecta a la cadena de respuesta (qué contesta el bot), pero tiene
entradas propias que no son mensajes de cliente (botones, enlaces del email, panel, temporizadores).
Mezclarlo en `processor.ts` lo haría inmanejable; separarlo como `webchat` mantiene la regla de
CLAUDE.md (dominio sin HTTP, adaptadores en `src/channels`).

**Alternativas**: dentro de `src/conversation` (demasiadas responsabilidades en un módulo ya
grande); como extensión (no: la spec es de núcleo y el Principio V es para todos).

---

## R2. Estado de la conversación antes de derivar: `handoff_step`

**Decisión**: la conversación guarda en una columna `jsonb` `handoff_step` el paso intermedio,
validado con Zod:

- `{ step: 'offered', kind: 'unresolved', at }` — el bot ofreció la derivación (FR-002) y espera
  que el cliente acepte. Caduca en el siguiente lote que no la acepta (US2-3).
- `{ step: 'collecting', kind, missing: ('name'|'phone')[], phoneRetried, at }` — el bot pidió
  los datos de contacto (FR-004) y espera la respuesta. Tras un teléfono no válido se pide una
  vez más (FR-005); después, o si el cliente no los da, se entrega el contacto y se limpia.

Los datos de contacto (`contact_name`, `contact_phone`) son columnas de la conversación
(FR-023) y se borran con ella.

**Motivo**: son pasos de un solo turno, pertenecen a la conversación y no necesitan historia.
Un `jsonb` con esquema, como `reply_trace`, evita tres columnas casi siempre nulas.

**Alternativas**: una tabla de "intentos de derivación" (sobra: no hay nada que consultar de los
intentos fallidos); guardarlo en memoria (se perdería al reiniciar entre dos mensajes).

---

## R3. Qué decide el modelo y qué decide el código

**Decisión**: el modelo clasifica y extrae; el código decide y redacta. La salida estructurada
del modelo (`modelReplySchema`) gana cinco campos:

| Campo | Uso |
|-------|-----|
| `complaint: boolean` | queja o reclamación (FR-003); un comentario negativo sin reclamación no lo es (US6-3) |
| `acceptsHandoff: boolean` | solo se lee con `handoff_step = offered` (US2-2) |
| `contactName: string \| null`, `contactPhone: string \| null` | solo se leen con `handoff_step = collecting`; copia literal de lo que dio el cliente |
| `refusesContact: boolean` | el cliente no quiere dar sus datos (US1-4) |

Las indicaciones del sistema del turno final dicen al modelo en qué paso está la conversación
(ofrecida, pidiendo datos, derivación terminada antes). La tabla de decisión completa está en
[contracts/handoff-flow.md](contracts/handoff-flow.md). Reglas clave:

1. Petición de persona = `handoffRequested` **o** el detector determinista de la 002 (sin
   cambios); así el Principio V no depende del modelo.
2. Prioridad: queja > petición de persona > datos pedidos > aceptación de la oferta > oferta.
3. Cuando se inicia o se intenta iniciar una derivación, el cuerpo del modelo se descarta y la
   respuesta es una plantilla fija (R-HANDOFF-*). Así la queja nunca recibe una explicación
   (FR-003) y el intercambio pendiente se abandona (edge case "en mitad de otra gestión").
4. Sin ninguna vía de aviso disponible, todo sigue como en la 002 (bloque CONTACTO), salvo la
   queja, que recibe una plantilla de disculpa con CONTACTO en vez del cuerpo del modelo.
5. El teléfono se valida con libphonenumber-js (`DEFAULT_PHONE_REGION`) y se guarda en E.164; si
   el modelo no lo extrajo, se busca en el texto con `findPhoneNumbersInText` como respaldo.

**Motivo**: mismo reparto que la 002 (el modelo aporta el cuerpo y banderas, el código garantiza
IV y V). Las respuestas de derivación son compromisos del negocio ("te contestarán") y solo deben
decirse cuando el aviso se ha entregado (FR-010, FR-012): tienen que ser del código.

**Alternativas**: una segunda llamada solo para clasificar (más latencia y coste en cada
mensaje); palabras clave para las quejas (la spec descarta una lista configurable y no distingue
"qué caro" de una reclamación).

---

## R4. Resumen del motivo: llamada aparte, solo con lo que escribió el cliente

**Decisión**: al iniciar una derivación, un puerto `HandoffSummarizer` genera el resumen con una
llamada propia al mismo modelo (`LLM_MODEL`, esfuerzo `low`, salida estructurada
`{ summary }`, máximo 300 caracteres). Su entrada son **solo** los mensajes del cliente de la
conversación (hasta 30, incluidos los que se reenviaron en una derivación anterior) y el tipo de
derivación; nunca el snapshot ni las respuestas del bot. Después:

- Verificación determinista: todo teléfono, correo, URL, importe, fecha, hora o número del
  resumen tiene que aparecer en los textos del cliente (se reutiliza `extractFacts` de la 002).
- Si falla la verificación, el modelo o el plazo (8 s), se usa un resumen de respaldo por código:
  sin mensajes previos, "El cliente pidió hablar con una persona sin dar el motivo" (US1-5); con
  mensajes, un extracto literal de los últimos mensajes del cliente, recortado a 300 caracteres.
- El resumen se sanea para las plantillas de WhatsApp (sin saltos de línea ni tabuladores).

**Motivo**: FR-007 exige que el resumen solo contenga lo que el cliente ha escrito. Si el
modelo no ve los datos del negocio, no puede mezclarlos; la verificación cubre lo que el modelo
pudiera inventar. El fallo del resumen nunca impide avisar (Principio V).

**Alternativas**: pedir el resumen en la misma llamada de la respuesta (se generaría en cada
mensaje y el modelo tendría delante el snapshot); resumen solo por código (no permite "identificar
el motivo sin consultar la conversación", SC-003).

---

## R5. Vías de aviso: puerto `AlertRoute` con WhatsApp y email

**Decisión**: puerto de dominio

```ts
interface AlertRoute {
  readonly name: 'whatsapp' | 'email';
  send(notice: BusinessNotice): Promise<{ ok: true; ref: string | null } | { ok: false; reason: string }>;
}
```

`BusinessNotice` es un aviso ya compuesto por el dominio (tipo: aviso, recordatorio o mensaje
reenviado; datos del cliente; resumen; textos reenviados; token). Cada adaptador lo traduce a su
formato. Una vía está disponible si su destino está configurado en el panel **y** la instancia
puede usarla (R6, R7). "Entregado" = el proveedor aceptó el envío (Graph API devolvió un `wamid`;
el servidor SMTP respondió `250`). Las vías se envían en paralelo con un plazo de 15 s cada una.

**Motivo**: el dominio no conoce Graph API ni SMTP (como `ChannelSender` en la 002). El criterio
de entrega es lo único que el sistema puede comprobar al instante; la confirmación de lectura no
existe en el email y en WhatsApp llega más tarde.

**Alternativas**: esperar al estado `delivered` de WhatsApp (retrasa la confirmación al cliente y
no hay equivalente en email).

---

## R6. WhatsApp: plantillas aprobadas con botones de respuesta rápida

**Decisión**: los avisos al WhatsApp del negocio se envían **siempre** como plantillas de la
categoría *utility* aprobadas en Meta, con dos botones de respuesta rápida ("Le atiendo" y
"Terminado"). Tres plantillas con nombre fijo, en `WHATSAPP_TEMPLATE_LANG` (por defecto `es`):
`derivacion_aviso`, `derivacion_recordatorio` y `derivacion_mensaje`. Su texto, variables y
botones están en [contracts/business-alerts.md](contracts/business-alerts.md), y un comando
`pnpm handoff:templates` imprime la definición lista para crearlas por la API de Meta.

- El `payload` de cada botón es `h1:<acción>:<token>` (acción `attend` o `end`, R9). Meta lo
  devuelve en el webhook como mensaje `type = button` (`button.payload`).
- Las variables no admiten saltos de línea, tabuladores ni más de 4 espacios seguidos: el
  adaptador las sanea y recorta (el texto reenviado, a 700 caracteres; si se recorta, se indica
  que el texto completo va por email cuando esa vía existe).
- Las respuestas al negocio que no son avisos (ayuda de FR-008b, acuse de un botón) son texto
  libre: el negocio acaba de escribir, así que su ventana de 24 h está abierta.
- La vía WhatsApp existe solo si la instancia tiene el canal de WhatsApp configurado (FR-008).

**Motivo**: el negocio casi nunca habrá escrito al número del bot en las últimas 24 h, así que
Meta solo deja iniciar la conversación con plantillas aprobadas. Los mensajes interactivos con
botones solo valen dentro de la ventana; usar siempre plantillas evita dos caminos. Nombres fijos
= nada que configurar por instancia (Principio II: el texto es genérico y no varía entre
negocios).

**Alternativas**: mensajes interactivos cuando la ventana del negocio está abierta y plantillas
cuando no (dos formatos de payload y más pruebas); nombres de plantilla por variable de entorno
(configuración sin valor: el texto es el mismo en todas las instancias).

**Consecuencia**: cada aviso, recordatorio y reenvío es una conversación de plantilla que Meta
cobra; la instancia necesita las tres plantillas aprobadas antes de que la vía funcione. Si una
plantilla no existe o se rechaza, el envío falla, se registra y cuenta el email.

---

## R7. Email: SMTP con nodemailer

**Decisión**: adaptador `src/mail/smtp-mailer.ts` con `nodemailer` (dependencia nueva) y dos
variables de instancia: `SMTP_URL` (`smtps://usuario:clave@host:465` o `smtp://…:587` con
STARTTLS) y `SMTP_FROM`. La vía email existe si están las dos **y** `PUBLIC_BASE_URL` (los enlaces
necesitan una URL pública). Cada email lleva texto plano y HTML sencillo con el contenido del
cliente escapado. El recordatorio y los reenvíos llevan `In-Reply-To`/`References` al
`Message-ID` del aviso, para que el cliente de correo del negocio los agrupe en un hilo.

**Motivo**: SMTP funciona con cualquier proveedor (el del dominio del negocio, uno transaccional
o el de la agencia) sin atar el núcleo a una API concreta; nodemailer es el estándar en Node y
gestiona TLS, cabeceras y codificación (incluida la protección contra saltos de línea en
cabeceras).

**Alternativas**: API HTTP de un proveedor (Resend, Postmark…) con `fetch` (ata el núcleo a un
proveedor); `sendmail` local (no existe en el contenedor).

---

## R8. Enlaces del email: página de confirmación y `POST`

**Decisión**: el email lleva dos enlaces,
`${PUBLIC_BASE_URL}/handoff/<token>/attend` y `…/end`. El `GET` no cambia nada: muestra una página
mínima (Eta, sin sesión) con el nombre del cliente, el estado de la derivación y un botón que
hace `POST` a la misma URL. El `POST` aplica la acción y muestra el resultado. Sin CSRF de sesión:
el token del path es la credencial. Límite por IP de 30 peticiones/15 min en `/handoff/*`,
`Cache-Control: no-store`, `Referrer-Policy: no-referrer` y `X-Robots-Tag: noindex`.

**Motivo**: los filtros antispam y las vistas previas de enlaces abren los `GET` de los emails;
si el `GET` terminara la derivación, se terminarían solas. FR-008a pide que funcionen sin iniciar
sesión y solo para esa derivación: el token cumple ambas cosas.

**Alternativas**: acción directa en el `GET` (terminaciones fantasma); un solo enlace a una
página con los dos botones (la spec pide dos enlaces equivalentes a los botones).

---

## R9. Tokens de acción

**Decisión**: cada derivación tiene un token aleatorio de 128 bits (`randomBytes(16)`, base64url,
22 caracteres), el mismo para los botones de WhatsApp y los enlaces del email. En la BD solo se
guarda `sha256(token)` con índice único. Una acción:

- busca la derivación por el hash; si no existe → "enlace no válido" (sin distinguir de otros
  errores);
- si la derivación ya terminó → sin efecto, y se dice (edge case "botón de una derivación ya
  terminada");
- `attend`: `confirmed_at = now` solo si era nulo; `end`: termina con causa `business` y, si no
  estaba confirmada, la confirma a la vez (FR-016). Las dos son `UPDATE … WHERE status = 'active'`,
  así que si llegan por las dos vías solo cuenta la primera.

**Motivo**: el token liga cada botón o enlace a una sola derivación (SC-010) sin necesidad de
saber qué mensaje se pulsó ni quién lo pulsa. Buscar por el hash evita que una copia de la BD
permita actuar.

**Ajuste en la implementación**: los reenvíos (FR-014) y el recordatorio (FR-019) llevan los
mismos botones y enlaces que el aviso, y se componen cuando el token ya no está en memoria. Por
eso `handoff` guarda además `token_enc`: el token cifrado con AES-256-GCM y una clave derivada de
`SESSION_SECRET` con HKDF (como el seudónimo de los registros, R17). Una copia de la BD sin el
secreto sigue sin permitir actuar; rotar `SESSION_SECRET` deja sin botones los reenvíos y
recordatorios de las derivaciones activas, pero los del aviso ya enviado siguen funcionando.

**Alternativas**: HMAC del id de la derivación con una clave derivada de `SESSION_SECRET` (no se
puede revocar uno concreto y cambia si se rota el secreto); relacionar el `context.id` del botón
con el `wamid` del aviso (no sirve para el email).

---

## R10. Mensajes del negocio al número del bot

**Decisión**: el adaptador de WhatsApp extrae además del webhook el nombre de perfil
(`contacts[].profile.name`) y los botones (`type = button` → `buttonPayload`). Antes de la
recepción, un enrutador en `bot.ts` separa los eventos cuyo remitente es el WhatsApp de avisos
configurado (leído en cada lote, sin caché):

- con `buttonPayload` de derivación → acción del token (R9) y un acuse breve ("Anotado: …");
- cualquier otro mensaje → ayuda breve sobre los botones (FR-008b), como mucho una vez cada
  15 minutos; nunca entra en la recepción ni cambia derivaciones.

Un botón con payload válido que llega desde otro número también se acepta (el token es la
credencial); el resto de mensajes de otros números siguen la recepción normal.

**Motivo**: FR-008b prohíbe tratar al negocio como cliente. Hacerlo antes de la recepción evita
tocar el límite por cliente, las conversaciones y los registros de mensajes de cliente.

**Alternativas**: filtrar en la recepción (mezcla dos roles en el punto de entrada del cliente).

**Consecuencia**: si el WhatsApp de avisos del negocio escribe al bot como cliente, no le
contestará el bot (recibe la ayuda). Se documenta en el panel junto al campo.

---

## R11. Qué pasa con los mensajes del cliente durante la derivación

**Decisión**: la recepción no cambia (los mensajes se guardan `pending`, cuentan para el límite
por cliente y se agrupan con la misma espera de 3 s). Al reclamar el lote, el procesador ve que
la conversación tiene una derivación activa y, en lugar de responder, llama a
`HandoffService.forward`: compone un único reenvío con los textos del lote (FR-014), lo manda por
las vías disponibles y marca los entrantes con el estado nuevo `forwarded`. No se crea ningún
saliente salvo R-LIMIT (ver abajo), no hay saludo ni R-MEDIA (FR-013); un archivo sin texto se reenvía como
"[imagen]"/"[audio]"… con su tipo. Si fallan todas las vías, los entrantes quedan igualmente
`forwarded` y se registra el fallo (no se reintenta en bucle).

Otras reglas durante la derivación:

- Límite por cliente superado: se envía R-LIMIT como en la 002, que ya lleva CONTACTO (Principio
  V: el cliente sabe que esos mensajes no llegan y cómo contactar; FR-013 lo admite como
  excepción), y los mensajes limitados no se reenvían (protege al negocio de una ráfaga).
- Una nueva petición de persona o insistencia se reenvía como un mensaje más; no genera aviso
  nuevo (US3-4).
- `history()` incluye los entrantes `forwarded`, así el bot los tiene en cuenta cuando la
  conversación vuelve (FR-018).
- La web y el playground muestran los `forwarded` como mensajes del visitante; `waiting` es falso
  mientras la derivación está activa (no hay indicador de "escribiendo").

**Motivo**: reutiliza el agrupado y la reanudación tras reinicio de la cola de la 002 sin
duplicar lógica; un estado propio (`forwarded`) distingue "reenviado" de "contestado".

**Alternativas**: reenviar cada mensaje en la recepción (rompe el agrupado que pide la
clarificación); un saliente vacío que "cubra" los entrantes (ensucia historial y trazas).

---

## R12. Inicio de la derivación: orden y atomicidad

**Decisión**: dentro del procesador, cuando la decisión es "iniciar":

1. Se generan en memoria el id y el token; se calcula el resumen (R4).
2. Se envía el aviso por las vías disponibles en paralelo (R5).
3. Si alguna lo aceptó: en **una** transacción se inserta la derivación `active` con sus
   `handoff_notice`, se limpia `handoff_step` y se crea el saliente de confirmación que cubre los
   entrantes; después se entrega al cliente como cualquier respuesta.
4. Si ninguna lo aceptó (o no había vías): no se guarda derivación; la respuesta es la de FR-012
   (bloque CONTACTO) y se registra `handoff_not_started`.

Si el proceso cae entre 2 y 3, los entrantes siguen `pending` y el siguiente barrido repite el
turno: el negocio podría recibir el aviso dos veces. Se acepta: es raro, y la alternativa (guardar
antes de enviar) permitiría confirmar al cliente algo que no se entregó.

**Motivo**: FR-010 y FR-012 condicionan lo que se dice al cliente al resultado real del envío.

**Alternativas**: bandeja de salida con reintentos asíncronos (la confirmación al cliente tendría
que esperar o ser provisional).

---

## R13. Horario de atención: próxima franja y 2 horas de horario

**Decisión**: funciones puras en `src/handoff/schedule.ts` sobre el snapshot:

- Horario aplicable (FR-011): `snapshot.handoff.hours` si tiene franjas; si no,
  `snapshot.openingHours`. En los dos casos se aplican `snapshot.closures` con
  `effectiveIntervals` de la 001, en la zona `business.timezone`.
- `nextOpening(at)`: si ahora está dentro de una franja → `null` (abierto: la confirmación no
  menciona horarios, US5-3). Si no, el inicio de la primera franja de los próximos 60 días.
- `addOpenMinutes(at, 120)`: el instante en que se cumplen 120 minutos contados solo dentro de las
  franjas (FR-019). Se calcula al iniciar la derivación y se guarda como `reminder_due_at`.
- Sin ninguna franja registrada en el horario aplicable: se considera abierto siempre (no se
  menciona horario; el recordatorio se cuenta en tiempo real). Con franjas pero ninguna en 60 días
  (cierre largo): la confirmación no da hora y `reminder_due_at` queda nulo.
- La conversión de fecha y hora local a instante usa `Intl` con la zona IANA y se prueba en los
  cambios de hora (hora que no existe → se avanza al primer minuto válido).

La confirmación da la franja como "hoy a las 16:00", "mañana a las 9:00" o "el lunes 5 de octubre a
las 9:00".

**Motivo**: mismo criterio que los hechos calculados de la 002 (el código calcula, nada se
estima). Precalcular `reminder_due_at` hace el barrido trivial; si el operador cambia el horario
durante una derivación, el recordatorio sigue el horario que había al iniciarla (aceptable para
un plazo de horas).

**Alternativas**: recalcular en cada barrido (más coste y resultados que cambian con el tiempo).

---

## R14. Temporizadores: barrido de derivaciones

**Decisión**: un barrido cada 60 s (`handoffSweepMs`) en el mismo proceso, arrancado y parado con
el procesador:

- **Inactividad** (FR-017): derivaciones activas cuya conversación tiene
  `last_inbound_at ≤ now − 24 h` → terminadas con causa `inactivity`. Coincide con la regla de la
  002 (a las 24 h el siguiente mensaje abre una conversación nueva), así que el cliente nunca
  queda mudo más de 24 h. Las que se cierran sin `confirmed_at` y sin `reminder_sent_at` se marcan
  con `reminder_sent_at` en la misma sentencia (`RETURNING`) y, fuera de la transacción, reciben el
  aviso `reminder` por las vías, sin R-HANDOFF-LATE (FR-019, FR-018). Se registra
  `handoff_reminder_sent` con `trigger: 'inactivity'` y `customerNotified: false`. Así el
  recordatorio llega también cuando las 2 h de horario caerían después del cierre (por ejemplo,
  derivación el viernes por la noche con apertura el lunes).
- **Recordatorio** (FR-019): activas, sin confirmar, sin recordatorio, con
  `reminder_due_at ≤ now` → recordatorio al negocio por las vías y un único mensaje al cliente
  (R-HANDOFF-LATE con CONTACTO). El mensaje al cliente usa la entrega del canal y respeta la
  ventana de 24 h de WhatsApp (si está cerrada, no se envía y se registra). Se marca
  `reminder_sent_at` en la misma transacción que reclama la fila (`FOR UPDATE SKIP LOCKED`), así
  que se envía una sola vez aunque haya dos barridos.

**Motivo**: igual que la retención de la 002; no hace falta una cola de trabajos.

**Alternativas**: `setTimeout` por derivación (se pierden al reiniciar).

---

## R15. Chat web y "Probar el bot" durante la derivación

**Decisión**:

- `GET /chat/api/messages` añade `handoff: { active: true, notice } | null`. `notice` es el texto
  fijo de FR-013a, compuesto en el servidor con la forma de trato del negocio. El iframe lo pinta
  como un aviso de la interfaz (no como burbuja del bot) y, mientras está visible, consulta
  `/messages` cada 60 s para quitarlo cuando termine la derivación (US4-6) y mostrar el mensaje
  de FR-019 si llega.
- `ChannelPolicy` gana `contactFromChannel` (WhatsApp: el número es el `channel_user_id` y el
  nombre, el de perfil; web y playground: se piden) y `simulateAlerts` (solo playground, FR-021).
- En el playground las vías se sustituyen por una vía simulada que "entrega" siempre y guarda el
  texto del aviso en `handoff_notice.body` (solo aquí se guarda el texto). La información técnica
  de la respuesta muestra ese aviso; la página añade el aviso fijo y un botón "Terminar derivación"
  (causa `playground`).

**Motivo**: reutiliza el sondeo existente (R5 de la 004) y el mismo camino de la cadena, que es
lo que "Probar el bot" debe probar.

**Alternativas**: un endpoint aparte de estado de derivación (otra petición periódica sin
necesidad); enviar avisos reales desde el playground (lo prohíbe FR-021).

---

## R16. Destinos de avisos y avisos del panel

**Decisión**: tabla singleton `handoff_alerts` (`whatsapp_phone` E.164, `email`, ambos
opcionales), editable en la página nueva del panel "Derivaciones" y guardada con la escritura
protegida de la 001 (aplicar → avisos → revertir si crítico; aquí nunca hay críticos).
`KnowledgeState` gana `handoffAlerts: { whatsapp, email, routes }`, donde `routes` son las vías
que la instancia **puede** usar (WhatsApp configurado; SMTP + `PUBLIC_BASE_URL`), que
`loadKnowledgeState` recibe como opción (por defecto, ninguna). `computeWarnings(state)` sigue
siendo pura y añade:

- `HANDOFF_ALERTS_NONE` (normal): ninguna vía disponible.
- `HANDOFF_ALERTS_SINGLE` (normal): solo una vía disponible; recomienda configurar la otra.

No forman parte del `KnowledgeSnapshot`: el bot no debe conocer ni decir el WhatsApp ni el email de
avisos del negocio.

**Motivo**: son configuración del negocio (Principio II) que registra el operador (Principio VI).
Los avisos se calculan como todos los demás, sin guardarse.

**Alternativas**: variables de entorno (cambiarlos exigiría redesplegar, contra el Principio II);
meterlos en el contacto de derivación de la 001 (ese contacto se da al cliente; estos no).

**Consecuencia**: toda instancia sin destinos configurados muestra `HANDOFF_ALERTS_NONE`; los
tests de la 001 que comprueban la lista exacta de avisos se adaptan.

---

## R17. Registros técnicos (FR-022)

**Decisión**: eventos nuevos en el catálogo cerrado de `activity-log.ts`, sin textos, nombres ni
teléfonos; el cliente, como hasta ahora, solo por seudónimo y `via`; la derivación por su `id`
(UUID sin datos personales). Detalle en [contracts/activity-log.md](contracts/activity-log.md).

---

## R18. Pruebas

**Decisión**:

- **unit**: tabla de decisión (R3), `schedule.ts` (cierres, zona horaria, cambio de hora, sin
  franjas), composición de avisos y saneado de variables, verificador y respaldo del resumen,
  tokens, parseo de botones y nombre de perfil, esquema de destinos.
- **contract** (`fastify.inject`): webhook con botón y con texto libre del negocio;
  `/handoff/:token/:action` (`GET` sin efectos, `POST` idempotente, token inválido, terminada);
  página "Derivaciones" del panel (CSRF, listado sin textos, terminar); `/chat/api/messages` con
  `handoff`; playground.
- **integration** (Testcontainers, vías falsas y reloj controlable): los flujos de US1–US6, silencio
  del bot y reenvío agrupado, fin por botón/enlace/panel/inactividad, recordatorio en horario,
  fallo de una y de las dos vías, playground simulado, borrado en cascada, migración `0004`,
  registros sin datos personales, neutralidad sectorial de `src/handoff`.
- **eval** (modelo real, fuera de `pnpm test`): SC-006 (quejas frente a comentarios negativos),
  SC-007 (oferta en consultas sin dato), SC-001 (petición en mitad de otra gestión) y SC-003
  (resúmenes: verificación automática de datos + revisión manual de una muestra). La prueba
  `sc008-handoff` de la 002 se adapta: con vías, la petición termina en aviso; sin vías, en
  contacto.

---

## Tabla de decisiones

| Tema | Decisión | Ref. |
|------|----------|------|
| Módulo | `src/handoff`, dominio sin HTTP; `HandoffService` inyectado en el procesador | R1 |
| Pasos previos | `conversation.handoff_step` (`offered`/`collecting`) + `contact_name`/`contact_phone` | R2 |
| Clasificación | 5 campos nuevos en la salida del modelo; decide el código; plantillas fijas | R3 |
| Resumen | llamada aparte solo con textos del cliente, ≤ 300 car., verificada, con respaldo | R4 |
| Entrega | aceptada por el proveedor en ≥ 1 vía; vías en paralelo, 15 s | R5 |
| WhatsApp | 3 plantillas *utility* fijas con 2 botones de respuesta rápida | R6 |
| Email | SMTP con nodemailer (`SMTP_URL`, `SMTP_FROM`) + `PUBLIC_BASE_URL` | R7 |
| Enlaces | `GET` página + `POST` acción; 30 peticiones/15 min por IP | R8 |
| Tokens | 128 bits, uno por derivación, solo hash en BD | R9 |
| Negocio → bot | enrutado antes de la recepción; ayuda como mucho cada 15 min | R10 |
| Durante | estado `forwarded`; R-LIMIT con CONTACTO como en la 002; limitados no se reenvían | R11 |
| Inicio | enviar primero, guardar después en una transacción | R12 |
| Horario | contacto → negocio, con cierres; 60 días de horizonte; `reminder_due_at` precalculado | R13 |
| Plazos | barrido cada 60 s: 24 h de inactividad y recordatorio único | R14 |
| Web/playground | `handoff` en `/messages`; sondeo de 60 s con aviso; vía simulada | R15 |
| Destinos | tabla `handoff_alerts`; avisos `HANDOFF_ALERTS_NONE`/`_SINGLE` (normales) | R16 |
| Registros | eventos `handoff_*` sin datos personales | R17 |

Cifras que la spec delegaba al plan: resumen ≤ 300 caracteres y 8 s (R4); plazo por vía 15 s (R5);
texto reenviado ≤ 700 caracteres en WhatsApp (R6); límite de los enlaces 30/15 min (R8); ayuda al
negocio como mucho cada 15 min (R10); horizonte de 60 días (R13); barrido cada 60 s (R14);
sondeo del aviso web cada 60 s (R15). No quedan incógnitas técnicas.
