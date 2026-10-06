# Data Model: Canal web del bot de atención

**Feature**: `004-web-channel` | **Plan**: [plan.md](plan.md) | **Research**: [research.md](research.md)

Parte del modelo de la 002 ([data-model.md](../002-whatsapp-faq-bot/data-model.md)). La
migración `0002_channels` lo generaliza a varios canales conservando todas las filas (FR-005,
R2) y añade la configuración y el uso del chat web. Una BD por instancia, sin `tenant_id`.

## Cambios en tablas existentes

### `customer` — cliente final de cualquier canal

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | `uuid` PK | sin cambios |
| `channel` | `customer_channel` NOT NULL | **nuevo**. Enum `whatsapp` · `web` · `playground`. Las filas existentes quedan en `whatsapp` |
| `channel_user_id` | `text` NOT NULL | **renombrada** desde `phone`. WhatsApp: E.164. Web: `hex(SHA-256(id de sesión))`, 64 caracteres. Playground: UUID |
| `rate_limit_notified_at` | `timestamptz` | sin cambios (FR-024 usa la misma regla) |
| `created_at` | `timestamptz` | sin cambios |

- `UNIQUE(channel, channel_user_id)` sustituye a `customer_phone_unique` (FR-001).
- Validación por canal (Zod en `src/conversation/channels.ts`): E.164 · `^[0-9a-f]{64}$` ·
  UUID.
- No se relacionan clientes entre canales (edge case "mismo negocio, dos canales").

### `conversation` — sin cambios de columnas

La regla de las 24 h (FR-019) se aplica en la recepción igual para todos los canales:
conversación nueva si han pasado más de 24 h desde `last_inbound_at`. En la web, `sent_at` del
entrante es la hora del servidor (no se confía en el reloj del navegador).

### `message`

| Columna | Cambio |
|---------|--------|
| `channel_message_id` | **renombrada** desde `wa_message_id`; sigue `UNIQUE`. WhatsApp: id de Meta. Web entrante: `web:<channel_user_id>:<clientMessageId>`. Playground entrante: `pg:<channel_user_id>:<uuid>`. Salientes web/playground: `out:<uuid>` |
| `reply_trace` | **nueva**, `jsonb` nullable. Solo en salientes; ver abajo (R7) |

`kind` en web y playground es siempre `text` (FR-020). Estados y transiciones, los de la 002,
con dos motivos más de descarte en los registros (`quota`, `disabled`).

#### `reply_trace` (R7, FR-009)

```ts
interface ReplyTrace {
  template: 'R-SAFE' | 'R-ERR' | 'R-MEDIA' | 'R-AUDIO' | 'R-LIMIT' | 'R-UNAVAILABLE' | null;
  greeting: boolean;
  contact: {
    added: boolean;
    reason: 'handoff_requested' | 'offer_contact' | 'booking_requested'
          | 'price_on_request' | 'template' | null;   // null si added = false
  };
  groundingRejections: number;   // 0, 1 o 2; nunca los valores rechazados
  modelMs: number | null;        // null si no se llamó al modelo
  latencyMs: number;             // desde el último entrante cubierto hasta guardar/enviar
}
```

Esquema Zod `replyTraceSchema` en `src/conversation/types.ts`. Sin textos ni datos
personales; se borra con la conversación.

## Tablas nuevas

### `web_chat_settings` — configuración del chat web (singleton, R8)

| Columna | Tipo | Notas |
|---------|------|-------|
| `id` | `smallint` PK = 1 | `CHECK (id = 1)`; la migración crea la fila |
| `enabled` | `boolean` NOT NULL DEFAULT `false` | FR-014 |
| `allowed_origins` | `text[]` NOT NULL DEFAULT `'{}'` | orígenes normalizados, máximo 10 |
| `privacy_url` | `text` | URL `https` |
| `daily_cap` | `integer` NOT NULL DEFAULT 200 | `CHECK (daily_cap >= 1)` |
| `monthly_cap` | `integer` NOT NULL DEFAULT 3000 | `CHECK (monthly_cap >= daily_cap)` |
| `updated_at` | `timestamptz` | patrón de la 001 |

Reglas de validación (`webChatSettingsSchema`, Zod):

- Origen: `URL` válida con solo esquema, host y puerto; `https:`, o `http:` si el host es
  `localhost` o `127.0.0.1`; se guarda `url.origin` en minúsculas; sin duplicados.
- `enabled = true` exige `allowed_origins` no vacío y `privacy_url` (FR-015). Errores por campo
  con los mensajes del panel ("Indica al menos una web donde se mostrará el chat", …).
- Desactivar siempre se permite y conserva orígenes, URL y topes.

No es parte del `KnowledgeSnapshot` ni de `computeWarnings`: el bot no la usa para redactar.

### `web_usage_day` — respuestas del canal web por día local (R9)

| Columna | Tipo | Notas |
|---------|------|-------|
| `day` | `date` PK | fecha en la zona horaria del negocio (`business.timezone`) |
| `replies` | `integer` NOT NULL DEFAULT 0 | salientes `web` generados por la cadena |

- Se incrementa con `INSERT … ON CONFLICT (day) DO UPDATE SET replies = replies + 1` en la
  transacción que crea el saliente `web` (excepto R-UNAVAILABLE, que no cuenta).
- Uso del mes = `sum(replies)` de los días del mes local en curso.
- Tope alcanzado ⇔ `hoy ≥ daily_cap` **o** `mes ≥ monthly_cap`.
- Las filas de más de 400 días se borran en la pasada de retención.
- El playground no escribe aquí (FR-012).

## Entidades del dominio (sin tabla)

### `Channel` y `ChannelPolicy` (R1)

```ts
type Channel = 'whatsapp' | 'web' | 'playground';

interface ChannelPolicy {
  sender: ChannelSender;             // Graph API o entrega guardada
  replyWindowMs: number | null;      // 24 h en WhatsApp; null en los demás
  requiresActiveBusiness: boolean;   // false solo en playground
  requiresWebChatEnabled: boolean;   // true solo en web
  usageCap: boolean;                 // true solo en web
}
```

### `InboundEvent` generalizado

| Campo | Antes | Ahora |
|-------|-------|-------|
| canal | implícito | `channel: Channel` |
| cliente | `from` (E.164) | `channelUserId` |
| id del mensaje | `waMessageId` | `channelMessageId` |
| resto | `sentAt`, `kind`, `text`, `caption`, `mediaId`, `otherType`, `isGroup` | igual |

### Sesión web (R4)

Token `base64url(id) + "." + base64url(HMAC)`; solo existe en el navegador. En el servidor se
deriva `channel_user_id = hex(SHA-256(id))`. No hay tabla de sesiones.

### Conversación de prueba del operador (R6)

`playgroundId` (UUID) en la sesión cifrada del operador → cliente
`(playground, playgroundId)`. "Nueva conversación" sustituye el UUID.

## Retención (FR-012, FR-028)

La pasada horaria de la 002 no cambia de lógica: borra conversaciones sin mensajes desde hace
30 días (con sus mensajes y `reply_trace`) y los clientes huérfanos de **cualquier canal**.
Añade el borrado de `web_usage_day` con más de 400 días. La IP nunca llega a la BD (FR-029).

## Tablas para tests

`conversationTableNames` pasa a `['message', 'conversation', 'customer', 'web_usage_day']`;
`web_chat_settings` se restablece a sus valores por defecto (no se trunca: es singleton).
