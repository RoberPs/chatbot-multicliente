# Contrato: páginas del panel para el canal web

**Feature**: `004-web-channel` | Fuente: FR-007 – FR-016, FR-026, FR-026a | Research: R6, R7, R8, R9

Rutas bajo `/admin`, dentro del ámbito del operador de la 001: sin sesión, `302` a
`/admin/login` (o `401` + `HX-Redirect` con htmx); todo `POST` con token CSRF (FR-013). Se
añaden dos entradas a la navegación: **Probar el bot** y **Chat web**.

## Probar el bot (US1)

### `GET /admin/playground`

Página con la conversación de prueba vigente (la del `playgroundId` de la sesión del
operador), la caja de texto y el botón "Nueva conversación".

- Negocio "en preparación": aviso fijo "El negocio está en preparación: los clientes reales no
  reciben respuesta hasta que lo actives. Aquí puedes probarlo igualmente." (FR-011).
- Sin bot (`ANTHROPIC_API_KEY` ausente): aviso "Falta la clave del modelo de lenguaje
  (ANTHROPIC_API_KEY) en la configuración de la instancia" y el formulario deshabilitado.
- Cada respuesta del bot se pinta con el texto exacto que recibiría un cliente (FR-008) y,
  debajo, su **información técnica** a partir de `reply_trace` (FR-009):

  | Dato | Ejemplo |
  |------|---------|
  | Saludo | "Saludo añadido" / "Sin saludo" |
  | Plantilla | "Plantilla: respuesta segura (R-SAFE)" o "Redactada por el modelo" |
  | Contacto | "Contacto añadido: pidió hablar con una persona" · "…: el modelo ofreció el contacto" · "…: pidió reservar" · "…: precio a consultar" · "…: lo incluye la plantilla" · "Sin contacto" |
  | Verificador | "El verificador rechazó 1 borrador" (sin valores) · "Sin rechazos" |
  | Tiempo | "Respondió en 6,1 s (modelo 3,2 s)" |

### `POST /admin/playground/messages`

Formulario `text` (1 – 1 000 caracteres) + `_csrf`.

- Pasa el texto a la recepción con `channel = playground` (misma cadena, FR-008).
- Con htmx devuelve el fragmento con el mensaje del operador y un indicador "escribiendo…" con
  `hx-get="/admin/playground/messages?after=<cursor>" hx-trigger="every 1s"`; sin htmx,
  `303` a `/admin/playground`.
- Texto vacío o largo: `422` con el error en el campo.
- Negocio activo o no: siempre se acepta (FR-011).

### `GET /admin/playground/messages?after=<cursor>`

Fragmento htmx con los mensajes posteriores al cursor. Mientras no llegue la respuesta,
devuelve `204` para que htmx no cambie nada; cuando llega, devuelve la respuesta con su
información técnica y un elemento sin `hx-trigger`, lo que detiene el sondeo.

### `POST /admin/playground/reset`

Genera un `playgroundId` nuevo en la sesión (FR-010) y vuelve a la página vacía; la siguiente
respuesta empieza con saludo (US1 escenario 4).

## Chat web (US2, US4)

### `GET /admin/web-chat`

- Estado: "Activado" / "Desactivado" (por defecto, FR-014).
- Formulario: webs permitidas (una por línea), enlace a la política de privacidad, tope
  diario, tope mensual, casilla "Activar el chat en estas webs".
- **Uso** (FR-026a): "Hoy: 37 de 200 respuestas · Este mes: 912 de 3 000", en la zona horaria
  del negocio. Si se ha alcanzado un tope, aviso destacado: "El chat web ha alcanzado el tope
  diario: no responde hasta mañana. Los clientes ven el contacto del negocio." (FR-026).
- **Fragmento** para la web del negocio (FR-016), en un `<textarea readonly>` con botón
  "Copiar" (el botón solo selecciona el texto si no hay JS):

  ```html
  <script src="{PUBLIC_BASE_URL u origen del panel}/chat/widget.js" defer></script>
  ```

  Con el chat desactivado se muestra igualmente, con la nota "No mostrará nada hasta que
  actives el chat".
- Si no hay bot: aviso "Falta la clave del modelo de lenguaje…" (el chat no puede responder).

### `POST /admin/web-chat`

Campos: `enabled` (casilla), `allowed_origins` (textarea), `privacy_url`, `daily_cap`,
`monthly_cap`, `_csrf`. Valida con `webChatSettingsSchema` ([data-model.md](../data-model.md)).

| Caso | Respuesta |
|------|-----------|
| Válido | `303` a `/admin/web-chat` con aviso "Chat web guardado" (o "activado" / "desactivado") |
| Activar sin webs o sin enlace | `422`, no guarda nada, errores por campo (US2 escenario 2) |
| Origen con ruta, `http` público o repetido | `422` con el error en la línea correspondiente |
| `monthly_cap < daily_cap` | `422` en el tope mensual |

La desactivación tiene efecto en la siguiente petición del chat (sin caché): el frame pasa a
"no disponible" y los entrantes se rechazan (US2 escenario 5).

## Portada (`GET /admin`)

Se añade una línea de estado del chat web: "Chat web: desactivado" · "activado en 2 webs" ·
"tope alcanzado (diario)", con enlace a `/admin/web-chat`. El aviso de tope alcanzado no es un
aviso de `computeWarnings` (no bloquea nada de la base de conocimiento).

## Garantías verificables (tests de contrato)

1. Sin sesión, las cinco rutas nuevas redirigen al login y no generan respuestas (US1-7).
2. `POST` sin CSRF → `403` (FR-013).
3. Activar sin orígenes o sin enlace → `422` y la fila sigue `enabled = false`.
4. El fragmento contiene la URL de `PUBLIC_BASE_URL` cuando está definida.
5. El uso mostrado coincide con `web_usage_day` en la zona horaria del negocio (cambio de día
   a medianoche local, no UTC).
6. La información técnica nunca muestra valores rechazados por el verificador.
