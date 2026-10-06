# Research: Diseño del chat web

**Feature**: 011-chat-design · **Fecha**: 2026-10-02 · **Ámbito**: núcleo

Decisiones técnicas del plan. Cada una lleva la decisión, el porqué y las alternativas que se
descartaron. Los nombres de ficheros y rutas se concretan en [data-model.md](data-model.md) y en
[contracts/](contracts/).

---

## R1. Dónde se guarda el diseño

**Decisión**: dos tablas nuevas en la migración de solo añadir `0007_chat_design.sql`:

- `chat_design`: fila única (`id = 1`, `CHECK id = 1`) con los cinco colores, la forma, la
  posición, el tamaño y los cuatro textos. **Que no exista la fila significa "aspecto original"**
  (FR-015); restaurar (US6) es borrarla.
- `chat_design_image`: una fila por hueco ocupado (`slot` = `logo` | `avatar` | `icon`, clave
  primaria), con `mime_type`, `bytes` (`bytea`), `sha256`, `width`, `height` y `byte_size`. Clave
  ajena a `chat_design.id` con `ON DELETE CASCADE`: borrar el diseño borra sus imágenes.

Las opciones se guardan como `text` **sin** enum de PostgreSQL ni `CHECK` de valores: la validación
estricta está en el esquema Zod al escribir (panel e importación) y la lectura es tolerante, campo
a campo (R13). Así, si un núcleo posterior deja de admitir una opción, la fila sigue leyéndose y el
chat usa el valor original de esa opción (FR-018, caso límite "opción ya no admitida") sin tener
que editar migraciones publicadas. Los textos vacíos se guardan como `NULL` (= valor por defecto).

**Por qué**: una BD por instancia (constitución, CLAUDE.md); las imágenes viajan solas en las copias
de la 006 (FR-028) porque son datos de la instancia; la fila única sigue el patrón de
`web_chat_settings`, `policies` o `usage_settings`.

**Alternativas descartadas**:
- *Columnas nuevas en `web_chat_settings`*: mezcla aspecto con activación y topes, y "sin diseño"
  dejaría de ser "sin fila"; además el reemplazo de la 008 tocaría la fila de la activación.
- *Imágenes en disco o en un almacén de objetos*: rompería FR-028 (copias y restauraciones) y
  añadiría infraestructura por instancia.
- *Un único `jsonb` con todo el diseño*: rompe el test de cobertura de columnas de la 008 (vigila
  columnas, no claves de JSON) y oculta el diseño a las comprobaciones de la BD.

---

## R2. Cómo llega el diseño al chat sin tocar el fragmento

**Decisión**:

1. El frame (`GET /chat/frame`, ya `no-store`) lee el diseño **en cada petición, sin caché**, y:
   - pinta los textos (nombre, ayuda, Enviar, bienvenida) con `<%= %>` de Eta (escapado HTML);
   - añade a `<html>` atributos fijos que activan reglas ya escritas en `frame.css`:
     `data-palette` (colores propios), `data-position="left"`, `data-size`, `data-avatar`;
   - enlaza una segunda hoja, `/chat/design.css?v=<huella>`, **solo si hay diseño guardado**;
   - inserta `<img alt="">` del logo (cabecera) y del icono (dentro del botón) con su URL por
     huella (R10).
2. `GET /chat/design.css` devuelve **solo propiedades personalizadas** (`:root { --chat-…: … }`)
   generadas por el servidor a partir de valores ya validados: colores `#rrggbb`, radios y la URL
   del avatar sacados de tablas cerradas. Nunca contiene texto del operador; no hay forma de
   inyectar CSS (FR-004, FR-040). `Cache-Control: no-store` (FR-012).
3. `frame.css` cambia lo mínimo: cada color o radio fijo pasa a `var(--chat-…, <valor de hoy>)`,
   con el valor actual como respaldo, y las reglas que solo tienen sentido con diseño (color del
   enlace de privacidad, foco visible, fondo del campo de escritura, franja de derivación, avatar,
   esquina izquierda) van bajo `[data-palette]`, `[data-avatar]` o `[data-position="left"]`.

Sin fila de diseño no hay hoja nueva, ni atributos, ni imágenes: todas las `var()` caen en el valor
de hoy y el chat se ve exactamente igual que antes (FR-015, SC-006).

**Por qué**: es lo que pide la spec (variables CSS servidas desde el propio origen, sin framework
ni CSS libre) y cabe en la CSP actual del frame (`style-src 'self'`, `img-src 'self' data:`), que
no cambia. Leer sin caché sigue la regla del proyecto ("sin caché") y la de la 004 para la
activación.

**Alternativas descartadas**:
- *`<style>` en línea o atributos `style`*: la CSP del frame lo prohíbe y abrirla debilita la
  protección frente a inyección.
- *Hoja completa generada por el servidor*: duplicaría `frame.css` y haría frágil la regla
  "lo que no se menciona no cambia".
- *Clases en `<body>` con un tema por clase*: no admite colores arbitrarios.

---

## R3. La paleta original no se deriva

**Decisión**: si los cinco colores guardados son exactamente los originales, el servidor **no
emite** ningún color en `design.css` ni el atributo `data-palette`: el chat usa los valores de
`frame.css` tal cual (incluido el gris atenuado `#5f6878`, el borde `#d9dde4` y el color del
navegador para el enlace de privacidad). Solo cuando algún color cambia se activan los colores
derivados de R4.

Igual para cada grupo independiente: forma original → no se emiten radios; posición y tamaño
originales → no hay `data-position` ni `data-size`; sin imágenes → no hay `<img>` ni
`data-avatar`. Un diseño guardado que solo cambia el nombre del chat se ve como hoy salvo el
nombre.

**Por qué**: US1-1 pide que la vista previa sin diseño sea idéntica al chat actual, y FR-015 que el
original se vea "exactamente como hasta ahora". Con la derivación aplicada a la paleta original
saldrían grises ligeramente distintos de los de la 004.

**Alternativa descartada**: elegir la fórmula de derivación para que reproduzca los grises de la
004: no existe una fórmula sencilla que lo haga y que además garantice los mínimos con cualquier
paleta.

---

## R4. Contraste: comprobación y colores derivados

**Decisión**:

- **Fórmula**: luminancia relativa y razón de contraste de WCAG 2.x (sRGB, umbral de linealización
  0,04045), en `src/webchat/design/contrast.ts`, función pura. Se compara la razón **sin
  redondear** con el mínimo (4,4999 no cumple 4,5). En los mensajes la razón se muestra truncada a
  dos decimales con coma ("4,49:1"), nunca redondeada hacia arriba.
- **Parejas que se exigen al guardar** (FR-019), todas a 4,5:1:

  | Pareja (texto o primer plano / fondo) | Dónde se usa |
  |---|---|
  | `onPrimary` / `primary` | icono del botón, mensajes del visitante, etiqueta de Enviar |
  | `text` / `background` | nombre, aviso, textos del chat, campo de escritura |
  | `text` / `botBubble` | mensajes del bot |
  | `primary` / `background` | enlace de privacidad; botón Enviar frente al fondo |
  | `primary` / `botBubble` | enlaces `https://` de las respuestas del bot |

- **Colores derivados** (solo con paleta propia, R3), en `src/webchat/design/theme.ts`, mezclando
  en sRGB el texto hacia el fondo, `mix(text, background, t)`, y quedándose con el `t` mayor de una
  lista fija `0, 0,05, …` que cumpla:

  | Token | Uso | Requisito | `t` máximo |
  |---|---|---|---|
  | `--chat-muted` | aviso de privacidad, estado ("escribiendo…"), mensajes del propio chat, contacto de no disponible, botón cerrar, texto de ayuda del campo | ≥ 4,5:1 frente a `background` | 0,60 |
  | `--chat-field-border` | borde del campo de escritura | ≥ 3:1 frente a `background` (FR-019a) | 0,80 |
  | `--chat-line` | separadores y borde de burbujas (decorativo) | ninguno | fijo 0,80 |
  | `--chat-focus` | indicador de foco | = `text` (≥ 4,5:1 frente a `background` y `botBubble`) | — |

  Como `text` / `background` ya cumple 4,5:1, `t = 0` siempre vale: **la derivación nunca falla**
  con un diseño que se pueda guardar, y por construcción todo texto cumple AA y los elementos que
  no son texto 3:1 (SC-003).
- **Franja de derivación (005)**: con paleta propia mantiene su fondo amarillo y su borde de hoy y
  fija el texto en `#1d2330` (contraste ≈ 14:1), para no depender del color de texto elegido.
- **Foco**: con paleta propia, `:focus-visible { outline: 2px solid var(--chat-focus);
  outline-offset: 2px }`. El foco del botón flotante cerrado se dibuja sobre la web del negocio y
  queda fuera (FR-019a).
- **En el panel**: la misma función calcula los avisos en vivo (R9) y al guardar; la importación
  usa el mismo esquema (FR-036). No hay copia en JavaScript de la fórmula.

**Por qué**: un único cálculo en el servidor evita que la vista previa y el guardado discrepen, y
la derivación desde las parejas ya exigidas garantiza los mínimos sin opciones nuevas para el
operador (clarificación 5).

**Alternativas descartadas**:
- *Contraste en JavaScript en el navegador*: habría dos implementaciones que mantener iguales (como
  `links.js`), y el servidor tiene que comprobar igualmente.
- *Mezcla en espacio perceptual (OKLCH)*: más bonita pero más código y sin ventaja para garantizar
  una razón WCAG, que se define sobre sRGB.
- *Elegir automáticamente blanco o negro para el texto sobre el principal*: quitaría al operador
  una opción que la spec le da (`onPrimary`).

---

## R5. Forma, tamaño y posición

**Decisión**: tablas cerradas en `src/webchat/design/theme.ts`.

| Forma | Panel | Burbujas | Botones y campo | Botón flotante |
|---|---|---|---|---|
| `square` (recta) | 0 | 0 | 0 | 0 |
| `soft` (suave) | 6px | 6px | 4px | 12px |
| `round` (redondeada) — **original** | 12px | 10px | 8px | 50 % (círculo) |

La forma original es `round` porque el chat de la 004 ya tiene el botón circular y los radios de la
última fila (Assumptions: "redondeada hace circular el botón flotante").

| Tamaño | Chat abierto (ancho × alto) |
|---|---|
| `small` | 320 × 480 |
| `medium` — **original** | 380 × 560 (el de hoy) |
| `large` | 440 × 640 |

En pantallas pequeñas se conservan los límites actuales del fragmento (`max-width: calc(100vw -
32px)`, `max-height: calc(100vh - 32px)`), así que ningún tamaño sobrepasa el área visible
(FR-034). Posición: `right` (original) o `left`; en el frame mueve el botón (`[data-position=left]
.toggle { left: 8px; right: auto }`) y en el fragmento, el iframe (R6).

**Por qué**: valores en tablas del núcleo, no del operador (FR-004); el pequeño cabe en un móvil
apaisado y deja sitio a los elementos obligatorios con el nombre y la bienvenida más largos
(US2-6), y el grande sigue cabiendo en una pantalla de portátil de 768 px de alto.

---

## R6. Fragmento: posición y tamaño sin cambiar lo que pegó el negocio

**Decisión**: el fragmento (`widget.js`) ya ajusta el iframe cuando el chat le manda
`{ type: 'chat:resize', open }`. El mensaje se amplía con dos campos **con nombre, nunca medidas**:
`size: 'small' | 'medium' | 'large'` y `position: 'right' | 'left'`. El fragmento traduce el nombre
con su propia tabla (la de R5) y descarta cualquier otro valor (usa `medium` y `right`). Cambia
`right`/`left` del iframe antes de hacerlo visible, de modo que nunca aparece en la esquina
equivocada. `frame.js` lee los valores de los atributos de `<html>` que pone el servidor.

Compatibilidad:
- *Fragmento ya pegado*: es la misma URL (`/chat/widget.js`), servida por la instancia; el negocio
  no cambia nada (FR-013).
- *`widget.js` antiguo en la caché del navegador del visitante* (`max-age=3600`): ignora los campos
  nuevos y muestra la esquina derecha y el tamaño mediano hasta que caduca, como mucho una hora
  después de actualizar el núcleo. Es una transición única del despliegue, no de cada guardado:
  los guardados posteriores llegan por el frame (`no-store`).

**Por qué**: el iframe lo coloca la página del negocio, no el frame; el canal `postMessage` ya
existe y ya se valida el origen en el fragmento. Mandar nombres en lugar de píxeles impide que el
frame (o quien lo suplante) pida un tamaño arbitrario.

**Alternativas descartadas**:
- *Que el fragmento pida el diseño con `fetch`*: una petición más y CORS hacia la instancia desde
  la web del negocio.
- *Quitar la caché de `widget.js`*: más carga en cada visita de cada web, para un caso que solo
  ocurre al actualizar el núcleo.

---

## R7. Imágenes: formatos, validación y normalización

**Decisión**: validación en TypeScript puro (`src/webchat/design/images.ts`), **sin dependencias
nuevas** y sin decodificar píxeles:

1. **Formato por contenido** (FR-026), nunca por nombre ni tipo declarado:
   - PNG: firma de 8 bytes, primer bloque `IHDR`, todos los bloques con longitud coherente y **CRC
     correcto**, termina en `IEND`.
   - JPEG: `FF D8`, segmentos con longitudes coherentes, un `SOFn` con dimensiones, `SOS` y `FF D9`.
   - WebP: `RIFF` + longitud coherente + `WEBP` y un bloque `VP8 `, `VP8L` o `VP8X` válido del que
     se leen las dimensiones.
   - Todo lo demás (SVG, HTML, GIF, ejecutables renombrados, vacíos, truncados) se rechaza con
     "Formato no admitido: solo PNG, JPEG o WebP" o "La imagen está dañada".
2. **Límites**: 256 KB por imagen (FR-027) y dimensiones entre 16 × 16 y **1024 × 1024 px**. Las
   imágenes se muestran en huecos de 24–40 px, así que 1024 cubre de sobra pantallas de alta
   densidad.
3. **Normalización sin recodificar**: se quitan los metadatos (PNG: `tEXt`, `zTXt`, `iTXt`, `eXIf`,
   `tIME`; JPEG: segmentos `APP1`–`APP15` y `COM`; WebP: bloques `EXIF` y `XMP ` y su bandera en
   `VP8X`). Los bloques de animación se conservan: una imagen animada se acepta y sigue animada
   (caso límite). Quitar metadatos es **idempotente**: una imagen ya normalizada no cambia, lo que
   hace que reimportar el mismo fichero no muestre cambios (SC-008).
4. **Orientación EXIF**: al quitar `APP1` se pierde; para que la vista previa (que muestra el fichero
   original desde el navegador) y el chat coincidan, las imágenes del diseño llevan
   `image-orientation: none` en `frame.css` (también la del avatar, que es fondo CSS).
5. Se calcula `sha256` de los bytes guardados (URL y comparación) y se guardan ancho, alto, tamaño y
   el tipo MIME **detectado**.

La misma función valida las imágenes del panel y las de la importación, y es síncrona, así que
`parseConfigFile` sigue siendo una función pura (R11).

**Por qué**: no ejecutar ni decodificar nada del operador reduce superficie; las imágenes se sirven
con su tipo real y `nosniff` (R10), así que un fichero estructuralmente válido no puede
interpretarse como otra cosa (FR-032). Quitar metadatos evita publicar datos que el operador no
quería (ubicación de la foto) en un recurso público.

**Alternativas descartadas**:
- *`sharp` para decodificar, redimensionar y recodificar*: dependencia nativa pesada en
  `node:22-slim` y en Windows; recodificar cambia los bytes en cada importación y rompería SC-008.
- *Aceptar sin quitar metadatos*: más simple, pero publica EXIF.
- *Redimensionar en el navegador del operador (canvas)*: depende del JavaScript del panel, y el
  servidor tendría que validar igual.

---

## R8. Subida en el panel: un único "Guardar" todo o nada

**Decisión**: `POST /admin/chat-design` es `multipart/form-data` y se registra, como la importación
de la 008, en **su propio contexto** con `@fastify/multipart`, de modo que el resto del panel sigue
aceptando solo formularios urlencoded:

- `attachFieldsToBody: true` y un `onFile` propio que lee cada fichero a un `Buffer`. Así los
  campos (incluido `_csrf`) están en `request.body` antes del `preHandler` de CSRF, que no cambia.
- `limits: { files: 3, fileSize: 256 * 1024, fields: 20, fieldSize: 2048 }` con
  `throwFileSizeLimit: false`: un fichero mayor se corta y queda marcado como `truncated`, lo que
  permite decir **en su campo** "La imagen supera el máximo de 256 KB" (US3-4). El exceso se
  descarta mientras se lee: en memoria nunca hay más de 256 KB por fichero.
- `bodyLimit` de la ruta: 8 MB, para que una imagen grande llegue a marcarse como `truncated` en vez
  de cortar toda la petición con un 413 sin campo.
- Cada hueco lleva el fichero (`logo`, `avatar`, `icon`) y una casilla `<hueco>_remove`. Regla: un
  fichero nuevo sustituye; si no hay fichero, la casilla lo quita; si no, se conserva.
- El dominio valida todo junto (opciones, textos, contraste, imágenes) y devuelve **todos** los
  errores por campo; si hay alguno no se escribe nada (FR-011a). Si todo vale, una transacción hace
  `upsert` de `chat_design` y, por hueco, borra, inserta o deja la imagen.
- En el rechazo se vuelve a pintar el formulario con lo escrito (como `submitForm` del panel). Los
  ficheros elegidos no pueden volver a ponerse en un `<input type=file>`: el panel lo dice junto al
  campo ("Vuelve a elegir la imagen") y la vista previa la sigue mostrando si el navegador no ha
  recargado (con htmx la página no se recarga).

**Por qué**: la clarificación 1 pide un único guardado todo o nada; la 008 ya resolvió la subida
aislada en su contexto y la CSRF con multipart.

**Alternativas descartadas**:
- *Subir cada imagen al elegirla*: dejaría imágenes huérfanas al abandonar la página (FR-011).
- *Imágenes en base64 dentro de un formulario urlencoded*: un tercio más de tamaño, y obliga a JS.
- *`request.parts()` a mano en el manejador*: el cuerpo no estaría analizado cuando corre el CSRF.

---

## R9. Vista previa en vivo en el panel

**Decisión**: la sección muestra un recuadro "Vista previa · conversación de ejemplo" con **dos
iframes del mismo origen** del panel, que cargan el chat real en modo vista previa:

- `GET /admin/chat-design/preview?view=closed|open` pinta **las mismas parciales de Eta** que el
  frame (botón, cabecera, aviso de asistente automático y privacidad, lista de mensajes con la
  bienvenida, campo y Enviar) con `frame.css`, una conversación de ejemplo genérica (sin sector),
  sin `frame.js` y sin llamar a la API: no crea conversaciones ni cuenta para límites, topes ni
  consumo (FR-010). Funciona con el chat desactivado o el negocio en preparación. Exige sesión de
  operador.
- `GET /admin/chat-design/preview.css?<opciones>` devuelve el mismo `design.css` que el chat, pero
  calculado con las opciones de la URL (lo que el operador está editando), con la misma función.
  Una opción no válida en la URL usa la original (solo es una vista).
- `/assets/chat-design.js` (script del panel, sin dependencias) escucha los controles y, con una
  espera de 150 ms:
  1. cambia el `href` de la hoja de diseño de los iframes por `preview.css?<opciones>`;
  2. escribe los textos con `textContent` (o el atributo `placeholder`), usando el valor por
     defecto que el servidor deja en `data-default` cuando el campo está vacío;
  3. muestra las imágenes elegidas con `URL.createObjectURL` (no viajan hasta guardar, FR-011);
  4. ajusta el tamaño y la esquina del iframe abierto según el tamaño y la posición.
- **Contraste en vivo**: los cinco selectores de color llevan `hx-post="/admin/chat-design/check"`
  con `hx-trigger="input changed delay:300ms"`; la respuesta es una parcial con el resultado de cada
  pareja (`hx-swap-oob` junto a cada control: pareja, razón obtenida y mínimo) (FR-020). La ruta
  vive en el contexto multipart, así que acepta tanto el formulario multipart como urlencoded.
- **Cabeceras de la vista previa**: la cabecera global del panel pone `X-Frame-Options: DENY` y
  `frame-ancestors 'none'`. Las dos rutas de vista previa se añaden a la excepción del gancho
  `onSend` de `src/app.ts` (como ya se hace con `/chat/frame`) y llevan su propia CSP:
  `default-src 'none'; style-src 'self'; img-src 'self' blob:; frame-ancestors 'self'; base-uri
  'none'; form-action 'none'` y `X-Frame-Options: SAMEORIGIN`. Sin scripts dentro: los cambios los
  hace la página del panel, que es del mismo origen.
- Sin JavaScript en el navegador del operador no hay vista previa en vivo, pero guardar funciona y
  el servidor rechaza igual los colores insuficientes (US2-3).

**Por qué**: pintar la vista previa con las mismas parciales, la misma hoja y la misma función de
tema hace que "lo que se ve es lo que se guarda" (FR-009, SC-002) sin duplicar el chat. Dos iframes
reproducen exactamente las medidas del fragmento (72 × 72 cerrado y el tamaño elegido abierto). Los
cambios por CSSOM y `textContent` no necesitan abrir la CSP a `unsafe-inline`.

**Alternativas descartadas**:
- *Copiar el chat dentro de la página del panel*: `frame.css` asume que es el documento entero
  (`:root`, `html`, `body`); habría que mantener una copia con otro ámbito.
- *Recargar los iframes en cada cambio*: parpadeo y pérdida de las imágenes elegidas (las `blob:`
  habría que volver a poner igualmente).
- *Vista previa en el propio frame público con un parámetro*: la expondría a los visitantes
  (FR-010) y obligaría a abrir su CSP a `blob:`.

---

## R10. Cómo se sirven las imágenes

**Decisión**: `GET /chat/design/:slot/:file`, donde `:file` es `<sha256 en hex, 16 primeros
caracteres>.<png|jpg|webp>`:

- Si el hueco no tiene imagen o la huella no coincide → **404** (una imagen sustituida o quitada
  deja de servirse, FR-031).
- Si coincide: los bytes guardados, `Content-Type` con el tipo detectado (R7), `Cache-Control:
  public, max-age=31536000, immutable` (la URL cambia con el contenido), `X-Content-Type-Options:
  nosniff` (ya global), `Content-Security-Policy: default-src 'none'; sandbox`,
  `Cross-Origin-Resource-Policy: same-origin` y `Content-Disposition: inline`.
- El frame y `design.css` solo citan URLs de imágenes que existen en ese momento; como el frame es
  `no-store`, tras guardar la siguiente carga pide la URL nueva aunque el navegador tenga la vieja
  en caché (FR-031, SC-005).
- Sin cookies ni datos del visitante; el registro de peticiones ya no guarda IPs (FR-041).

**Por qué**: el mismo origen del chat (FR-028), tipo real y sin rastreo de contenido (FR-032), y
caché eficaz sin servir nunca una imagen antigua.

**Alternativa descartada**: `data:` URI dentro del HTML o de `design.css`: el frame (`no-store`)
pesaría cientos de KB en cada carga y empeoraría SC-009.

---

## R11. Exportación e importación (008)

**Decisión**:

- `CURRENT_FORMAT_VERSION` pasa de 1 a **2**; `UPDATERS[1]` añade `chatDesign: null` a los ficheros
  de la versión 1 (FR-035: sin sección se interpreta como sin diseño).
- Sección nueva `chatDesign` (después de `webChat`): `null` o un objeto estricto con las opciones y
  `images: { logo, avatar, icon }`, cada una `null` o `{ type, data }` con `data` en base64
  estándar. Formato en [contracts/config-file-chat-design.md](contracts/config-file-chat-design.md).
- **Validación** (FR-036): las mismas reglas que el panel (esquema Zod compartido, contraste, R7). El
  `type` declarado tiene que coincidir con el detectado. Un error en cualquier campo rechaza el
  fichero entero con su lista de errores por campo, como el resto de secciones.
- **Lectura** (`read.ts`): `readConfigWithInfo` y `readConfigDocument` añaden `chatDesign`; por eso
  la **configuración anterior** que guarda la importación lo incluye sin más cambios (FR-038), y la
  huella de la vista previa también (un guardado del diseño entre vista previa y confirmación se
  detecta como "la configuración ha cambiado").
- **Reemplazo** (`replace.ts`): `replaceChatDesign` compara opciones y huellas; si nada cambia no
  escribe; si el documento trae `null`, borra la fila (y sus imágenes por la cascada). Nunca toca
  `web_chat_settings` (FR-037).
- **Diferencias** (`diff.ts`): `chatDesignDiff` compara los **valores efectivos** (sin diseño = los
  originales) campo a campo con etiquetas legibles ("Color principal", "Forma: Suave → Recta"), y
  cada imagen como "añadida", "cambiada" o "eliminada" por su huella; además una entrada "Diseño del
  chat" en `added` (destino sin diseño) o en `removed` ("vuelve al aspecto original").
- **Registros**: `countsOf` y `changesOf` cubren la sección nueva (solo números).
- **Cobertura de columnas**: `chat_design` y `chat_design_image` entran en `CONFIG_TABLES`,
  `COLUMN_COVERAGE` y `EXCLUDED_COLUMNS` (`id`, `design_id`, `sha256`, `width`, `height`,
  `byte_size`, `updated_at` se excluyen porque se derivan o son internas).
- **Tamaño** (FR-039): tres imágenes de 256 KB son ≈ 1,0 MB en base64, muy por debajo de los 5 MB
  del fichero.

**Por qué**: es el mecanismo de versiones que la 008 dejó preparado (CLAUDE.md lo exige para toda
migración que añada configuración del negocio), y reutiliza ensayo, huella, copia anterior y vista
previa sin código nuevo de orquestación.

**Alternativa descartada**: exportar el diseño en un fichero aparte: rompería FR-035 (una sección
del mismo fichero) y la copia anterior de la 008.

---

## R12. Registros (FR-042)

**Decisión**: eventos del logger de la app, sin textos ni imágenes:

- `chat_design_saved` — `{ outcome: 'saved' | 'rejected', reasons?: ('contrast' | 'image' | 'text' |
  'option')[], images?: { logo, avatar, icon: 'kept' | 'added' | 'replaced' | 'removed' | 'none' } }`.
- `chat_design_reset` — `{ outcome: 'reset' | 'nothing_to_reset' }`.
- La importación ya registra sus eventos (`config_import_*`) con los recuentos por sección, que
  ahora incluyen `chatDesign`.

La fecha la pone el logger. No se registran nombres de fichero (los da el operador).

---

## R13. Lectura tolerante y fallos al servir (FR-018)

**Decisión**: `readChatDesign(tx)` devuelve un `ResolvedChatDesign` en el que cada campo se
interpreta por separado: un color que no sea `#rrggbb`, una opción desconocida o un texto que no
cumpla el esquema toman el valor original y se anotan en `unsupported[]`. Si con los colores leídos
alguna pareja de R4 no cumpliera (porque un núcleo posterior subiera un mínimo), **toda la paleta**
vuelve a la original. Una imagen cuyos bytes ya no pasan R7 se ignora (hueco vacío). La sección del
panel muestra un aviso con `unsupported[]` al abrirse.

En el frame, cualquier error al leer el diseño se registra y se sirve el chat original; nunca deja
sin chat (FR-018). En el navegador, `frame.js` quita un `<img>` del diseño que no carga (el botón
vuelve a su icono original y la cabecera queda sin logo); un avatar que no carga simplemente no se
ve.

---

## R14. Textos

**Decisión**: esquema Zod en `src/webchat/design/schemas.ts`:

| Campo | Máximo | Saltos de línea | Vacío |
|---|---|---|---|
| `chatName` | 40 | no | "Asistente de" + nombre del negocio |
| `welcomeText` | 280 | sí (`\r\n` → `\n`) | sin bienvenida |
| `placeholder` | 80 | no | "Escribe tu mensaje" |
| `sendLabel` | 20 | no | "Enviar" |

Se recortan los espacios de los extremos; se rechazan los caracteres de control (salvo `\n` en la
bienvenida). La longitud se mide en unidades UTF-16, igual que el `maxlength` del formulario. Los
textos se pintan siempre con `<%= %>` (escapado) en el frame y la vista previa, y con
`textContent` desde el script del panel: `<b>`, `<script>` o `{{ }}` se ven tal cual (US1-6,
FR-040). La bienvenida es un `<li class="welcome">` pintado por el servidor al principio de la lista
de mensajes, con `white-space: pre-wrap`: se desplaza con los mensajes, aparece cada vez que se
abre el chat y `frame.js` (que solo añade elementos al final) no la toca ni la guarda (FR-007).
Junto a los campos de texto el panel recuerda que el contenido es responsabilidad del operador y
que el bot no lo usa (Principio IV).

El nombre del chat sustituye solo al título de la cabecera; el aviso "Estás hablando con el
asistente automático de …" y el enlace de privacidad no cambian (FR-021). Con el chat no
disponible, el título es el nombre configurado o, sin él, "Chat" como hoy.

---

## R15. Cómo se prueba lo visual

**Decisión**: sin navegador automatizado. Lo que se puede comprobar sin él va en tests:

- *unit*: contraste en los bordes (4,4999 / 4,5 / 3:1); propiedad "toda paleta que pasa FR-019
  produce derivados que cumplen 4,5:1 y 3:1" sobre miles de paletas aleatorias con semilla fija;
  `design.css` solo contiene propiedades personalizadas con valores de las tablas; validación de
  imágenes con ficheros de prueba en `tests/fixtures/images/` (válidos, SVG y HTML renombrados,
  vacío, truncado, CRC roto, dimensiones fuera de rango, con metadatos, animados) e idempotencia de
  la normalización; textos y límites; actualizador del formato; diferencias.
- *contract*: el HTML del frame **sin diseño** es idéntico al de antes de la feature (comparación
  con una copia guardada en `tests/fixtures/`); con diseño, atributos, textos escapados, elementos
  obligatorios presentes con el nombre y la bienvenida más largos; cabeceras de `design.css`, de
  las imágenes y de la vista previa; formulario, guardado, rechazo por campo, restauración, sesión
  y CSRF.
- *integration*: guardado todo o nada, reemplazo y restauración con imágenes, ida y vuelta de la
  exportación, copia anterior, copia de seguridad.

El aspecto real (nada tapado ni cortado en escritorio y en móvil, SC-004; vista previa igual al
chat, SC-002) se verifica con la lista manual de [quickstart.md](quickstart.md) en Chrome, Firefox y
Safari (o un WebKit) antes de dar la feature por terminada.

**Alternativa descartada**: Playwright con capturas: añadiría navegadores a la instalación y a la
integración continua solo para esta feature; queda como propuesta si el aspecto del chat sigue
creciendo.
