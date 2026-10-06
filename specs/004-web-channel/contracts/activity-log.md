# Contrato: registros técnicos — cambios por canales

**Feature**: `004-web-channel` | Fuente: FR-006, FR-028, FR-029, SC-008 | Research: R10, R12

Amplía el catálogo cerrado de la 002
([activity-log.md](../../002-whatsapp-faq-bot/contracts/activity-log.md)). Las reglas comunes
siguen: ningún texto de mensajes, respuestas, prompts ni valores rechazados.

## Cambios en las reglas comunes

- Campo nuevo **`via`**: `whatsapp` · `web` · `playground`, en todo evento con cliente o
  conversación. `channel: "bot"` se mantiene como categoría del logger.
- `customer` = 12 hex de `HMAC-SHA256(channel + ":" + channel_user_id)` con la misma clave
  (HKDF de `SESSION_SECRET`, `info = "bot-log"`). En la web, `channel_user_id` ya es un hash;
  el token de sesión nunca llega al registro.
- `EventContext` pasa de `{ phone, conversationId }` a `{ channel, customerKey,
  conversationId }`.
- **Sin IP**: el serializador de peticiones del logger de Fastify deja fuera `remoteAddress` y
  `remotePort` en toda la app; `hostname` y `url` se mantienen (la API del chat no lleva datos
  del visitante en la URL).
- Los ids `channel_message_id` no se registran (como los de WhatsApp en la 002).

## Eventos modificados

| `event` | Cambio |
|---------|--------|
| `message_discarded` | `reason` añade `disabled` (chat web desactivado) y `quota` (tope alcanzado) |
| `reply_sent` | añade `groundingRejections` (0 – 2) y `template` admite `R-UNAVAILABLE` |

## Eventos nuevos

| `event` | Nivel | Campos | Cuándo |
|---------|-------|--------|--------|
| `web_session_created` | debug | — | `POST /chat/api/session` con éxito |
| `web_rejected` | warn | `reason`: `origin` \| `session` \| `session_limit` \| `ip_limit` \| `invalid` | Petición al chat rechazada antes de la recepción (FR-025, FR-027). Sin cliente |
| `web_quota_reached` | warn | `period`: `day` \| `month`, `cap` | La primera vez que se alcanza cada tope en su periodo (FR-026) |

`web_quota_reached` se emite una vez por periodo y proceso (memoria); tras un reinicio puede
repetirse una vez.

## Garantías verificables

1. Test de integración: una conversación web completa (sesión, mensajes, límite, tope) y se
   buscan en todos los registros el token, el `channel_user_id` en claro, los textos enviados y
   la IP del `fastify.inject` (`remoteAddress`): ninguno aparece (SC-008).
2. El mismo `channel_user_id` en dos canales produce seudónimos distintos.
3. Todos los eventos con conversación llevan `via`.
