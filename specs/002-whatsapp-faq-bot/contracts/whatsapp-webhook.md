# Contrato: webhook de WhatsApp y envío de mensajes

**Feature**: `002-whatsapp-faq-bot` | Fuente: FR-001, FR-002, FR-004, FR-005, FR-028, FR-028a | Research: R1, R2, R3

Interfaz HTTP pública de la instancia hacia Meta (WhatsApp Cloud API). Solo existe si las
cinco variables `WHATSAPP_*` están definidas.

## `GET /webhooks/whatsapp` — verificación del alta

| Query | Condición | Respuesta |
|-------|-----------|-----------|
| `hub.mode=subscribe`, `hub.verify_token` = `WHATSAPP_VERIFY_TOKEN` (comparación en tiempo constante) | correcta | `200 text/plain` con el valor de `hub.challenge` |
| cualquier otra | — | `403` |

## `POST /webhooks/whatsapp` — eventos

**Petición**: `application/json`, cuerpo ≤ 512 KB, cabecera `X-Hub-Signature-256:
sha256=<hex>` = HMAC-SHA256 del cuerpo en bruto con `WHATSAPP_APP_SECRET`.

| Caso | Respuesta | Efecto |
|------|-----------|--------|
| Firma ausente o incorrecta | `401` | Ninguno; evento `webhook_rejected` |
| JSON que no es un evento `whatsapp_business_account` válido (Zod) | `400` | Ninguno; evento `webhook_rejected` |
| `phone_number_id` distinto de `WHATSAPP_PHONE_NUMBER_ID` | `200` | Se ignora |
| Solo `statuses` (sent/delivered/read/failed) | `200` | Se ignora (un `failed` de un saliente se registra como `send_failed`) |
| Mensaje de grupo | `200` | Se ignora (FR-005); evento `message_discarded{reason: group}` |
| Negocio no activo | `200` | **No se guarda**; evento `message_discarded{reason: not_active}` (FR-002) |
| Mensaje con `id` ya guardado | `200` | Nada (deduplicación, FR-004) |
| Mensaje nuevo | `200` | Se guarda como `pending` (o `rate_limited`, R6) en una transacción **antes** de responder; se despierta el procesador |

El `200` se devuelve en cuanto los mensajes están persistidos; generar y enviar la respuesta
es asíncrono. Objetivo: p95 < 150 ms.

### Mapeo de tipos de mensaje

| `type` de WhatsApp | `kind` | `body` guardado | Tratamiento |
|--------------------|--------|-----------------|-------------|
| `text` | `text` | `text.body` | Normal |
| `audio` (incluye notas de voz), con `AUDIO_TRANSCRIPTION=on` | `audio` | transcripción | Se descarga y transcribe en paralelo a la espera (R10); fallo → no entendido (FR-028) |
| `audio`, con `AUDIO_TRANSCRIPTION=off` (por defecto) | `other` (`other_type = audio`) | null | No se descarga; aviso de tipos atendidos (FR-028a) |
| `image`, `video`, `document` | `other` | `caption` si existe | Se responde al pie, si lo hay, y se avisa de que no se ve el archivo (FR-028a) |
| `sticker`, `location`, `contacts`, `reaction`, `interactive`, `button`, `unsupported`, otros | `other` | null | Aviso de tipos atendidos (FR-028a) |

`from` se normaliza a E.164. El nombre de perfil (`contacts[].profile.name`) no se guarda.

## Envío: Graph API

```text
POST https://graph.facebook.com/{WHATSAPP_GRAPH_VERSION}/{WHATSAPP_PHONE_NUMBER_ID}/messages
Authorization: Bearer {WHATSAPP_ACCESS_TOKEN}
{ "messaging_product": "whatsapp", "to": "<E.164 sin +>", "type": "text",
  "text": { "body": "<≤ 4096 caracteres>", "preview_url": false } }
```

- Una respuesta = un mensaje. Si el texto compuesto supera 4096 caracteres, se recorta el
  cuerpo del modelo (nunca el saludo ni el bloque de contacto) y se registra.
- Reintentos ante 429/5xx/red: 3 intentos (1 s, 4 s, 15 s), solo si sigue abierta la ventana
  de 24 h. Un 4xx distinto de 429 no se reintenta.

## Descarga de audio (solo con `AUDIO_TRANSCRIPTION=on`)

`GET /{media-id}` → URL temporal; `GET <url>` con el mismo token. Se rechaza sin descargar
entero si `Content-Length` > 2 MB. El contenido solo vive en memoria durante la
transcripción.

## Puertos del dominio

El dominio (`src/conversation`) no conoce HTTP ni la Graph API:

```ts
interface ChannelSender {
  /** Envía un texto al número E.164. Devuelve el id del mensaje del canal. */
  sendText(to: string, body: string): Promise<{ channelMessageId: string }>;
}

interface MediaFetcher {
  /** Devuelve el audio en memoria o lanza si supera el límite. */
  fetchAudio(mediaId: string, maxBytes: number): Promise<{ data: Buffer; mimeType: string }>;
}
```

Implementaciones: `src/channels/whatsapp/` (real), consola (`pnpm bot:chat`) y falsas en tests.
