# Contrato: sección "Diseño del chat" del panel

**Feature**: 011-chat-design · Rutas bajo `/admin`, en el contexto del operador
(`requireOperator` + `csrfOnPost`), como el resto del panel (FR-001).

Sin sesión: `302 → /admin/login` (o `401` + `HX-Redirect` con htmx) y no se guarda nada (US1-8).
Sin token CSRF en un `POST`: `403`, como en el resto del panel.

La entrada "Diseño del chat" aparece en la navegación justo después de "Chat web".

---

## `GET /admin/chat-design`

Página con el formulario, los avisos de contraste y la vista previa.

- `200 text/html`. Valores del formulario: el diseño guardado, o los originales si no hay (US1-1,
  FR-015, FR-017).
- Si hay campos guardados que no se han podido aplicar (R13), un aviso al principio con cuáles
  ("El tamaño guardado ya no se admite; el chat usa el original").
- Si hay diseño guardado, el botón "Restaurar el aspecto original"; si no, el texto "El chat usa el
  aspecto original" en su lugar (US6-3).
- Recordatorio junto a los textos: el contenido es responsabilidad del operador y el asistente no
  lo usa para responder.

### Campos del formulario (`multipart/form-data`, `hx-boost="false"`)

| Campo | Control | Notas |
|---|---|---|
| `primary_color`, `on_primary_color`, `background_color`, `text_color`, `bot_bubble_color` | `<input type="color">` + texto `#RRGGBB` | |
| `shape` | radios `square` / `soft` / `round` | "Recta", "Suave", "Redondeada" |
| `position` | radios `right` / `left` | "Abajo a la derecha", "Abajo a la izquierda" |
| `size` | radios `small` / `medium` / `large` | "Pequeño", "Mediano", "Grande" |
| `chat_name` | texto, `maxlength=40`, `data-default="Asistente de …"` | |
| `welcome_text` | `<textarea maxlength=280>` | vacío = sin bienvenida |
| `placeholder` | texto, `maxlength=80`, `data-default` | |
| `send_label` | texto, `maxlength=20`, `data-default` | |
| `logo`, `avatar`, `icon` | `<input type="file" accept="image/png,image/jpeg,image/webp">` | |
| `logo_remove`, `avatar_remove`, `icon_remove` | casilla "Quitar" (solo si hay imagen guardada) | |
| `_csrf` | oculto | |

No hay campos para el aviso de asistente automático ni para el enlace de privacidad (US2-5).

---

## `POST /admin/chat-design` — guardar (todo o nada)

Contexto propio con `@fastify/multipart` (R8): `files ≤ 3`, `fileSize = 256 KB` sin error (se marca
`truncated`), `bodyLimit` de la ruta 8 MB. También acepta urlencoded (sin imágenes).

| Resultado | Respuesta |
|---|---|
| Válido | Transacción: `upsert` de `chat_design` + imágenes por hueco (sustituir / quitar / conservar). `303 → /admin/chat-design` con el aviso "Diseño del chat guardado" (`200` + `HX-Location` con htmx). Evento `chat_design_saved { outcome: 'saved' }`. |
| Algún campo no válido (opción, texto, color, contraste, imagen) | `422`, la página con **todos** los errores en su campo y lo que el operador escribió; nada guardado (FR-011a). En las imágenes elegidas: "Vuelve a elegir la imagen". Evento `chat_design_saved { outcome: 'rejected', reasons }`. |

Guardar no cambia la activación ni la configuración del chat web (FR-014) y funciona con el chat
desactivado o el negocio en preparación.

---

## `POST /admin/chat-design/check` — contraste en vivo (htmx)

Cuerpo: los cinco colores (urlencoded o multipart). Respuesta `200 text/html`: parcial con el
resultado de cada pareja (`hx-swap-oob` en el contenedor de aviso de cada control): pareja, razón
obtenida truncada a dos decimales y mínimo, o vacío si cumple. Un color mal escrito se señala como
"Indica un color opaco en formato #RRGGBB". No guarda nada. Sin JavaScript no se usa (US2-3).

---

## `GET /admin/chat-design/preview?view=closed|open`

Vista previa del chat (R9), para los dos iframes de la página.

- `200 text/html`: las mismas parciales que `/chat/frame`, con el diseño **guardado** (el script del
  panel aplica después lo que se edita), datos del negocio actuales y, en `open`, una conversación
  de ejemplo genérica marcada como ejemplo. Sin `frame.js` ni llamadas a `/chat/api`: no crea
  conversaciones ni cuenta para límites, topes o consumo (FR-010).
- Cabeceras propias (excepción en el gancho global de `src/app.ts`):
  `Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self' blob:;
  frame-ancestors 'self'; base-uri 'none'; form-action 'none'`, `X-Frame-Options: SAMEORIGIN`,
  `Cache-Control: no-store`.
- `view` desconocido → `open`.

## `GET /admin/chat-design/preview.css?<opciones>`

`200 text/css; charset=utf-8`, `Cache-Control: no-store`. El mismo generador que `/chat/design.css`
con las opciones de la consulta (`primary_color`, `on_primary_color`, `background_color`,
`text_color`, `bot_bubble_color`, `shape`, `size`, `position`); una opción ausente o no válida toma
el valor original. Nunca contiene texto de la consulta: solo tokens de tablas o colores validados.
El avatar no va aquí (lo pone el script del panel con la imagen elegida).

---

## `POST /admin/chat-design/reset` — restaurar el aspecto original

Formulario con `hx-confirm="¿Restaurar el aspecto original? Se borrarán los colores, los textos y
las imágenes del diseño."`; sin JavaScript, el botón lleva a `GET /admin/chat-design/reset`, una
página de confirmación con el mismo texto y el botón que envía el `POST` (confirmación expresa,
FR-016).

| Caso | Respuesta |
|---|---|
| Hay diseño | Borra la fila (y las imágenes en cascada). `303 → /admin/chat-design` con "Aspecto original restaurado". `chat_design_reset { outcome: 'reset' }`. |
| No hay diseño | `303 → /admin/chat-design` con "El chat ya usa el aspecto original". `chat_design_reset { outcome: 'nothing_to_reset' }`. |

---

## Script del panel `/assets/chat-design.js`

Servido como `/assets/app.js` (`text/javascript`, `max-age=3600`). Sin dependencias. Solo actúa en
la página de la sección. Cada 150 ms como mucho:

1. actualiza el `href` de `#chat-design-css` en los dos iframes a `preview.css?<opciones>`;
2. escribe nombre, ayuda, Enviar y bienvenida con `textContent` / `placeholder` (o el
   `data-default` si el campo está vacío; sin bienvenida si está vacía);
3. muestra cada imagen elegida con `URL.createObjectURL` (logo e icono como `src`, avatar como
   `--chat-avatar` por CSSOM) y la retira al marcar "Quitar"; revoca las URL al cambiar;
4. ajusta tamaño y esquina del iframe abierto según `size` y `position` (tabla de R5).

Avisa en el campo, sin bloquear, si el fichero elegido supera 256 KB o no es PNG, JPEG o WebP por
su tipo declarado; la comprobación que cuenta es la del servidor al guardar.
