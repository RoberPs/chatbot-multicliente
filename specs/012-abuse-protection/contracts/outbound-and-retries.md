# Contrato: llamadas salientes y reintentos de lotes

**Feature**: 012 · US5 · FR-025 – FR-027 · research R10, R11.

## Plazos

| Llamada | Plazo por petición | Plazo total | Al vencer |
|---|---|---|---|
| Graph API `POST /messages` (texto) | 10 s | 30 s con reintentos (1 s, 4 s, 15 s mientras quepa) | `ChannelSendError` → `send_failed` |
| Graph API `POST /messages` (plantillas de avisos) | 10 s | 15 s por vía (005) | `failure: 'timeout'` |
| Graph API `GET /{media-id}` (metadatos de audio) | 5 s | — | `transcription_failed { reason: 'timeout' }` |
| Descarga del audio | — | plazo de la transcripción (10 s) compartido con la transcripción | `transcription_failed { reason: 'timeout' }` |
| SMTP | conexión 10 s, saludo 10 s, socket 14 s | 15 s por vía (005) | `failure: 'timeout'` |
| Modelo, resumen y transcripción | sin cambios (002, 005, 010) | | |

Puertos: `MediaFetcher.fetchAudio(mediaId, maxBytes, { signal })` y
`ChannelSender.sendText(to, body, { canRetry, signal? })`.

## Reintentos de un lote

Lote = los entrantes `pending` de una conversación cuando el procesador la reclama.

| Intento fallido | Espera antes del siguiente |
|---|---|
| 1 | 5 s |
| 2 | 30 s |
| 3 | 2 min |
| 4 | 10 min |
| 5 | se abandona |

- Fallo = `processConversation` lanza (BD, error imprevisto). Se registra
  `batch_retry_scheduled { attempt, delayMs, errorClass }`.
- Abandono: R-ERR (disculpa + contacto del negocio o, sin snapshot, el de emergencia) cubriendo los
  pendientes, una sola vez; `batch_abandoned { attempts, apologySent }`; contador a 0.
- Éxito (saliente guardado, reenvío marcado o mensajes descartados por la política del canal):
  contador a 0 y `process_after` nulo.
- Un entrante nuevo durante la espera se une al lote (mismo contador). Tras el abandono, un entrante
  nuevo empieza otro lote.

## Como mucho una vez

| Efecto | Se marca antes de enviar | En un reintento |
|---|---|---|
| Respuesta al cliente | saliente guardado + entrantes `answered` | no se repite (ya cubiertos) |
| Reenvío al negocio | entrantes `forwarded` + plaza diaria + `last_notice_at` | no se repite |
| Recordatorio | `claimDueReminders` (005) | no se repite |
| Alerta de derivación nueva | derivación guardada con `alerts_sent_at` nulo | `alerts_sent_at` nulo → fin `interrupted` + R-HANDOFF-FAIL + CONTACTO; con `alerts_sent_at` y sin `customer_notified_at` → solo la confirmación |
| R-LIMIT | `rate_limit_notified_at` (002) | no se repite |
