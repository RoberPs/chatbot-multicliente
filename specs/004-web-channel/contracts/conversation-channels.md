# Contrato: núcleo de conversación multicanal

**Feature**: `004-web-channel` | Fuente: FR-001 – FR-006, FR-008, FR-012, FR-022 – FR-026 |
Research: R1, R5, R7, R9, R13

Cambios sobre los contratos de la 002
([whatsapp-webhook.md](../../002-whatsapp-faq-bot/contracts/whatsapp-webhook.md),
[bot-replies.md](../../002-whatsapp-faq-bot/contracts/bot-replies.md)). Lo que no se menciona
aquí no cambia.

## Puertos (`src/conversation/ports.ts`)

```ts
export type Channel = 'whatsapp' | 'web' | 'playground';

export interface ChannelSender {
  /** `to` es el channel_user_id. Devuelve el id del saliente en el canal. */
  sendText(to: string, body: string, opts?: SendOptions): Promise<{ channelMessageId: string }>;
}

/** Canales cuyas respuestas se guardan y el cliente recoge (web y playground). */
export const storedDelivery: ChannelSender; // devuelve { channelMessageId: `out:${uuid}` }

export interface ChannelPolicy {
  sender: ChannelSender;
  replyWindowMs: number | null;
  requiresActiveBusiness: boolean;
  requiresWebChatEnabled: boolean;
  usageCap: boolean;
}

export type ChannelPolicies = Record<Channel, ChannelPolicy>;
```

Valores (R1): WhatsApp `{graph, 24 h, true, false, false}` · web `{storedDelivery, null, true,
true, true}` · playground `{storedDelivery, null, false, false, false}`. Si WhatsApp no está
configurado, su política no existe y el webhook no se registra (como hoy).

## Recepción (`createIntake`)

`handle(events: InboundEvent[])` sigue siendo el único punto de entrada para los tres canales.
Orden de comprobaciones por evento, con la política de su canal:

1. `requiresActiveBusiness` y negocio no activo → descartar (`not_active`), no guardar.
2. `requiresWebChatEnabled` y chat desactivado → descartar (`disabled`), no guardar.
3. `usageCap` y tope alcanzado → descartar (`quota`), no guardar.
4. Guardar como hoy: cliente por `(channel, channelUserId)`, límite por cliente (30 / 15 min),
   conversación de 24 h, deduplicación por `channelMessageId`.

`handle` devuelve ahora un resultado por evento para que la ruta web pueda contestar:

```ts
type IntakeOutcome =
  | { status: 'stored'; conversationId: string }
  | { status: 'duplicate' }
  | { status: 'rate_limited'; conversationId: string }
  | { status: 'discarded'; reason: 'not_active' | 'disabled' | 'quota' | 'group' };
```

El webhook de WhatsApp ignora el resultado (sigue respondiendo `200`/`503` igual, FR-004).

## Procesador (`createProcessor`)

- Recibe `policies: ChannelPolicies` en lugar de `sender`.
- Al procesar una conversación lee `(channel, channel_user_id)` del cliente y aplica:
  - `requiresActiveBusiness` → misma regla de la 002 (borrar pendientes si el negocio se
    desactivó).
  - `requiresWebChatEnabled` y chat desactivado → marcar pendientes `discarded`
    (`disabled`), sin respuesta.
  - `replyWindowMs` → la regla de la ventana solo si no es `null` (FR-003).
  - `usageCap` y tope alcanzado → responder **R-UNAVAILABLE** sin llamar al modelo (R9).
- En la transacción que crea el saliente: guarda `reply_trace` (todos los canales) y, si
  `usageCap` y no es R-UNAVAILABLE, incrementa `web_usage_day`.
- `sendRateLimitNotice` igual para todos los canales (FR-024).

## Responder

- `RespondInput.phone` → `customerKey` (solo para registros).
- `Response` añade `contactReason: ContactReason | null` y `groundingRejections: number`.
- `needsContact` devuelve `ContactReason | null` con la misma precedencia:
  `handoff_requested` > (si `needsRephrase`, nada) > `offer_contact` > `booking_requested` >
  `price_on_request`. Las plantillas con contacto dan `template`.
- Sin ninguna condición por canal (FR-002).

## Plantilla nueva

| Id | Texto | Contacto | Saludo |
|----|-------|----------|--------|
| R-UNAVAILABLE | Ahora mismo no puedo atenderte por este chat. {CONTACTO} | sí (o CONTACTO-EMERGENCIA si el snapshot no se lee) | no |

Mismo texto en tú y usted salvo el verbo ("atenderle"). Se usa en la web cuando el tope se
alcanza con mensajes ya aceptados (R9) y como `message` + `contact` del objeto `unavailable` de
la API ([web-chat-http.md](web-chat-http.md)). Es la versión del chat de la salida a una
persona del Principio V: siempre lleva contacto.

## Garantías verificables

1. **Paridad** (SC-001, SC-002, R13): la misma conversación, con el mismo modelo falso, produce
   por `whatsapp`, `web` y `playground` los mismos textos, plantillas, saludo, contacto y
   `reply_trace` (salvo latencias).
2. Todos los tests de la 002 pasan con cambios solo en la construcción de eventos y nombres de
   columna (FR-004).
3. Migración `0001 → 0002` con datos: mismo número de clientes, conversaciones y mensajes, con
   `channel = 'whatsapp'` y `channel_user_id` = teléfono (FR-005).
4. La ventana de 24 h descarta en WhatsApp y no en web ni playground (FR-003).
5. Playground con negocio "en preparación" responde; web y WhatsApp no (FR-011, FR-022).
6. Playground no escribe en `web_usage_day` ni le afectan los topes (FR-012).
7. Con el tope alcanzado entre la recepción y el procesado, se envía R-UNAVAILABLE y el modelo
   falso no recibe ninguna llamada (SC-006).
8. Los topes cuentan en la zona horaria del negocio: a las 23:59 y a las 00:00 locales caen en
   días distintos aunque en UTC sean el mismo (FR-026).
