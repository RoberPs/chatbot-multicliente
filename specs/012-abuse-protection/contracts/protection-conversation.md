# Contrato: estado de protección en la conversación

**Feature**: 012 · US1 · FR-001 – FR-011, FR-037 · research R1–R6, R17. Amplía
[010 spend-cap-conversation](../../010-usage-cost-cap/contracts/spend-cap-conversation.md).

## Módulo `src/usage/protection.ts` (dominio, sin HTTP)

```ts
protectionState(tx, {
  production: boolean,          // NODE_ENV === 'production'
  llmModel: string,             // LLM_MODEL
  sttModel: string | null,      // STT_MODEL con AUDIO_TRANSCRIPTION=on; null si apagado
  now: Date, timezone: string,
}): Promise<ProtectionState>    // nunca lanza: fallo o > 2 s → contactOnly ['spend_unreadable']

checkProtection(tx, input, activityLog, logContext?)   // como checkSpendCap: además emite
                                                       // spend_cap_reached / whatsapp_quota_reached
                                                       // una vez por periodo (marcas persistidas)
canCallModel(state, channel): { ok: true } | { ok: false, reason: CapReason }
canTranscribe(state, channel): { ok: true } | { ok: false, reason: CapReason }
protectionWarnings(state): Warning[]                   // data-model §2.2
```

`CapReason = ContactOnlyReason | 'spend_cap' | 'whatsapp_daily'`. Orden de `reason` cuando hay
varios: `spend_unreadable`, `cap_disabled`, `model_unpriced`, `stt_unpriced`, `spend_cap`,
`whatsapp_daily`.

## Dónde se consulta

| Punto | Antes (010) | Ahora |
|---|---|---|
| Recepción web (`intake`) | tope 004 + `checkSpendCap` | tope 004 + `checkProtection` → descarte `spend_cap` si no puede llamar al modelo |
| Recepción WhatsApp | nada | nada (se guarda; decide el procesador) |
| Disponibilidad del chat web (frame y API) | tope 004 + tope de gasto → `quota` | igual con `canCallModel(state, 'web')` |
| Procesador | `spendCapReached` | `checkProtection` + `canCallModel(state, canal)` |
| Transcripción | nada | `canTranscribe(state, canal)` antes de descargar |
| «Probar el bot» | no se corta | no se corta; la pantalla avisa si `contactOnly` no está vacío |

## Respuesta sin modelo

| Canal | Respuesta | Traza |
|---|---|---|
| WhatsApp | R-CAP (cuerpo fijo + CONTACTO; salida sintética para la derivación) | `template: 'R-CAP'`, `capReason` |
| Web | «no disponible» (`reason: 'quota'`) con el contacto | — |
| Sin snapshot | R-ERR con el contacto de emergencia (como hoy) | — |

Cada respuesta sin modelo por un motivo de `contactOnly` o `whatsapp_daily` registra
`contact_only_reply` con su `reason`. La derivación con R-CAP sigue como en la 010 (detector
determinista, resumen literal), dentro de los límites de
[handoff-limits.md](handoff-limits.md).

## Tope diario de WhatsApp

- Cuenta: +1 en `whatsapp_usage_day` del día local en la transacción del saliente cuando
  `response.modelCalled` (también si el registro de consumo falla o el proveedor no informó tokens).
- Alcanzado (`today >= whatsapp_daily_cap`): R-CAP con `capReason: 'whatsapp_daily'` hasta las 00:00
  locales del negocio.
- No cuentan «Probar el bot» ni el chat web (que tiene el suyo, 004).

## Transcripción

1. `canTranscribe` falso → no se llama a `fetchAudio` ni a `stt.transcribe`;
   `setTranscription(failed)`; `transcription_failed { reason: 'blocked' }`; se despierta al
   procesador, que responde R-CAP.
2. Transcripción hecha (bien o con error tras responder el proveedor) → `meter.recordTranscription`
   `{ channel, model: STT_MODEL, audioMs, at, timezone }`; nunca lanza
   (`transcription_usage_failed`).
3. Duración: proveedor → Ogg/Opus → `audioMaxSeconds`.

## Panel

- Banda común del layout con los avisos de `protectionWarnings` en **todas** las pantallas (junto al
  aviso de gasto de la 010).
- Activar el negocio con un aviso crítico de protección → rechazado (`ActivationBlockedError`, la
  misma pantalla de avisos bloqueantes de hoy).
- En producción con el negocio activo:
  - `POST /admin/usage/settings` con el tope desactivado → 422 en `capEnabled`:
    «En producción el tope de gasto es obligatorio mientras el negocio está activo.»
  - Borrar el precio de `LLM_MODEL`, o con audios el de `STT_MODEL` → 422:
    «En producción no se puede borrar el precio del modelo en uso mientras el negocio está activo.»

## `GET /health` con secreto

`spendCap` gana `"blocked"`: la instancia responde solo con el contacto por `cap_disabled`,
`model_unpriced`, `stt_unpriced` o `spend_unreadable`. `instance:versions` lo muestra como
`bloqueado`; no cambia la clasificación de la fila ni el código de salida. Sin credencial, sin
cambios.
