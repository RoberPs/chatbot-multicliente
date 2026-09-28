# Data Model: Derivación de la conversación al negocio

**Feature**: `005-handoff-to-business` | **Plan**: [plan.md](plan.md) | **Research**: [research.md](research.md)

Parte del modelo de la 002 y la 004 ([data-model.md](../004-web-channel/data-model.md)). La
migración `0004_handoff` añade columnas a `conversation`, un valor al estado de los mensajes y
tres tablas. Una BD por instancia, sin `tenant_id`. Todo lo que es de una conversación se borra
con ella (FR-023).

## Cambios en tablas existentes

### `conversation`

| Columna | Tipo | Notas |
|---------|------|-------|
| `contact_name` | `text` | **nueva**. Nombre del cliente: el de perfil de WhatsApp (se actualiza en cada entrante que lo trae) o el que dio en la web/playground. Máx. 80 caracteres, sin saltos de línea |
| `contact_phone` | `text` | **nueva**. E.164. En WhatsApp se rellena con el `channel_user_id` al iniciar la derivación; en web/playground, el que dio el cliente, validado (FR-005) |
| `handoff_step` | `jsonb` | **nueva**, nullable. Paso previo a la derivación (R2); ver abajo |

`handoff_step` (Zod `handoffStepSchema` en `src/handoff/types.ts`):

```ts
type HandoffStep =
  | { step: 'offered'; kind: 'unresolved'; at: string }            // ISO 8601
  | {
      step: 'collecting';
      kind: HandoffKind;
      missing: Array<'name' | 'phone'>;   // no vacío
      phoneRetried: boolean;              // ya se pidió una segunda vez (FR-005)
      at: string;
    };
```

Transiciones: `null → offered` (oferta), `null → collecting` (petición/queja/aceptación sin
datos), `offered → collecting` (acepta sin datos), `offered → null` (no acepta, US2-3),
`collecting → collecting` (teléfono no válido, una vez), `collecting → null` (derivación
iniciada, datos rechazados o no dados). Se limpia también al iniciar una derivación.

### `message`

`message_status` gana el valor **`forwarded`**: entrante de una conversación derivada que se ha
reenviado al negocio en lugar de contestarse (R11). Es terminal, como `answered`.

- `claimReady` sigue reclamando por `pending`; `forwarded` no se vuelve a reclamar.
- `history()` incluye los entrantes `forwarded` (FR-018).
- `listForConversation()` los muestra como mensajes del cliente en la web y el playground.
- `hasPending()` no cambia; la API web y el playground devuelven `waiting = false` mientras hay
  derivación activa.

La migración añade el valor con `ALTER TYPE message_status ADD VALUE 'forwarded'` en una
sentencia propia (no se usa en la misma transacción).

## Tablas nuevas

### `handoff` — derivación de una conversación

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | `uuid` PK | generado en memoria antes de enviar el aviso (R12) |
| `conversation_id` | `uuid` NOT NULL → `conversation.id` `ON DELETE CASCADE` | |
| `kind` | `handoff_kind` NOT NULL | enum `person` · `unresolved` · `complaint` |
| `status` | `handoff_status` NOT NULL | enum `active` · `ended` |
| `summary` | `text` NOT NULL | resumen del motivo, ≤ 300 caracteres, una línea (R4) |
| `summary_source` | `handoff_summary_source` NOT NULL | enum `model` · `fallback` (para la evaluación de SC-003) |
| `token_hash` | `bytea` NOT NULL UNIQUE | `sha256(token)` (R9) |
| `started_at` | `timestamptz` NOT NULL | |
| `confirmed_at` | `timestamptz` | "Le atiendo" o "Terminado" (FR-016) |
| `confirmed_via` | `handoff_action_via` | enum `whatsapp` · `email`; nulo si no se confirmó |
| `reminder_due_at` | `timestamptz` | 2 h de horario después de `started_at` (R13); nulo si no hay franja en 60 días |
| `reminder_sent_at` | `timestamptz` | FR-019, una vez |
| `ended_at` | `timestamptz` | |
| `end_cause` | `handoff_end_cause` | enum `business` · `inactivity` · `operator` · `playground` |

Restricciones e índices:

- `UNIQUE (conversation_id) WHERE status = 'active'` — como mucho una derivación activa por
  conversación (Key Entities).
- `CHECK ((status = 'ended') = (ended_at IS NOT NULL AND end_cause IS NOT NULL))`.
- `CHECK ((confirmed_at IS NULL) = (confirmed_via IS NULL))`. Solo el negocio confirma: terminar
  desde el panel, desde "Probar el bot" o por inactividad deja `confirmed_*` como estaba.
- Índice `(status, reminder_due_at)` para el barrido.

Estados:

```text
            aviso entregado (R12)
 (ninguna) ─────────────────────▶ active ──┬─ "Terminado" (WhatsApp/email) ─▶ ended(business)
                                    │      ├─ 24 h sin mensajes del cliente ─▶ ended(inactivity)
         "Le atiendo" ─▶ confirmed_at      ├─ operador en el panel ─────────▶ ended(operator)
         2 h de horario sin confirmar      └─ operador en "Probar el bot" ──▶ ended(playground)
           ─▶ reminder_sent_at (una vez)
```

Una derivación `ended` no vuelve a `active`; una nueva petición crea otra fila.

### `handoff_notice` — cada mensaje al negocio, por vía

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | `uuid` PK | |
| `handoff_id` | `uuid` NOT NULL → `handoff.id` `ON DELETE CASCADE` | |
| `type` | `handoff_notice_type` NOT NULL | enum `alert` · `reminder` · `forward` |
| `route` | `handoff_route` NOT NULL | enum `whatsapp` · `email` · `simulated` |
| `status` | `handoff_notice_status` NOT NULL | enum `sent` · `failed` |
| `failure` | `text` | código corto de fallo (`template_rejected`, `timeout`, `smtp_4xx`…); nunca textos del cliente |
| `provider_ref` | `text` | `wamid` o `Message-ID` del email (hilo de R7) |
| `messages_covered` | `smallint` | solo `forward`: entrantes reenviados |
| `body` | `text` | **solo** con `route = simulated` (playground, FR-021): texto del aviso para el operador |
| `created_at` | `timestamptz` NOT NULL | |

Es el "resultado de la entrega por vía" de la Key Entity *Aviso de derivación*. Los avisos que
no llegaron a crear derivación (R12, paso 4) no se guardan: solo quedan en los registros.

### `handoff_alerts` — destinos de los avisos (singleton, R16)

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | `smallint` PK = 1 | `CHECK (id = 1)`; la migración crea la fila vacía |
| `whatsapp_phone` | `text` | E.164, opcional |
| `email` | `text` | opcional, en minúsculas |
| `updated_at` | `timestamptz` | patrón de la 001 |

Validación (`handoffAlertsSchema`, Zod, en `src/handoff/schemas.ts`):

- `whatsapp_phone`: vacío → `null`; si no, libphonenumber-js con `DEFAULT_PHONE_REGION`,
  `isValid()` y se guarda `number` (E.164). Mensaje: "Indica un teléfono válido, con prefijo si
  no es de España".
- `email`: vacío → `null`; `z.email()`, recortado y en minúsculas. Mensaje: "Indica un email
  válido".
- Los dos pueden quedar vacíos (FR-020: no bloquea la activación).

No forma parte del `KnowledgeSnapshot` (el bot no lo ve). Sí forma parte de `KnowledgeState`
como `handoffAlerts` para calcular los avisos del panel.

## Entidades del dominio (sin tabla)

### `HandoffKind`

`'person' | 'unresolved' | 'complaint'` — petición de persona, consulta sin resolver (incluye lo
que no se gestiona por este medio, como reservar) y queja o reclamación.

### Vías disponibles

```ts
interface AlertAvailability {
  whatsapp: boolean;   // destino configurado && instancia con canal WhatsApp
  email: boolean;      // destino configurado && SMTP_URL && SMTP_FROM && PUBLIC_BASE_URL
}
```

Se calcula en cada uso leyendo `handoff_alerts` sin caché. En el playground siempre hay una vía,
`simulated`.

### `BusinessNotice` (lo que componen el dominio y consumen las vías)

```ts
type BusinessNotice =
  | { type: 'alert'; handoff: NoticeHandoff }
  | { type: 'reminder'; handoff: NoticeHandoff; waitingSince: Date }
  | { type: 'forward'; handoff: NoticeHandoff; items: Array<{ text: string | null; kind: MessageKind; otherType: string | null }> };

interface NoticeHandoff {
  id: string;
  kind: HandoffKind;
  customerName: string;
  customerPhone: string;      // E.164
  channel: Channel;           // 'whatsapp' | 'web' | 'playground'
  summary: string;
  startedAt: Date;
  timezone: string;           // para escribir horas locales en el aviso
  token: string;              // en claro solo en memoria, para botones y enlaces
  threadRef: string | null;   // Message-ID del aviso por email (recordatorio y reenvíos)
}
```

### Cambios en tipos existentes

- `modelReplySchema` (`src/conversation/types.ts`): + `complaint`, `acceptsHandoff`,
  `contactName`, `contactPhone`, `refusesContact` (R3).
- `ReplyContext`: + `handoffStep: HandoffStep | null` y `handoffEnded: boolean` (hubo una
  derivación terminada en esta conversación), que el prompt convierte en indicaciones.
- `ReplyTemplate` y `replyTraceSchema.template`: + `R-HANDOFF-ASK`, `R-HANDOFF-PHONE`,
  `R-HANDOFF-OK`, `R-HANDOFF-COMPLAINT`, `R-HANDOFF-LATE`.
- `ContactReason`: + `handoff_unavailable` (petición o queja sin vías o con el aviso no
  entregado, FR-012) y `contact_refused` (el cliente no dio sus datos, FR-004); `offer_contact` y
  `booking_requested` siguen existiendo para cuando no hay vías.
- `ReplyTrace`: + `handoff` opcional (sin textos):

  ```ts
  handoff?: {
    action: 'offered' | 'asked' | 'asked_again' | 'started' | 'not_started' | 'late_notice';
    kind: HandoffKind | null;
    routes: Partial<Record<'whatsapp' | 'email' | 'simulated', 'sent' | 'failed'>>;
  };
  ```

- `InboundEvent`: + `profileName: string | null` (WhatsApp) y `buttonPayload: string | null`
  (respuesta rápida de una plantilla); en web y playground son `null`.
- `ChannelPolicy`: + `contactFromChannel: boolean` (solo WhatsApp) y `simulateAlerts: boolean`
  (solo playground) (R15).
- `KnowledgeState`: + `handoffAlerts: { whatsapp: string | null; email: string | null;
  routes: { whatsapp: boolean; email: boolean } }` (R16).
- `WarningCode`: + `HANDOFF_ALERTS_NONE`, `HANDOFF_ALERTS_SINGLE`; `WarningTargetKind` +
  `handoff_alerts` (enlace a `/admin/handoffs`).

## Retención (FR-023)

Sin cambios de lógica: al borrar una conversación caen en cascada sus mensajes, `handoff` y
`handoff_notice`, y con ellos `contact_name`, `contact_phone` y `handoff_step`. Una derivación
activa no impide el borrado: a los 30 días sin mensajes hace mucho que terminó por inactividad.

## Tablas para tests

`conversationTableNames` pasa a
`['handoff_notice', 'handoff', 'message', 'conversation', 'customer', 'web_usage_day']`;
`handoff_alerts` se restablece a vacío (no se trunca: es singleton).
