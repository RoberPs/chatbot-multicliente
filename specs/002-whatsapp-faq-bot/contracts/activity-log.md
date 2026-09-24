# Contrato: registros técnicos del bot

**Feature**: `002-whatsapp-faq-bot` | Fuente: FR-030a | Research: R11

Eventos JSON emitidos con el logger de la app (pino) en el canal `bot`. Catálogo cerrado:
cualquier evento nuevo se añade aquí.

## Reglas comunes

- **Nunca** contienen el texto de mensajes, transcripciones, cuerpos de respuesta, pies de
  foto, prompts ni valores rechazados por el verificador.
- El cliente aparece solo como `customer`: seudónimo de 12 caracteres hex,
  `HMAC-SHA256(phone)` con clave derivada por HKDF de `SESSION_SECRET` (`info = "bot-log"`).
- Los ids de mensaje de WhatsApp no se registran (identifican al cliente ante Meta); se usa
  el `id` interno.
- Campos comunes: `event`, `customer` (si aplica), `conversationId` (si aplica).

## Eventos

| `event` | Nivel | Campos adicionales | Cuándo |
|---------|-------|--------------------|--------|
| `message_received` | info | `kind`, `otherType?` | Entrante guardado |
| `message_discarded` | info | `reason`: `not_active` \| `group` \| `outside_window` \| `deactivated` | FR-002, FR-002a, FR-005 |
| `duplicate_ignored` | debug | — | Id de WhatsApp repetido |
| `rate_limit_exceeded` | warn | `count`, `windowMinutes`, `noticeSent` | FR-004a |
| `reply_sent` | info | `messagesCovered`, `kinds`, `latencyMs` (desde el último entrante hasta la confirmación de envío), `waitMs`, `modelMs?`, `greeting`, `contactBlock`, `template?` | Cada respuesta enviada |
| `transcription_failed` | warn | `reason`: `too_large` \| `too_long` \| `language` \| `empty` \| `timeout` \| `provider_error` | FR-028 |
| `knowledge_read_failed` | error | `errorClass`, `stage`: `intake` \| `processor` | FR-029; en `intake` el webhook responde `503` |
| `generation_failed` | error | `reason`: `timeout` \| `refusal` \| `invalid_output` \| `api_error`, `status?` | FR-029 |
| `grounding_rejected` | warn | `attempt`, `offendingCount` | R8 |
| `send_failed` | error | `attempts`, `status?`, `finalFailure` | Envío a la Graph API |
| `webhook_rejected` | warn | `reason`: `signature` \| `payload` | Contrato del webhook |
| `retention_purged` | info | `conversations`, `customers` | Borrado horario (FR-030) |

`latencyMs` permite calcular SC-003 a partir de los registros.

## Verificación

Un test de integración recorre los escenarios principales con textos marcados
(`"MARCA-7f3a"`), número y caption conocidos, captura la salida del logger y comprueba que
ninguna línea contiene esas marcas ni el número en claro.
