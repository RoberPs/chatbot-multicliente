# Data Model: Atención automática de dudas y precios por WhatsApp

**Feature**: `002-whatsapp-faq-bot` | **Fecha**: 2026-09-24 | **Plan**: [plan.md](plan.md)

Tablas nuevas en la BD de la instancia (migración `0001`), sin `tenant_id` (una BD por
instancia). Las tablas de la 001 no cambian: el bot lee la información del negocio solo a
través de `KnowledgeReader.getSnapshot()`.

Todas las marcas de tiempo de esta feature son **instantes** (`timestamptz`, sesión en UTC).
La hora local del negocio se calcula al responder con su zona horaria IANA; los horarios del
negocio siguen guardándose en hora local (convención de la 001).

```text
customer 1 ──< conversation 1 ──< message
                                   ▲  │ reply_id (entrante → saliente que lo cubre)
                                   └──┘
```

---

## customer — Cliente final

| Campo | Tipo | Reglas |
|-------|------|--------|
| `id` | uuid PK | |
| `phone` | text, único | E.164 (`+34600111222`), normalizado con libphonenumber-js a partir del `from` de WhatsApp |
| `rate_limit_notified_at` | timestamptz null | Último aviso de límite enviado (R6); evita repetirlo en la misma ventana |
| `created_at` | timestamptz | |

- No se guarda ningún otro dato del cliente (nombre de perfil de WhatsApp incluido).
- Se borra cuando no le quedan conversaciones (FR-030).

## conversation — Conversación

| Campo | Tipo | Reglas |
|-------|------|--------|
| `id` | uuid PK | |
| `customer_id` | uuid FK → customer, `ON DELETE CASCADE` | |
| `started_at` | timestamptz | Marca del primer mensaje entrante |
| `last_inbound_at` | timestamptz | Marca de WhatsApp del último entrante; decide conversación nueva (FR-019) y ventana de 24 h (FR-002a) |
| `last_message_at` | timestamptz | Último mensaje entrante o saliente; decide el borrado a 30 días (FR-030) |
| `greeted` | boolean, def. false | `true` en cuanto se envía la primera respuesta (lleva el saludo, FR-020/021) |

Índices: `(customer_id, last_inbound_at desc)`; `(last_message_at)` para el borrado.

**Regla de apertura** (FR-019): al recibir un mensaje con marca `t` de un número, se usa su
conversación más reciente si `t − last_inbound_at ≤ 24 h`; si no, o si no tiene ninguna, se
crea una nueva.

## message — Mensaje

| Campo | Tipo | Reglas |
|-------|------|--------|
| `id` | uuid PK | |
| `conversation_id` | uuid FK → conversation, `ON DELETE CASCADE` | |
| `direction` | enum `inbound` \| `outbound` | |
| `kind` | enum `text` \| `audio` \| `other` | Salientes siempre `text` |
| `wa_message_id` | text null, **único** | Id de WhatsApp (entrantes: deduplicación, FR-004; salientes: id devuelto por la Graph API) |
| `body` | text null | Entrante texto: el texto. Audio: la transcripción (null mientras se transcribe o si falla). Otro tipo: el pie o texto que lo acompaña, si lo hay. Saliente: el texto enviado |
| `other_type` | text null | Solo `kind = other`: tipo de WhatsApp (`image`, `sticker`, `video`…) para el aviso y los registros |
| `sent_at` | timestamptz | Entrante: `timestamp` de WhatsApp. Saliente: momento de envío confirmado |
| `received_at` | timestamptz | Momento en que el sistema lo guardó |
| `status` | enum (ver abajo) | |
| `transcription` | enum `pending` \| `done` \| `failed` null | Solo audios |
| `reply_id` | uuid null FK → message | Entrante: respuesta saliente que lo cubre. Un saliente cubre uno o varios entrantes |

Índices: único `wa_message_id`; `(conversation_id, sent_at)`; parcial
`(conversation_id) where direction = 'inbound' and status = 'pending'` para el procesador.

### Estados del mensaje entrante

```text
                ┌──────────────► rate_limited   (FR-004a: por encima del límite; nunca se contesta)
                │
recibido ──► pending ──► answered      (cubierto por una respuesta: reply_id ≠ null)
                │
                └──────────────► discarded      (FR-002a: fuera de la ventana de 24 h al procesarse)
```

- Si al procesar el negocio ya no está activo, los `pending` se **borran** (FR-002: no pueden
  quedar guardados para contestarse después).
- Un `pending` pasa a `answered` en la misma transacción en que se crea el saliente que lo
  cubre, por lo que ningún entrante queda cubierto dos veces.

### Estados del mensaje saliente

```text
sending ──► sent        (la Graph API devolvió id)
   │
   └──────► failed      (tras 3 intentos con espera 1 s / 4 s / 15 s, o fuera de la ventana de 24 h)
```

Los entrantes cubiertos por un saliente `failed` quedan `answered` (no se vuelve a generar
otra respuesta); el fallo se registra (FR-030a).

---

## Reglas que dependen de los datos

| Regla | Consulta |
|-------|----------|
| Deduplicación (FR-004) | `insert … on conflict (wa_message_id) do nothing` |
| Conversación nueva (FR-019) | Última conversación del cliente y su `last_inbound_at` |
| Lista para responder (R5) | Existe `pending` y (`now − max(received_at) ≥ 3 s` o `now − min(received_at) ≥ 8 s`) y ningún audio con `transcription = pending` de menos de 10 s |
| Límite por número (FR-004a) | Entrantes del cliente con `received_at > now − 15 min` > 30 |
| Aviso de límite único | `rate_limit_notified_at` nulo o anterior a `now − 15 min` |
| Ventana de 24 h (FR-002a) | `now − conversation.last_inbound_at ≤ 24 h` al procesar y al (re)intentar el envío |
| Borrado (FR-030) | `delete from conversation where last_message_at < now − 30 días`; después `delete from customer where not exists (conversation)` |

## Tipos en memoria (dominio, sin tabla)

- **`InboundEvent`** (salida del parser del webhook, Zod): `{ waMessageId, from, sentAt,
  kind, text | caption | mediaId, otherType, isGroup }`.
- **`ReplyContext`** (entrada del `ChatModel`, [contracts/chat-model.md](contracts/chat-model.md)):
  snapshot + hechos derivados + historial + mensajes pendientes.
- **`ModelReply`** (salida estructurada del modelo, validada con Zod).
- **`AllowedFacts`**: conjunto de cifras y valores permitidos para el verificador (R8),
  derivado del snapshot y los hechos calculados.
