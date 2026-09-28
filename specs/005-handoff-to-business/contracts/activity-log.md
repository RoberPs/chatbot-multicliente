# Contrato: registros técnicos de la derivación

**Feature**: `005-handoff-to-business` | Research: R17 | Base: [002](../../002-whatsapp-faq-bot/contracts/activity-log.md), [004](../../004-web-channel/contracts/activity-log.md)

Eventos nuevos en el catálogo cerrado de `src/conversation/activity-log.ts` (FR-022). Mismas
reglas que la 002/004: sin campos de texto libre; el cliente solo como seudónimo HMAC con su
`via`; ningún nombre, teléfono, email, resumen ni texto de mensaje. `handoffId` es un UUID sin
datos personales y permite seguir una derivación de principio a fin.

## Eventos nuevos

| Evento | Campos | Nivel | Cuándo |
|--------|--------|-------|--------|
| `handoff_offered` | — | info | fila 7 de la tabla de decisión |
| `handoff_contact_requested` | `missing: ('name'\|'phone')[]`, `retry: boolean` | info | R-HANDOFF-ASK / R-HANDOFF-PHONE |
| `handoff_started` | `handoffId`, `kind`, `routes: { whatsapp?, email?, simulated? }` (`'sent'\|'failed'`), `summarySource: 'model'\|'fallback'`, `afterHours: boolean` | info | derivación guardada |
| `handoff_not_started` | `kind`, `reason: 'no_routes'\|'delivery_failed'\|'contact_refused'` | warn | FR-012 o FR-004 |
| `handoff_alert_failed` | `handoffId?`, `route`, `noticeType: 'alert'\|'reminder'\|'forward'`, `failure` (código corto) | warn | una vía falla |
| `handoff_summary_fallback` | `reason: 'timeout'\|'model_error'\|'unverified'` | warn | respaldo del resumen (R4) |
| `handoff_forwarded` | `handoffId`, `messagesCovered`, `routes` | info | reenvío de un lote |
| `handoff_forward_failed` | `handoffId`, `messagesCovered` | error | fallan todas las vías de un reenvío |
| `handoff_confirmed` | `handoffId`, `via: 'whatsapp'\|'email'`, `minutesToConfirm` | info | "Le atiendo" o "Terminado" sin confirmar antes |
| `handoff_reminder_sent` | `handoffId`, `routes`, `customerNotified: boolean` | warn | FR-019 |
| `handoff_ended` | `handoffId`, `cause: 'business'\|'inactivity'\|'operator'\|'playground'`, `durationMinutes`, `confirmed: boolean` | info | fin por cualquier causa |
| `handoff_action_ignored` | `reason: 'invalid'\|'already_ended'\|'already_confirmed'`, `via` | debug | botón o enlace sin efecto |
| `handoff_business_message` | `kind: 'button'\|'text'\|'other'`, `helpSent: boolean` | debug | el WhatsApp de avisos escribe al bot |

`message_discarded` no cambia. `reply_sent` gana `handoffAction?` (el `reply_trace.handoff.action`)
y las plantillas nuevas en `template`.

## Contexto de cada evento

- Los eventos de la cadena (ofrecer, pedir datos, iniciar, reenviar, recordatorio) llevan el
  contexto de la conversación (`via`, `customer`, `conversationId`), como `reply_sent`.
- Los eventos que provoca el negocio (`handoff_confirmed`, `handoff_ended` por `business`,
  `handoff_action_ignored`, `handoff_business_message`) **no** llevan seudónimo del remitente: el
  negocio no es un cliente, y su número no se registra.

## Garantías verificables

- Test de integración de la 004 ampliado: recorre un flujo completo (petición, datos, aviso,
  reenvío, recordatorio, fin) con nombre, teléfono, email y un motivo marcados, y comprueba que
  ninguno aparece en la salida del logger.
- Todos los `BotEventName` tienen nivel en `eventLevels` (tipo exhaustivo).
