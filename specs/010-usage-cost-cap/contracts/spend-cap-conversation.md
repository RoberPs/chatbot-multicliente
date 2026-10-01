# Contrato: el tope de gasto en la cadena de respuesta

**Feature**: 010-usage-cost-cap · FR-014 – FR-019, FR-022, FR-023 · research R7 – R10

## Comprobación

`spendCapState(tx, now, timezone)` — una consulta, sin caché (R7). "Alcanzado" = nivel `reached`.

| Punto | Canales | Con el tope alcanzado |
|---|---|---|
| Recepción (`intake.discardReason`) | web (`policy.spendCap && policy.usageCap`) | descarta sin guardar, `message_discarded { reason: 'spend_cap' }` |
| `webChatAvailability` | web | `{ available: false, unavailable: { reason: 'quota', … } }` — mismo mensaje y contacto que la 004 |
| Procesador, antes del modelo | WhatsApp y web (`policy.spendCap`) | ver § Árbol |
| Playground | — | no se comprueba: responde con el modelo y suma (FR-019) |

Orden en la recepción y en la disponibilidad del chat web: bot → snapshot → chat activado →
negocio activo → tope de respuestas (004) → **tope de gasto**. Los dos topes se aplican a la vez
(FR-017).

## Árbol del procesador (tras los descartes y la derivación activa de 002/004/005)

```text
snapshot ilegible                 → R-ERR (contacto de emergencia)            sin modelo
tope de respuestas web (004)      → R-UNAVAILABLE                             sin modelo
tope de gasto alcanzado
  ├─ web                          → R-UNAVAILABLE                             sin modelo
  └─ WhatsApp                     → R-CAP + decisión de la derivación         sin modelo
resto                             → responder (modelo) → registrar consumo → decisión de la derivación
```

### `R-CAP` (WhatsApp)

- Cuerpo: `unavailableReply(forma)` — "Ahora mismo no puedo atenderte por este chat." /
  "…atenderle…".
- CONTACTO del negocio (`contactBlock`), o `emergencyContact` de la instancia si el negocio no tiene
  ninguno (FR-016). Sin saludo. `reply_trace.template = 'R-CAP'`, `contact.reason = 'template'`.
- Se envía a cada lote de mensajes del cliente (Assumptions).

### Derivación con el tope alcanzado (FR-018, Principio V)

El procesador construye una salida de modelo sintética y deja decidir a `handoffTurn`:

```text
reply = { body: <texto de R-CAP>, handoffRequested: false, complaint: false, offerContact: false,
          bookingRequested: false, needsRephrase: false, acceptsHandoff: false, refusesContact: false,
          contactName: null, contactPhone: null, mentionedServiceIds: [] }
handoffDetected = detectsHandoffRequest(algún texto del lote)
```

| Situación | Resultado |
|---|---|
| Petición de persona (detector) **con** vías | igual que sin tope: pedir datos (`R-HANDOFF-ASK`) o iniciar (`R-HANDOFF-OK`), avisando al negocio **sin resumen del modelo** (`modelSummary: false`) |
| Petición de persona **sin** vías | `R-CAP` con contacto |
| Recogida de datos en curso | se sigue; el teléfono se toma del texto; si no se completa, sale con contacto (`refused`) |
| Sin petición | `R-CAP` con contacto |

Sin modelo no se reconocen quejas ni ofertas; ninguna respuesta con el tope alcanzado sale sin
contacto o sin la derivación.

### Resumen del aviso (US3-5)

`HandoffService.start({ …, modelSummary: false })` → `fallbackSummary` de la 005 +
`handoff_summary_fallback { reason: 'spend_cap' }`. Ningún registro de consumo.

## Reanudación (FR-022, SC-005)

Subir el tope por encima del gasto, desactivarlo o empezar el mes local hace que la siguiente
comprobación devuelva otro nivel: el siguiente lote se responde con el modelo, sin reiniciar.

## Exceso por concurrencia (SC-007)

Cada respuesta comprueba antes de llamar al modelo con el gasto ya registrado; las respuestas en
curso cuando se cruza el tope terminan y se registran. El exceso queda acotado a
`processorConcurrency` respuestas simultáneas.

## Registro de actividad

| Evento | Nivel | Campos | Cuándo |
|---|---|---|---|
| `spend_cap_reached` | `warn` | `month` (`AAAA-MM`) | la primera comprobación que ve `reached` en el mes local; una vez por mes y BD (R10) |
| `message_discarded` | `info` | `reason: 'spend_cap'` | recepción web con el tope alcanzado |
| `reply_sent` | `info` | `template: 'R-CAP'` | respuesta de tope en WhatsApp |
| `handoff_summary_fallback` | `warn` | `reason: 'spend_cap'` | aviso al negocio con el tope alcanzado |

Ningún evento lleva importes, precios, textos ni datos del cliente final.

## Pruebas que lo fijan (Principios IV y V)

- Integración: con el tope alcanzado, 0 llamadas al doble del modelo en WhatsApp y web; la
  respuesta lleva contacto; una petición de persona con vías inicia la derivación y el aviso lleva
  el resumen literal; al subir el tope, el siguiente mensaje llama al modelo; al cambiar el mes
  (reloj falso en la zona del negocio), también.
- Contrato: `GET /chat/...` y la API del chat web devuelven el estado "no disponible" con contacto
  cuando solo el tope de gasto está alcanzado.
