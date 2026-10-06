# Contrato: panel, "Probar el bot" y chat web

**Feature**: `005-handoff-to-business` | Research: R15, R16 | Data model: [data-model.md](../data-model.md)

Cambios en las superficies HTTP existentes de la 001/004. Todas las rutas del panel siguen bajo
sesión de operador y CSRF; el chat web conserva sus guardas (origen, sesión, límites por IP).

## Panel: página "Derivaciones" (`/admin/handoffs`)

Nueva entrada en la navegación del layout, después de "Contacto de derivación".

### `GET /admin/handoffs`

Dos secciones:

1. **Avisos al negocio** (FR-020): formulario con
   - "WhatsApp para avisos" (`whatsapp`, teléfono, opcional). Ayuda: "El número del negocio que
     recibirá los avisos con los botones «Le atiendo» y «Terminado». Lo que escriba ese número al
     asistente no se trata como un cliente."
   - "Email para avisos" (`email`, opcional).
   - Estado de cada vía: "Disponible", "Sin configurar" o "Configurado, pero esta instancia no
     puede enviar por esta vía" (WhatsApp sin canal; email sin `SMTP_URL`/`SMTP_FROM`/
     `PUBLIC_BASE_URL`), con la variable que falta.
   - Los avisos `HANDOFF_ALERTS_NONE` / `HANDOFF_ALERTS_SINGLE` si aplican.
2. **Derivaciones activas** (FR-016a): tabla con cliente (nombre y teléfono), canal, tipo, inicio
   (hora local del negocio), "Confirmada" (sí + hora / no) y "Recordatorio enviado"; un botón
   "Terminar" por fila. **Sin** motivo ni textos de mensajes. Excluye las del canal `playground`.
   Vacía: "No hay ninguna conversación derivada ahora mismo."

### `POST /admin/handoffs/alerts`

Campos `whatsapp`, `email`. Validación `handoffAlertsSchema` (data-model). Guarda con la
escritura protegida de la 001. `303` → `/admin/handoffs` con flash "Guardado"; `422` con errores
por campo y los valores introducidos.

### `POST /admin/handoffs/:id/end`

`handoff.endByOperator(id, 'operator')`. `303` → `/admin/handoffs` con flash "Derivación
terminada; el asistente vuelve a atender a {nombre}." o "Esa derivación ya había terminado." Id
inexistente → 404 del panel. Con htmx, sustituye la fila.

### Avisos y portada

- `computeWarnings` añade `HANDOFF_ALERTS_NONE` ("No hay ninguna vía para avisar al negocio de
  las derivaciones; el bot dará el contacto de derivación.") y `HANDOFF_ALERTS_SINGLE` ("Los
  avisos de derivación solo llegan por {WhatsApp|email}; configura también {la otra} para que
  quede registro en las dos."), ambos `normal`, con enlace a `/admin/handoffs`.
- La portada (`/admin`) muestra "Derivaciones activas: N" con enlace a la página.

## "Probar el bot" (`/admin/playground`)

- La conversación de prueba sigue la misma cadena; con `simulateAlerts` los avisos no salen de
  la instancia (FR-021).
- La información técnica de cada respuesta muestra `reply_trace.handoff` ("Derivación iniciada
  (simulada) · tipo · vías") y, si hay `handoff_notice.body` simulado, el texto del aviso tal como
  lo recibiría el negocio, en un bloque plegable.
- Mientras la conversación de prueba está derivada: aviso fijo encima de la caja de texto ("El
  negocio contactará en el teléfono dado; lo que escribas también le llega") y los reenvíos
  simulados aparecen en la información técnica de los mensajes del operador.
- `POST /admin/playground/handoff/end`: termina la derivación de la conversación de prueba
  (causa `playground`) y vuelve a la página; sin derivación activa, no hace nada.
- "Nueva conversación" (existente) no termina derivaciones de conversaciones anteriores: se
  cierran por inactividad.

## Chat web (`/chat/api/*`)

### `GET /chat/api/messages?after=<cursor>`

Añade un campo; el resto del contrato de la 004 no cambia.

```json
{
  "messages": [ … ],
  "cursor": "…",
  "waiting": false,
  "handoff": { "active": true, "notice": "Hemos avisado a {negocio}. Te contactarán en el +34 611 22 23 33. Lo que escribas aquí también les llega." }
}
```

- `handoff` es `null` sin derivación activa en la conversación vigente.
- Con derivación activa, `waiting` es `false` aunque haya entrantes `pending` (no hay respuesta
  que esperar).
- Los entrantes `forwarded` aparecen como `from: "visitor"`.
- `notice` usa la forma de trato del negocio y el teléfono que dio el visitante; nunca el
  WhatsApp ni el email de avisos del negocio.

### `POST /chat/api/messages`

Sin cambios: durante la derivación el mensaje se acepta (`202`) igual; lo reenvía el procesador.

### Iframe (`frame.js`, `frame.css`)

- Si `handoff` no es `null`: muestra `notice` como franja fija bajo la cabecera, con estilo de
  aviso de la interfaz (no burbuja del bot, `role="status"`), texto con `textContent`.
- Mientras la franja está visible, consulta `/messages` cada 60 s; si llega `handoff: null`, la
  quita (US4-6) sin añadir ningún mensaje.
- No muestra el indicador de "escribiendo" mientras la franja está visible.

## Garantías verificables (tests de contrato)

- `/admin/handoffs` exige sesión y CSRF; la tabla no contiene `summary` ni textos de mensajes
  (se comprueba con una derivación cuyo motivo contiene una palabra marcada).
- Guardar destinos no válidos → `422` sin cambios en la BD.
- `POST /admin/handoffs/:id/end` dos veces → la segunda no cambia nada.
- `/chat/api/messages` con derivación activa → `handoff.active = true`, `waiting = false`; tras
  terminarla → `handoff = null` y ningún mensaje nuevo del bot (FR-018).
- En el playground, ningún `AlertRoute` real recibe llamadas (espía en las vías).
