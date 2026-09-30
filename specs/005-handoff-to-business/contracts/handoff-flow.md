# Contrato: flujo de la derivación en la cadena de respuesta

**Feature**: `005-handoff-to-business` | Research: R1–R4, R11–R14 | Data model: [data-model.md](../data-model.md)

Cómo decide el bot iniciar, pedir datos, ofrecer o no derivar, qué le dice al cliente y qué hace
el procesador con una conversación derivada. Todo vive en `src/handoff` (dominio, sin HTTP) y se
engancha al procesador de la 004 por inyección. Ninguna regla depende del canal salvo lo que dice
`ChannelPolicy` (`contactFromChannel`, `simulateAlerts`), ni del sector (FR-024).

## Puertos (`src/handoff/ports.ts`)

```ts
interface AlertRoute {
  readonly name: 'whatsapp' | 'email' | 'simulated';
  /** Aceptado por el proveedor = entregado (R5). No lanza: devuelve el fallo. */
  send(notice: BusinessNotice, opts: { signal: AbortSignal }):
    Promise<{ ok: true; ref: string | null; body?: string } | { ok: false; failure: string }>;
}

interface HandoffSummarizer {
  /** Solo textos del cliente (R4). Lanza si no hay respuesta válida en el plazo. */
  summarize(input: { kind: HandoffKind; customerTexts: string[] }, opts: { signal: AbortSignal }):
    Promise<{ summary: string }>;
}

/** Vías que se pueden usar ahora: lee `handoff_alerts` sin caché y cruza con la instancia. */
interface AlertRoutesProvider {
  available(tx: DbOrTx): Promise<AlertRoute[]>;   // [] si no hay ninguna
}
```

## `HandoffService` (lo que usa el procesador)

```ts
interface HandoffService {
  /** Derivación activa de la conversación, o null. */
  active(tx: DbOrTx, conversationId: string): Promise<ActiveHandoff | null>;
  /** Decide el turno a partir de la salida del modelo (tabla de abajo). Sin efectos. */
  decide(input: TurnInput): TurnDecision;
  /** Resume, avisa y, si se entregó, guarda la derivación (R12). */
  start(input: StartInput): Promise<{ started: true; handoffId: string; routes: RouteResults } |
                                     { started: false; routes: RouteResults }>;
  /** Reenvía un lote de una conversación derivada y marca los entrantes `forwarded` (R11). */
  forward(input: ForwardInput): Promise<void>;
  /** Acción de un botón o enlace (R9). */
  act(token: string, action: 'attend' | 'end', via: 'whatsapp' | 'email'):
    Promise<'done' | 'already_confirmed' | 'already_ended' | 'invalid'>;
  /** Terminar desde el panel o desde "Probar el bot". */
  endByOperator(handoffId: string, cause: 'operator' | 'playground'): Promise<boolean>;
  /** Barrido de inactividad y recordatorios (R14). */
  sweep(): Promise<void>;
}
```

## Decisión de cada turno (`decide`)

Entradas: `handoff_step` de la conversación, salida del modelo (R3), detector de petición de
persona de la 002 sobre los textos del lote, vías disponibles (`hasRoutes`), si el canal da los
datos (`contactFromChannel`), los datos ya conocidos (`contact_name`, `contact_phone`) y si hubo
una derivación terminada en esta conversación (`handoffEnded`).

`request = model.handoffRequested || detector`.

Se evalúa en este orden; gana la primera fila que aplica:

| # | Condición | Decisión | Respuesta al cliente | `handoff_step` después |
|---|-----------|----------|----------------------|------------------------|
| 1 | `model.complaint` y `hasRoutes` | derivar `complaint` (sin pedir aceptación, FR-003) | si faltan datos → R-HANDOFF-ASK; si no → iniciar (§ Inicio) | `collecting` o `null` |
| 2 | `model.complaint` y no `hasRoutes` | no derivar | R-HANDOFF-COMPLAINT sin confirmación + CONTACTO (`handoff_unavailable`); **nunca** el cuerpo del modelo | `null` |
| 3 | `request` y `hasRoutes` | derivar `person` | como en la fila 1 | `collecting` o `null` |
| 4 | `request` y no `hasRoutes` | no derivar (002) | cuerpo del modelo + CONTACTO (`handoff_requested`) | `null` |
| 5 | `step = collecting` | completar datos (§ Datos) | según § Datos | según § Datos |
| 6 | `step = offered` y `model.acceptsHandoff` | derivar `unresolved` | como en la fila 1 | `collecting` o `null` |
| 7 | (`model.offerContact` o `model.bookingRequested`) y `hasRoutes` y no `needsRephrase` | ofrecer (FR-002) | cuerpo del modelo + OFERTA, sin CONTACTO | `offered` |
| 8 | resto | respuesta normal de la 002 (incluye CONTACTO por oferta, reserva o precio a consultar) | cuerpo del modelo (+ CONTACTO según la 002) | `null` |

Notas:

- La fila 5 va después de las peticiones explícitas: si mientras se piden los datos el cliente
  presenta una queja o vuelve a pedir una persona, se recalcula el tipo y se siguen pidiendo los
  datos que falten.
- `step = offered` caduca en cualquier fila distinta de la 6 (US2-3: rechaza o cambia de tema).
- `handoffEnded` no cambia la tabla: solo se usa en el prompt (no saludar y tener en cuenta lo
  hablado). Tras una derivación terminada, una consulta sin dato vuelve a ofrecer la derivación
  (FR-002), y solo se deriva si el cliente acepta; una petición explícita (filas 1–4) crea una
  derivación nueva (FR-018, edge case "vuelve a escribir").
- En las filas 1, 3 y 6 el cuerpo del modelo se descarta (R3, regla 3).
- Petición de persona en mitad de otra gestión: gana la fila 3 sobre cualquier intercambio
  (Principio V); el resumen recoge lo que el cliente estaba haciendo.
- Si el modelo falla (R-ERR de la 002), no se decide nada: R-ERR ya lleva CONTACTO y
  `handoff_step` no cambia.
- Lotes que no pasan por el modelo (solo archivos, audios no entendidos): sin cambios respecto a
  la 002 y `handoff_step` no cambia.

### Datos de contacto (FR-004, FR-005)

Faltan datos si:

- `contactFromChannel` (WhatsApp): el teléfono es el `channel_user_id`; falta el nombre solo si
  el perfil no lo trae.
- Web y playground: faltan nombre y teléfono salvo los ya dados en la conversación.

Con datos pendientes se responde R-HANDOFF-ASK (una sola pregunta con todo lo que falta) y se
guarda `collecting`. En el turno siguiente (fila 5):

| Situación | Resultado |
|-----------|-----------|
| `model.refusesContact` | no derivar; cuerpo del modelo + CONTACTO (`contact_refused`); `null` (US1-4) |
| llegan todos los datos que faltaban y el teléfono es válido | guardar en la conversación e iniciar (§ Inicio) |
| teléfono no válido y `phoneRetried = false` | R-HANDOFF-PHONE; `phoneRetried = true` |
| teléfono no válido otra vez, o faltan datos | no derivar; cuerpo del modelo + CONTACTO (`contact_refused`); `null` |

- Nombre: `model.contactName`, recortado, sin saltos de línea, 1–80 caracteres.
- Teléfono: `model.contactPhone`; si es nulo, el primero que encuentre `findPhoneNumbersInText`
  en los textos del lote. Se valida con `DEFAULT_PHONE_REGION` y se guarda en E.164.
- Un dato dado se guarda aunque falte el otro (no se vuelve a pedir).

### Inicio (R12)

1. Resumen: `HandoffSummarizer` con los textos del cliente de la conversación (hasta 30,
   incluidos los del lote y los `forwarded` anteriores), plazo 8 s, verificación de datos y
   respaldo (R4).
2. Aviso `alert` por todas las vías disponibles en paralelo, 15 s por vía.
3. ≥ 1 vía `ok` → transacción: `handoff` `active` (`reminder_due_at` según R13) + un
   `handoff_notice` por vía + `handoff_step = null` + saliente de confirmación que cubre los
   entrantes. Respuesta: R-HANDOFF-OK (o R-HANDOFF-COMPLAINT) con la franja si procede (FR-010).
4. Ninguna `ok` → nada guardado de la derivación; respuesta de FR-012: R-HANDOFF-FAIL +
   CONTACTO (`handoff_unavailable`) o, si era una queja, la fila 2. **Nunca** el cuerpo del
   modelo: al recibir los datos de contacto suele contestar que le contactarán (hallado en T132).

Con `simulateAlerts` (playground) la única vía es `simulated`: siempre `ok` y guarda el texto
del aviso en `handoff_notice.body` (FR-021).

## Respuestas al cliente (plantillas fijas)

Variantes tú/usted como en la 002 (`formOf`). `{negocio}` = `snapshot.business.name`;
`{teléfono}` = `displayPhone(contact_phone)`; `{franja}` = próxima franja de R13 ("hoy a las
16:00", "mañana a las 9:00", "el lunes 5 de octubre a las 9:00"). Con saludo si es la primera
respuesta de la conversación (FR-020 de la 002). Ninguna lleva datos del negocio salvo el nombre,
la franja calculada y, cuando se indica, el bloque CONTACTO.

| Id | Cuándo | Texto (forma tú) |
|----|--------|------------------|
| OFERTA (parte) | fila 7, tras el cuerpo del modelo | "¿Quieres que le pase tu consulta a {negocio} para que te contacte?" |
| R-HANDOFF-ASK | faltan datos | nombre y teléfono: "Para que {negocio} pueda contactarte, ¿me dices tu nombre y un teléfono?" · solo nombre: "Para pasarle tu consulta a {negocio}, ¿me dices tu nombre?" · solo teléfono: "¿Me dices un teléfono en el que {negocio} pueda contactarte?" |
| R-HANDOFF-PHONE | teléfono no válido (una vez) | "Ese teléfono no parece válido. ¿Me lo escribes de nuevo, con el prefijo internacional si no es un número nacional?" |
| R-HANDOFF-OK | derivación iniciada, negocio abierto | "He avisado a {negocio}. Te contactarán en el {teléfono} lo antes posible." |
| R-HANDOFF-OK | derivación iniciada, negocio cerrado | "He avisado a {negocio}. Ahora mismo no están atendiendo; te contactarán en el {teléfono} a partir de {franja}." (sin franja en 60 días: "…te contactarán en el {teléfono} en cuanto puedan.") |
| R-HANDOFF-COMPLAINT | queja derivada | "Siento las molestias. He pasado tu reclamación a {negocio}; te contactarán en el {teléfono}" + (" lo antes posible." · " a partir de {franja}.") |
| R-HANDOFF-COMPLAINT | queja sin vías o sin entrega | "Siento las molestias. Para tu reclamación, puedes contactar directamente con {negocio}." + CONTACTO |
| R-HANDOFF-FAIL | petición o consulta sin entrega (FR-012) | "No he podido avisar a {negocio} ahora mismo. Puedes contactar directamente:" + CONTACTO |
| R-HANDOFF-LATE | recordatorio (FR-019) | "{negocio} todavía no ha podido responderte. Si lo prefieres, puedes contactar directamente:" + CONTACTO |

En WhatsApp, "te contactarán en el {teléfono}" usa el número del propio cliente (su
`channel_user_id`), lo que deja claro que le llamarán o escribirán desde fuera de este chat.

## Procesador (`src/conversation/processor.ts`)

Cambios sobre la 004, en `processConversation`, después de las comprobaciones de negocio activo
y chat activado y antes de la ventana de WhatsApp:

1. `active = handoff.active(conversationId)`. Si hay derivación activa → `handoff.forward(...)`
   con los pendientes y **return** (sin respuesta, sin saludo, sin R-MEDIA; FR-013).
2. Si no, la cadena de siempre; el `ReplyContext` lleva `handoffStep` y `handoffEnded`.
3. Tras la respuesta del modelo, `handoff.decide(...)`; según la decisión, se compone la
   respuesta con las plantillas de arriba y, si toca, `handoff.start(...)` antes de `deliver`.
4. `handoff_step` y los datos de contacto se guardan en la misma transacción que el saliente.

`rateLimitNotice` envía R-LIMIT (con CONTACTO) también con derivación activa, como en la 002; los
entrantes limitados no se reenvían (R11, FR-013, FR-014).

## Reenvío durante la derivación (`forward`, FR-014)

- Un `BusinessNotice` `forward` por lote, con los ítems en orden; archivo sin texto →
  `[<otherType>]`; audio transcrito → su texto.
- Por las vías disponibles **ahora** (si el operador quitó una, ya no se usa).
- Entrantes → `forwarded` en la transacción que guarda los `handoff_notice`, aunque fallen
  todas las vías (se registra `handoff_forward_failed`).
- No crea salientes ni cuenta para el tope del chat web.

## Barrido (`sweep`, R14), cada 60 s

1. Inactividad: `UPDATE handoff SET status='ended', ended_at=now, end_cause='inactivity' FROM
   conversation WHERE … last_inbound_at <= now − 24 h`. Sin mensaje al cliente (FR-018). Las que
   se cierran sin `confirmed_at` y sin `reminder_sent_at` se marcan con `reminder_sent_at` en la
   misma sentencia (`RETURNING`) y, fuera de la transacción, reciben el aviso `reminder` por las
   vías, sin R-HANDOFF-LATE; `handoff_reminder_sent` con `trigger: 'inactivity'` y
   `customerNotified: false` (FR-019).
2. Recordatorio: `SELECT … WHERE status='active' AND confirmed_at IS NULL AND reminder_sent_at IS
   NULL AND reminder_due_at <= now FOR UPDATE SKIP LOCKED`, marca `reminder_sent_at` y, fuera de la
   transacción: aviso `reminder` por las vías + R-HANDOFF-LATE al cliente con la entrega de su
   canal (en WhatsApp solo dentro de la ventana de 24 h; si no, se registra y no se reintenta).

## Resumen (`HandoffSummarizer`, R4)

- Adaptador `src/llm/anthropic-summarizer.ts`: mismo SDK y modelo que la 002, esfuerzo `low`,
  salida estructurada `{ summary: string }`, `max_tokens` 400, sin el snapshot.
- Instrucciones fijas del núcleo (genéricas): "Resume en una o dos frases, en español y en
  tercera persona, qué necesita el cliente. Usa solo lo que el cliente ha escrito; no añadas
  datos, no supongas y no incluyas su nombre ni su teléfono. Si es una queja, empieza por
  'Queja:'. Si el cliente no explica el motivo, devuelve exactamente: 'El cliente pidió hablar con
  una persona sin dar el motivo.'" Los textos van como datos entre marcas, escapados como en la 002.
- Verificación: `extractFacts(summary)` ⊆ `extractFacts(textos del cliente)`; longitud ≤ 300;
  una línea. Si falla → respaldo por código (R4); `summary_source = fallback`.

## Cambios en el prompt de la respuesta (`src/llm/prompt.ts`)

- Regla de petición de persona: "marca handoffRequested y responde solo con una frase breve de
  acuse (por ejemplo, 'De acuerdo.'); el sistema se encarga del resto. No pidas datos ni el
  motivo."
- Regla nueva de quejas: "Si el cliente presenta una queja o reclamación sobre el negocio o un
  servicio recibido, marca complaint. No la resuelvas, no la justifiques ni des información sobre
  ella. Un comentario negativo que no reclama nada ('qué caro', 'vaya horario') no es una queja:
  contesta con normalidad."
- Indicaciones del sistema del turno final, según el estado:
  - `offered`: "En tu mensaje anterior ofreciste que el negocio contacte al cliente. Si ahora
    acepta, marca acceptsHandoff."
  - `collecting`: "Has pedido al cliente {su nombre / un teléfono / su nombre y un teléfono}.
    Copia literalmente en contactName y contactPhone lo que haya dado (null si no). Si no quiere
    darlos, marca refusesContact."
  - `handoffEnded`: "Esta conversación estuvo atendida por el negocio y ha vuelto a ti. Tenla en
    cuenta y no vuelvas a saludar."
- Los campos nuevos de la salida estructurada se añaden al esquema JSON y al "Formato de salida".

## Garantías verificables

- **V / SC-001**: toda petición de persona (bandera o detector) acaba en R-HANDOFF-OK, en
  R-HANDOFF-ASK seguido de derivación o de CONTACTO, o en CONTACTO directamente; ningún camino
  termina sin una de las dos cosas (test de tabla con todas las combinaciones).
- **FR-003 / SC-006**: con `complaint = true` la respuesta nunca contiene el cuerpo del modelo.
- **FR-010/012**: R-HANDOFF-OK solo existe si hay una fila `handoff` `active` con ≥ 1
  `handoff_notice` `sent`.
- **FR-013 / SC-004**: con derivación activa no se crea ningún saliente salvo R-HANDOFF-LATE (una
  vez por derivación) y R-LIMIT (con CONTACTO, como en la 002).
- **FR-015**: la derivación de una conversación no cambia cómo se procesa otra del mismo
  proceso (test con dos clientes a la vez).
- **FR-024**: `src/handoff`, las plantillas y los prompts pasan el test de neutralidad sectorial.
