# Contrato: el diseño en el chat web público

**Feature**: 011-chat-design · Amplía contracts/web-chat-http.md de la 004. Todo lo que este
documento no menciona del chat web no cambia (FR-043).

---

## `GET /chat/frame` (cambios)

Lee el diseño en cada petición, sin caché (FR-012). Sigue con `Cache-Control: no-store` y la misma
CSP (`style-src 'self'`, `img-src 'self' data:`, `frame-ancestors` según la 004).

**Sin diseño guardado**: el HTML es el de la 004 (sin hoja nueva, sin atributos, sin imágenes);
se ve exactamente igual (FR-015, SC-006).

**Con diseño guardado**:

| Elemento | Cambio |
|---|---|
| `<html>` | atributos `data-palette` (si hay colores propios), `data-position="left"`, `data-size="small\|large"`, `data-avatar` (si hay avatar), solo los que difieren del original (R3) |
| `<head>` | `<link rel="stylesheet" href="/chat/design.css?v=<huella>">` después de `frame.css` |
| Botón flotante | si hay icono, `<img src="/chat/design/icon/<f>" alt="" class="design-icon">` en lugar del emoji, que queda oculto y vuelve si la imagen falla; conserva `aria-expanded`, la etiqueta "Abrir el chat", el color principal, la forma y el tamaño (FR-030a) |
| Cabecera | si hay logo, `<img src="/chat/design/logo/<f>" alt="" class="design-logo">` a la izquierda del título; el título es el nombre del chat (o "Asistente de …"), en una línea con puntos suspensivos si no cabe, sin tapar el botón cerrar (FR-030b) |
| Aviso de asistente automático y privacidad | **sin cambios** de texto ni de sitio (FR-021) |
| Lista de mensajes | primer elemento `<li class="welcome">` con la bienvenida, si la hay (FR-007) |
| Campo de escritura | `placeholder` configurado o "Escribe tu mensaje" |
| Botón Enviar | etiqueta configurada o "Enviar"; nunca vacía (FR-022) |
| Chat no disponible | mensaje y contacto de la 004 sin cambios, con los colores y la forma del diseño; título = nombre del chat o "Chat" (US2-7) |

Los textos se escapan siempre (`<%= %>`). Si leer el diseño falla, se registra el error y se sirve
el chat original (FR-018).

---

## `GET /chat/design.css`

- `200 text/css; charset=utf-8`, `Cache-Control: no-store`.
- Cuerpo: un único bloque `:root { … }` con los tokens de data-model §4 que difieren del original;
  vacío si no hay diseño. Solo nombres de la lista cerrada y valores `#rrggbb`, medidas de las
  tablas o `url(/chat/design/avatar/<f>)`. Nunca texto del operador (FR-004, FR-040).
- El parámetro `v` solo sirve para que la URL cambie con el diseño; se ignora.

## `GET /chat/design/:slot/:file`

- `:slot` ∈ `logo`, `avatar`, `icon`; `:file` = `<16 hex de sha256>.<png|jpg|webp>`.
- Coincide con la imagen guardada en ese hueco → `200`, bytes guardados, `Content-Type` del tipo
  detectado, `Cache-Control: public, max-age=31536000, immutable`, `Content-Disposition: inline`,
  `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy:
  same-origin`, `X-Content-Type-Options: nosniff` (FR-032).
- No coincide (sustituida, quitada, sin diseño), hueco desconocido o extensión distinta del tipo →
  `404` sin cuerpo útil (FR-031).
- Sin cookies; no recoge nada del visitante (FR-041).

---

## `GET /chat/widget.js` (cambios)

El mensaje que manda el frame se amplía (R6):

```text
{ type: 'chat:resize', open: boolean, size?: 'small' | 'medium' | 'large', position?: 'right' | 'left' }
```

- El fragmento sigue aceptando solo mensajes de su origen y de su iframe.
- `size` y `position` se traducen con la tabla del propio fragmento (R5); cualquier otro valor o su
  ausencia → `medium` y `right` (como hoy).
- Cerrado: 72 × 72. Abierto: el tamaño de la tabla, siempre con `max-width: calc(100vw - 32px)` y
  `max-height: calc(100vh - 32px)` (FR-034).
- Posición `left`: `left: 16px; right: auto`; `right`: como hoy. Se aplica antes de hacer visible el
  iframe.
- Un fragmento pegado antes de esta feature es el mismo script: no hay que cambiar nada en la web
  del negocio (FR-013).

## `frame.js` (cambios)

- `tellParent(open)` añade `size` y `position` leídos de `document.documentElement.dataset`
  (ausentes → `medium` / `right`).
- Un `<img class="design-icon">` o `design-logo` que dispara `error` se quita; el icono vuelve al
  emoji original (FR-018).
- Nada más cambia: los mensajes se siguen pintando con `textContent` y se añaden después de la
  bienvenida.
