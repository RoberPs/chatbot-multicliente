# Contrato: pantalla «Consumo» ampliada

**Feature**: 012 · FR-007, FR-009, FR-017 · research R3, R5, R6, R7. Amplía
[010 admin-usage-screen](../../010-usage-cost-cap/contracts/admin-usage-screen.md).

Todo con sesión y CSRF; errores por campo con 422 y el formulario repintado; cada guardado en su
transacción; efecto desde el siguiente mensaje (se lee sin caché).

## Secciones nuevas en `/admin/usage`

| Sección | Contenido |
|---|---|
| Tope de gasto (010) | + aviso de que en producción es obligatorio; desactivarlo con el negocio activo en producción → 422 |
| Tope diario de WhatsApp | respuestas con modelo hoy / tope; campo `whatsappDailyCap` (1–10 000) |
| Precios de transcripción | tabla `modelo — precio por minuto`; alta/cambio y borrado como los precios de la 010 |
| Límites de derivación | `dailyMax` (1–200), `forwardIntervalMinutes` (5–240), `noticesDailyMax` (10–500); contadores de hoy: derivaciones nuevas, peticiones sin aviso, avisos y avisos retenidos |

Solo se muestran el tope de WhatsApp sin WhatsApp configurado y los precios de transcripción con los
audios apagados si ya tienen datos (para poder borrarlos).

## Rutas

| Método y ruta | Cuerpo | Respuesta |
|---|---|---|
| `POST /admin/usage/whatsapp-cap` | `whatsappDailyCap` | 303 a `/admin/usage` · 422 por campo |
| `POST /admin/usage/transcription-prices` | `model`, `perMinute` (decimal, hasta 6 decimales, 0–1 000 000) | 303 · 422 |
| `POST /admin/usage/transcription-prices/:model/delete` | — | 303 · 404 · 422 (en uso en producción con el negocio activo) |
| `POST /admin/usage/handoff-limits` | `dailyMax`, `forwardIntervalMinutes`, `noticesDailyMax` | 303 · 422 con el rango en el mensaje |

## Banda común del layout

Avisos de `protectionWarnings` en todas las pantallas, encima del aviso de gasto de la 010, con
enlace a «Consumo». Los críticos se ven también en la lista de avisos del inicio y en la pantalla de
activación (bloquean).

## «Probar el bot»

Con `contactOnly` no vacío, recordatorio fijo: «En producción, los clientes reciben ahora solo el
contacto: <motivo>.» La prueba sigue funcionando (010 FR-019).
