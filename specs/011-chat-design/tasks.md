---

description: "Lista de tareas de la feature 011: diseño del chat web"
---

# Tasks: Diseño del chat web

**Input**: documentos de diseño de `/specs/011-chat-design/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md) (R1–R15),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Ámbito**: núcleo.

**Tests**: sí. El plan (Technical Context → Testing) los pide: `unit`, `contract` (`fastify.inject`)
e `integration` (Testcontainers), y la constitución exige tests de presencia del aviso, la
privacidad y la salida a una persona (Principios IV y V). Dentro de cada historia, los tests se
escriben primero y deben fallar antes de implementar.

**Organización**: por historia de usuario (spec.md), para poder implementar y probar cada una por
separado.

## Formato: `[ID] [P?] [Story] Descripción`

- **[P]**: se puede hacer en paralelo (ficheros distintos, sin dependencias pendientes)
- **[Story]**: historia a la que pertenece (US1…US6)
- Cada tarea indica la ruta exacta del fichero

## Convenciones del proyecto que afectan a todas las tareas

- Specs, comentarios, mensajes y textos de la interfaz, en español.
- `src/webchat/design/*` es dominio: **no importa Fastify** ni nada de HTTP.
- En `src/` no puede haber nombres ni reglas de un sector o cliente (la conversación de ejemplo de
  la vista previa es genérica); los ejemplos con marcas solo en `tests/fixtures/`.
- Migraciones de solo añadir: las publicadas (`0000`–`0006`) no se tocan.
- Los textos del operador se pintan siempre escapados (`<%= %>` en Eta, `textContent` en JS).
- La CSP del frame (`style-src 'self'`, `img-src 'self' data:`) **no cambia**.

---

## Phase 1: Setup (infraestructura compartida)

**Purpose**: dejar listos los ficheros de referencia que protegen la no regresión antes de tocar
nada del chat.

- [X] T001 Capturar el HTML actual de `GET /chat/frame` (sin diseño, con el negocio y la configuración del chat web de los tests de la 004 en `tests/contract/web-chat-frame.test.ts`) **antes de cambiar ningún fichero del canal web**, y guardarlo en `tests/fixtures/web-chat/frame-004.html`; documentar en un comentario al principio del test que lo use qué partes variables se normalizan (token de sesión, fechas, nonce si los hay) y con qué marcador
- [X] T002 [P] Crear `tests/fixtures/images/generate.ts` (script de Node sin dependencias, ejecutable con `pnpm tsx`) que construya y escriba en `tests/fixtures/images/` los ficheros de prueba de R7: `valid.png` (64×64, CRC correctos), `valid.jpg` (SOF0 64×64 + SOS + EOI), `valid.webp` (VP8L 64×64), `valid-vp8x.webp`, `metadata.png` (con `tEXt`, `iTXt`, `eXIf`, `tIME`), `metadata.jpg` (con `APP1` EXIF, `APP13` y `COM`), `metadata.webp` (VP8X con `EXIF` y `XMP ` y sus banderas), `animated.png` (APNG con `acTL`/`fcTL`/`fdAT`), `animated.webp` (VP8X con `ANIM`/`ANMF`), `svg-renamed.png`, `html-renamed.png`, `exe-renamed.png` (cabecera `MZ`), `empty.png` (0 bytes), `truncated.png`, `bad-crc.png`, `gif.gif`, `too-small.png` (8×8), `too-large-dims.png` (2000×2000, cabecera válida y pocos bytes) y `too-big.png` (> 256 KB, válido); añadir `tests/fixtures/images/README.md` con la lista y para qué sirve cada uno, y generar y versionar los ficheros
- [X] T003 [P] Crear las carpetas nuevas vacías con su primer fichero en las tareas siguientes: `src/webchat/design/`, `src/channels/web/views/partials/`, `src/admin/views/chat-design/`, `tests/unit/webchat/design/`, `tests/integration/chat-design/`

---

## Phase 2: Foundational (prerrequisitos que bloquean todas las historias)

**Purpose**: tablas, tipos, valores originales, lectura tolerante y parciales del frame. Ninguna
historia puede empezar sin esto.

**⚠️ CRÍTICO**: la migración `0007` añade configuración del negocio. T006a apunta sus tablas en
`tests/unit/config-transfer/column-coverage.test.ts`, que **falla desde T006a hasta T080 (US5)**.
La US5 es obligatoria antes de integrar la rama en `main` (CLAUDE.md: toda migración de
configuración sube `formatVersion`).

- [X] T004 Añadir un test de contrato "frame sin diseño idéntico a la 004" en `tests/contract/web-chat-design.test.ts`: `GET /chat/frame` sin fila en `chat_design` devuelve, tras normalizar las partes variables como se documentó en T001, exactamente `tests/fixtures/web-chat/frame-004.html`; y sin `<link>` a `design.css`, sin atributos `data-*` en `<html>` y sin `<img class="design-…">`. Debe pasar ya (antes de cambiar nada) y seguir pasando en todas las fases
- [X] T005 Añadir las tablas `chatDesign` (`chat_design`: `id smallint` PK `DEFAULT 1` con `CHECK (id = 1)`, cinco colores `text NOT NULL`, `shape`, `position`, `size` `text NOT NULL`, `chat_name`, `welcome_text`, `placeholder_text`, `send_label` `text` nulos, `updated_at timestamptz NOT NULL DEFAULT clock_timestamp()`) y `chatDesignImage` (`chat_design_image`: `slot text` PK, `design_id smallint NOT NULL` FK → `chat_design.id` `ON DELETE CASCADE`, `mime_type`, `bytes bytea`, `sha256`, `width`, `height`, `byte_size`, `updated_at`, con los `CHECK` de `byte_size BETWEEN 1 AND 262144` y dimensiones `BETWEEN 16 AND 1024`) en `src/db/schema.ts`, siguiendo el estilo de `web_chat_settings`; sin enums de PostgreSQL ni `CHECK` de valores en las opciones (R1, R13; data-model §1)
- [X] T006 Generar la migración de solo añadir con drizzle-kit y renombrarla a `src/db/migrations/0007_chat_design.sql` (con `src/db/migrations/meta/0007_snapshot.json` y la entrada en `src/db/migrations/meta/_journal.json`); revisar a mano que lleva los `CHECK`, la cascada y `clock_timestamp()`, y que no toca ninguna tabla existente (depende de T005)
- [X] T006a Añadir `chat_design` y `chat_design_image` a `CONFIG_TABLES` en `tests/unit/config-transfer/column-coverage.test.ts`. Desde aquí el test falla con el recordatorio de subir `formatVersion` y solo vuelve a pasar con T080 (US5). Es la protección real que exige CLAUDE.md: el test solo revisa las tablas de esa lista (depende de T005)
- [X] T007 [P] Crear `src/webchat/design/defaults.ts`: tipos `Slot` (`logo` | `avatar` | `icon`), `Shape`, `Position`, `Size`, `ChatDesignOptions`, `ImageRef`, `ResolvedChatDesign` (data-model §2); `ORIGINAL_DESIGN` (`#1f5fbf`, `#ffffff`, `#ffffff`, `#1d2330`, `#ffffff`, `round`, `right`, `medium`, textos `null`); `DEFAULT_PLACEHOLDER = 'Escribe tu mensaje'`, `DEFAULT_SEND_LABEL = 'Enviar'`, `defaultChatName(businessName)` = "Asistente de" + nombre (el mismo texto que pinta hoy `frame.eta`) y `UNAVAILABLE_TITLE = 'Chat'`; sin ninguna referencia a un sector
- [X] T008 [P] Crear `src/webchat/design/schemas.ts` con Zod: `hexColor` (`#` + 6 hex, sin alfa, normalizado a minúsculas; mensaje "Indica un color opaco en formato #RRGGBB"), `shapeSchema`, `positionSchema`, `sizeSchema` ("Opción no válida"), y los cuatro textos de R14 (recorte de extremos, vacío → `null`, máximo en unidades UTF-16 40/280/80/20 con "Máximo N caracteres", `\r\n` → `\n` y saltos solo en la bienvenida, "Este texto va en una sola línea", sin caracteres de control); `chatDesignOptionsSchema` y `chatDesignFormSchema` (nombres de campo del formulario de contracts/admin-chat-design.md, **descarta** claves desconocidas); función `validateChatDesignOptions(input)` que devuelve **todos** los errores por campo a la vez (FR-011a). Sin imágenes ni contraste todavía
- [X] T009 Crear `src/webchat/design/store.ts` con: la función pura `resolveChatDesign(row | null, imageRows)` → `ResolvedChatDesign` con lectura tolerante campo a campo (valor no válido → original y su nombre en `unsupported[]`; sin fila → `saved: false` y `ORIGINAL_DESIGN`) (R13); `readChatDesign(tx)` que lee la fila y los **metadatos** de las imágenes (sin `bytes`) y llama a `resolveChatDesign`; y `saveChatDesign(tx, options)` que hace `upsert` de la fila entera (gana el último, FR-017) sin tocar `web_chat_settings`. Las imágenes y el contraste se completan en US2 y US3 (depende de T005, T007, T008)
- [X] T010 [P] Test unitario de la lectura tolerante en `tests/unit/webchat/design/store.test.ts`: sin fila → original y `saved: false`; color mal formado, `shape`/`size`/`position` desconocidos y texto que excede el máximo → valor original de ese campo y anotado en `unsupported`, el resto se aplica
- [X] T011 [P] Crear `tests/helpers/chat-design.ts`: `seedChatDesign(db, partial)` que inserta una fila con los valores originales sobrescritos por `partial`, `clearChatDesign(db)`, y `loadImageFixture(name)` que lee de `tests/fixtures/images/`
- [X] T012 Extraer de `src/channels/web/views/frame.eta` las parciales `src/channels/web/views/partials/toggle.eta` (botón flotante), `header.eta` (título y botón cerrar), `notice.eta` (aviso de asistente automático y enlace de privacidad), `messages.eta` (lista de mensajes), `composer.eta` (campo y botón Enviar) y `unavailable.eta` (mensaje de no disponible y contacto), **sin cambiar ni un carácter del HTML resultante**; ajustar la configuración de Eta en `src/channels/web/routes.ts` si hace falta para resolver las parciales. T004 y los tests existentes de `tests/contract/web-chat*.test.ts` deben seguir pasando (R9)

**Checkpoint**: tablas creadas, dominio base con valores originales y lectura tolerante, frame
idéntico al de la 004 pintado con parciales.

---

## Phase 3: User Story 1 - Personalizar colores, forma, nombre y textos con vista previa (Priority: P1) 🎯 MVP

**Goal**: el operador cambia los cinco colores, la forma, el nombre y los textos en
`/admin/chat-design`, los ve en la vista previa sin guardar, guarda, y la siguiente carga del chat
los muestra sin que el negocio toque su fragmento.

**Independent Test**: con el chat web activado, cambiar colores, forma, nombre, bienvenida, ayuda y
Enviar; comprobar que la vista previa cambia sin guardar; guardar y recargar la web: el chat real
muestra lo mismo (quickstart §1 y §2).

### Tests for User Story 1 ⚠️

> Escribirlos primero y comprobar que fallan.

- [X] T013 [P] [US1] Tests unitarios del tema en `tests/unit/webchat/design/theme.test.ts`: con `ORIGINAL_DESIGN` no hay tokens ni `htmlAttrs` (R3); cambiar solo el nombre no emite tokens; cambiar un color emite `--chat-accent`… y `data-palette`; cada forma da los radios de la tabla de R5 (`round` = original = sin tokens de radio); `texts` aplica los valores por defecto (nombre "Asistente de …", ayuda, Enviar, bienvenida `null`); los nombres de token pertenecen siempre a la lista cerrada de data-model §4
- [X] T014 [P] [US1] Tests unitarios de la hoja en `tests/unit/webchat/design/css.test.ts`: sin tokens → cadena vacía; con tokens → un único bloque `:root { … }` solo con propiedades `--chat-*` de la lista cerrada y valores `#rrggbb` o medidas de la tabla; un texto del operador con `}`, `;`, `</style>` o `url(` nunca aparece en la salida
- [X] T015 [P] [US1] Tests unitarios de opciones y textos en `tests/unit/webchat/design/schemas.test.ts`: colores con mayúsculas se normalizan, con alfa (`#rrggbbaa`), con nombre (`red`) o de 3 cifras se rechazan; límites 40/280/80/20 justo en el borde y uno por encima; salto de línea solo en la bienvenida; caracteres de control rechazados; recorte y vacío → `null`; emojis admitidos; claves desconocidas (`privacy_notice`, `hide_privacy`) descartadas; todos los errores se devuelven a la vez
- [X] T016 [US1] Ampliar `tests/contract/web-chat-design.test.ts` con el frame **con diseño**: `data-palette` en `<html>`, `<link rel="stylesheet" href="/chat/design.css?v=…">` después de `frame.css`, título con el nombre configurado, `<li class="welcome">` como primer elemento de la lista con la bienvenida y sus saltos de línea, `placeholder` y etiqueta de Enviar configurados; con nombre `<b>hola</b> {{ x }}` y bienvenida `<script>alert(1)</script>` el HTML los contiene escapados (US1-6); con textos vacíos, los valores por defecto (US1-4); la cabecera CSP y `Cache-Control: no-store` del frame no cambian; `GET /chat/design.css` → `200 text/css; charset=utf-8`, `no-store`, vacío sin diseño y con los tokens con diseño; si leer el diseño lanza un error, el frame sale como el original (FR-018)
- [X] T017 [P] [US1] Tests de contrato del panel en `tests/contract/admin/chat-design.test.ts`: sin sesión `GET`/`POST` → `302 /admin/login` (y `401` + `HX-Redirect` con htmx) sin guardar nada (US1-8); `POST` sin CSRF → `403`; `GET /admin/chat-design` sin diseño muestra los valores originales y "El chat usa el aspecto original" (US1-1); con diseño, los valores guardados; la navegación tiene "Diseño del chat" justo después de "Chat web"; `POST` válido (urlencoded y multipart sin ficheros) → `303` con "Diseño del chat guardado" (y `200` + `HX-Location` con htmx); `POST` con un texto demasiado largo y una opción inválida → `422` con **ambos** errores en su campo y lo escrito conservado; con `unsupported` el aviso aparece al principio; el recordatorio de responsabilidad del operador está junto a los textos
- [X] T018 [P] [US1] Tests de contrato de la vista previa en `tests/contract/admin/chat-design.test.ts`: `GET /admin/chat-design/preview?view=open` y `?view=closed` con sesión → `200`, las mismas parciales que el frame, conversación de ejemplo marcada como ejemplo, sin `<script>` y sin llamadas a `/chat/api`; `view` desconocido → `open`; cabeceras `Content-Security-Policy` de contracts/admin-chat-design.md, `X-Frame-Options: SAMEORIGIN` y `no-store`; funciona con el chat web desactivado y con el negocio en preparación; no crea conversaciones ni suma consumo (contar filas antes y después) (FR-010); `GET /admin/chat-design/preview.css?primary_color=%23ff0000&shape=soft` devuelve los tokens de esas opciones y con un valor no válido usa el original
- [X] T019 [P] [US1] Test de integración en `tests/integration/chat-design/save.test.ts`: guardar y releer devuelve lo guardado; dos guardados seguidos → gana el último (FR-017); guardar con el chat desactivado funciona y no cambia ninguna columna de `web_chat_settings` ni el estado del negocio (FR-014)

### Implementation for User Story 1

- [X] T020 [US1] Crear `src/webchat/design/theme.ts`: `computeTheme(resolved, businessName)` → `{ customPalette, tokens, htmlAttrs, texts }` (data-model §2); tokens de colores base (`--chat-accent`, `--chat-on-accent`, `--chat-bg`, `--chat-fg`, `--chat-bot-bg`) solo si la paleta difiere de la original (R3); tabla de formas de R5 (`--chat-radius-panel`, `-bubble`, `-control`, `-toggle`) solo si la forma no es `round`; `designVersion(resolved)` (huella corta y estable para `?v=`); exporta la lista cerrada `CSS_TOKENS` (depende de T007)
- [X] T021 [US1] Crear `src/webchat/design/css.ts`: `renderDesignCss(theme)` → texto de la hoja con un único bloque `:root { … }` a partir de `theme.tokens`, comprobando que cada nombre está en `CSS_TOKENS` (depende de T020)
- [X] T022 [US1] Cambiar en `src/channels/web/assets/frame.css` cada color y radio fijo por `var(--chat-…, <valor de hoy>)` según la tabla de data-model §4 (incluido `--chat-bot-bg` con respaldo `var(--chat-bg)`), sin cambiar ningún valor efectivo; añadir bajo `[data-palette]` el color del enlace de privacidad (`--chat-accent`, subrayado, FR-023), el fondo del campo de escritura y el estilo de `.welcome` (`white-space: pre-wrap`, junto al aviso, desplazable con la lista); título de la cabecera en una línea con `text-overflow: ellipsis` sin tapar el botón cerrar (FR-030b). T004 debe seguir pasando
- [X] T023 [US1] En `src/channels/web/routes.ts`: el manejador de `GET /chat/frame` llama a `readChatDesign` en cada petición, sin caché, dentro de un `try/catch` que registra el error y usa el diseño original (FR-018); pasa `computeTheme(...)` a la vista; nueva ruta `GET /chat/design.css` (`text/css; charset=utf-8`, `Cache-Control: no-store`, ignora `v`) que sirve `renderDesignCss` (R2) (depende de T009, T020, T021)
- [X] T024 [US1] Actualizar `src/channels/web/views/frame.eta` y las parciales de `src/channels/web/views/partials/`: atributos de `theme.htmlAttrs` en `<html>`, `<link>` a `/chat/design.css?v=<huella>` **solo si hay diseño guardado**, título = `theme.texts.chatName` (en no disponible, el nombre configurado o "Chat"), `<li class="welcome">` al principio de `messages.eta` si hay bienvenida, `placeholder` y etiqueta de Enviar de `theme.texts`; todo con `<%= %>`; aviso de asistente automático y enlace de privacidad **sin cambios** (FR-021). Sin diseño, el HTML sigue siendo idéntico (T004) (depende de T023)
- [X] T025 [US1] Comprobar en `src/channels/web/assets/frame.js` que los mensajes se añaden después de `<li class="welcome">` y que la bienvenida no se envía ni se guarda como mensaje (FR-007); ajustar solo si el código actual vacía la lista o inserta al principio
- [X] T026 [US1] Crear `src/admin/routes/chat-design.ts` (contexto propio registrado con `requireOperator` + `csrfOnPost`, como `src/admin/routes/config.ts`): `GET /admin/chat-design` (formulario con el diseño vigente u originales, aviso de `unsupported`, flash); `POST /admin/chat-design` en un contexto con `@fastify/multipart` (`attachFieldsToBody: true`, `limits: { files: 3, fileSize: 256 * 1024, fields: 20, fieldSize: 2048 }`, `throwFileSizeLimit: false`, `bodyLimit` 8 MB) que también acepta urlencoded, valida con `validateChatDesignOptions` y responde `303`/`HX-Location` o `422` con todos los errores (R8); `GET /admin/chat-design/preview` y `GET /admin/chat-design/preview.css` (R9); registra `chat_design_saved { outcome, reasons? }` sin textos ni colores (R12) (depende de T009, T020, T021)
- [X] T027 [US1] Registrar la sección en `src/admin/routes/index.ts` y añadir la entrada "Diseño del chat" justo después de "Chat web" en `src/admin/views/layout.eta`
- [X] T028 [P] [US1] Crear `src/admin/views/chat-design.eta`: formulario `multipart/form-data` con `hx-boost="false"` y `_csrf`; cinco colores (`<input type="color">` + texto `#RRGGBB`), radios de forma ("Recta", "Suave", "Redondeada"), `chat_name` (`maxlength=40`, `data-default`), `welcome_text` (`<textarea maxlength=280>`), `placeholder` (`maxlength=80`, `data-default`), `send_label` (`maxlength=20`, `data-default`); errores por campo con `partials/field-error.eta`; recordatorio de que el contenido es responsabilidad del operador y el asistente no lo usa (Principio IV); recuadro "Vista previa · conversación de ejemplo" con dos iframes (`preview?view=closed` 72×72 y `preview?view=open` 380×560); **sin** campos para el aviso ni la privacidad (US2-5)
- [X] T029 [P] [US1] Crear `src/admin/views/chat-design/preview.eta`: documento que incluye `frame.css` y `<link id="chat-design-css" href="/chat/design.css…">` del diseño guardado, y pinta las parciales de `src/channels/web/views/partials/` (botón cerrado en `closed`; chat abierto con aviso, privacidad, bienvenida y una conversación de ejemplo **genérica** marcada como ejemplo en `open`); sin `<script>`
- [X] T030 [US1] En `src/app.ts`: servir `GET /assets/chat-design.js` como `/assets/app.js` (`text/javascript`, `max-age=3600`) y añadir `/admin/chat-design/preview` y `/admin/chat-design/preview.css` a la excepción del gancho `onSend` (como `/chat/frame`), con su CSP `default-src 'none'; style-src 'self'; img-src 'self' blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`, `X-Frame-Options: SAMEORIGIN` y `Cache-Control: no-store`
- [X] T031 [US1] Crear `src/admin/views/chat-design.js` (sin dependencias, solo actúa si existe el formulario de la sección): sincroniza cada `<input type="color">` con su texto; con una espera de 150 ms cambia el `href` de `#chat-design-css` de los dos iframes a `/admin/chat-design/preview.css?<opciones>` y escribe nombre, ayuda, Enviar y bienvenida con `textContent` / `placeholder` (o el `data-default` si está vacío; sin bienvenida si está vacía) (R9, FR-008)
- [X] T032 [P] [US1] Estilos de la sección y del recuadro de vista previa (dos iframes, etiqueta "conversación de ejemplo", controles de color) en `src/admin/views/app.css`

**Checkpoint**: la US1 funciona sola: personalizar, previsualizar, guardar y verlo en el chat; sin
diseño, el chat es idéntico al de la 004.

---

## Phase 4: User Story 2 - Contraste y elementos obligatorios protegidos (Priority: P1)

**Goal**: no se puede guardar un diseño ilegible; los colores derivados (atenuado, borde del campo,
foco, franja de derivación) cumplen 4,5:1 y 3:1 con cualquier diseño guardable; el aviso, la
privacidad y la salida a una persona están siempre presentes.

**Independent Test**: probar colores justo por encima y por debajo de 4,5:1 (solo se guardan los que
cumplen, también sin JavaScript); con los valores más extremos, el aviso, el enlace, el campo,
Enviar y cerrar siguen presentes (quickstart §3).

### Tests for User Story 2 ⚠️

- [X] T033 [P] [US2] Tests unitarios del contraste en `tests/unit/webchat/design/contrast.test.ts`: luminancia relativa y razón WCAG 2.x (negro/blanco = 21, mismo color = 1); una pareja con razón 4,4999… no cumple y una de 4,5 sí; 3:1 en el borde; `formatRatio` trunca a dos decimales con coma ("4,49:1", nunca "4,50:1" para 4,499); las cinco parejas de R4 y la original cumple todas (data-model §2)
- [X] T034 [P] [US2] Test de propiedad en `tests/unit/webchat/design/theme.test.ts`: con un generador pseudoaleatorio de semilla fija, miles de paletas; para cada una que pasa las parejas de R4, `--chat-muted` ≥ 4,5:1 frente a `background`, `--chat-field-border` ≥ 3:1 frente a `background`, `--chat-focus` = `text` (≥ 4,5:1 frente a `background` y `botBubble`) y siempre existen; la paleta original no emite derivados (R3)
- [X] T035 [P] [US2] Ampliar `tests/unit/webchat/design/schemas.test.ts`: `validateChatDesign` rechaza cada pareja de R4 por separado con el mensaje "… tiene un contraste de X,XX:1; el mínimo es 4,5:1" en el campo que indica data-model §3, y devuelve a la vez los errores de contraste y los de texto
- [X] T036 [US2] Ampliar `tests/contract/admin/chat-design.test.ts`: `POST` con contraste insuficiente → `422` con la pareja, la razón y el mínimo, y el diseño guardado no cambia (US2-1, US2-3); `POST /admin/chat-design/check` → `200` con la parcial `hx-swap-oob` por control (vacía si cumple; "Indica un color opaco en formato #RRGGBB" si el color está mal escrito) y sin guardar; un `POST /admin/chat-design/check` multipart que incluya un fichero responde igual y no guarda la imagen; un `POST` con `privacy_notice=`, `hide_privacy=1` u otros campos inventados se guarda sin efecto sobre el aviso ni el enlace (US2-5)
- [X] T037 [US2] Ampliar `tests/contract/web-chat-design.test.ts` con los elementos obligatorios (Principios IV y V): con nombre de 40 caracteres, bienvenida de 280 con saltos de línea, forma `round`, paleta propia (las tres imágenes se añaden en T047a), el frame contiene el aviso de asistente automático y el enlace de privacidad con su texto original y antes del primer mensaje, el campo, Enviar con etiqueta no vacía y cerrar (US2-4, US2-6); con el chat desactivado, el negocio en preparación, el tope de uso y el tope de gasto alcanzados, el frame con diseño muestra el mensaje de no disponible y el contacto de derivación de la 004/010 (US2-7); la franja de derivación de la 005 sigue presente en `frame.js`/`frame.css`
- [X] T038 [P] [US2] Test unitario en `tests/unit/webchat/design/store.test.ts`: una fila guardada cuyos colores ya no cumplen alguna pareja hace que **toda** la paleta vuelva a la original y se anote en `unsupported` (R13)

### Implementation for User Story 2

- [X] T039 [P] [US2] Crear `src/webchat/design/contrast.ts`: `relativeLuminance(hex)` (sRGB, umbral 0,04045), `contrastRatio(a, b)` sin redondear, `meets(ratio, min)`, `formatRatio(ratio)` (truncado, coma decimal), `mix(fg, bg, t)` en sRGB y la tabla `CONTRAST_PAIRS` de R4 con su etiqueta legible y el campo en el que se marca el error (data-model §3)
- [X] T040 [US2] En `src/webchat/design/schemas.ts`, añadir `validateChatDesign(input)` que combina `validateChatDesignOptions` con las parejas de `CONTRAST_PAIRS` y devuelve todos los errores por campo (FR-019, FR-020) (depende de T039)
- [X] T041 [US2] En `src/webchat/design/theme.ts`, derivar con paleta propia `--chat-muted` (mayor `t` ≤ 0,60 de la lista fija `0, 0,05, …` con ≥ 4,5:1), `--chat-field-border` (mayor `t` ≤ 0,80 con ≥ 3:1), `--chat-line` (`t` fijo 0,80) y `--chat-focus` (= `text`) (R4, FR-019a) (depende de T039)
- [X] T042 [US2] En `src/webchat/design/store.ts`, aplicar en `resolveChatDesign` la vuelta a la paleta original si alguna pareja no cumple (R13), y en `saveChatDesign` exigir un diseño ya validado por `validateChatDesign` (depende de T040)
- [X] T043 [US2] En `src/channels/web/assets/frame.css`, bajo `[data-palette]`: `--chat-muted` para aviso de privacidad, estado ("escribiendo…"), mensajes del propio chat, contacto de no disponible, botón cerrar y `::placeholder`; borde del campo con `--chat-field-border`; `:focus-visible { outline: 2px solid var(--chat-focus); outline-offset: 2px }`; franja de derivación con su amarillo y borde de hoy y texto `#1d2330`; enlaces distinguidos por subrayado (FR-023); sin cambiar tamaños de letra ni impedir el zoom. T004 debe seguir pasando
- [X] T044 [US2] En `src/admin/routes/chat-design.ts`: usar `validateChatDesign` al guardar (registrando `reasons: ['contrast', …]`); añadir `POST /admin/chat-design/check` en el contexto multipart (acepta urlencoded y multipart) que responde con la parcial de avisos sin guardar nada (depende de T040)
- [X] T045 [P] [US2] Crear `src/admin/views/partials/contrast-issues.eta` (un contenedor por control con `hx-swap-oob`, pareja, razón obtenida y mínimo, vacío si cumple) y añadir en `src/admin/views/chat-design.eta`, en el `<fieldset>` de colores (no en el `<form>`), `hx-post="/admin/chat-design/check"`, `hx-trigger="input changed delay:300ms"`, `hx-include` con solo los cinco campos de color y `_csrf`, y `hx-encoding="application/x-www-form-urlencoded"`, para que nunca viajen las imágenes elegidas; y los contenedores de aviso junto a cada selector de color (FR-020)

**Checkpoint**: US1 + US2 forman el MVP: diseño guardable solo si es legible, con los elementos
obligatorios siempre presentes.

---

## Phase 5: User Story 3 - Logo, avatar e icono del botón (Priority: P2)

**Goal**: el operador sube, sustituye o quita el logo, el avatar y el icono; se validan por
contenido, se guardan sin metadatos en la BD de la instancia y se sirven desde el propio origen con
caché inmutable por huella.

**Independent Test**: subir una imagen válida en cada hueco y verla en vista previa y chat real;
intentar SVG, renombrados, vacía, demasiado grande y de 2000×2000: todo se rechaza sin guardar nada
(quickstart §4).

### Tests for User Story 3 ⚠️

- [ ] T046 [P] [US3] Tests unitarios de imágenes en `tests/unit/webchat/design/images.test.ts` con `tests/fixtures/images/`: `valid.png`, `valid.jpg`, `valid.webp` y `valid-vp8x.webp` se aceptan con tipo, ancho y alto correctos; `svg-renamed.png`, `html-renamed.png`, `exe-renamed.png` y `gif.gif` → "Formato no admitido: solo PNG, JPEG o WebP"; `empty.png`, `truncated.png` y `bad-crc.png` → "La imagen está dañada o vacía"; `too-small.png` y `too-large-dims.png` → mensaje de dimensiones; `too-big.png` y `truncated: true` → "La imagen supera el máximo de 256 KB"; los ficheros `metadata.*` salen sin `tEXt`/`iTXt`/`eXIf`/`tIME`, `APP1`–`APP15`/`COM` y `EXIF`/`XMP ` (y la bandera de `VP8X` ajustada) y siguen siendo válidos; los `animated.*` conservan la animación; normalizar dos veces da los mismos bytes (idempotencia, SC-008); `sha256` es el de los bytes normalizados
- [ ] T047 [US3] Ampliar `tests/contract/web-chat-design.test.ts`: con icono, `<img class="design-icon" alt="">` dentro del botón con `aria-expanded` y la etiqueta "Abrir el chat" intactos y el emoji oculto (FR-030a); con logo, `<img class="design-logo" alt="">` a la izquierda del título (FR-030b, FR-024); con avatar, `data-avatar` y `--chat-avatar` en `design.css`; `GET /chat/design/:slot/:file` con la huella vigente → `200`, bytes, `Content-Type` detectado, `Cache-Control: public, max-age=31536000, immutable`, `Content-Disposition: inline`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `X-Content-Type-Options: nosniff`, sin `Set-Cookie`; huella antigua, hueco desconocido, extensión distinta del tipo o sin diseño → `404` (FR-031, FR-032); ninguna URL del HTML ni de `design.css` apunta a otro origen (FR-041)
- [ ] T047a [US3] Ampliar el caso de elementos obligatorios de T037 en `tests/contract/web-chat-design.test.ts` con las tres imágenes guardadas (logo, avatar e icono de `tests/fixtures/images/`) junto al nombre de 40 caracteres, la bienvenida de 280 y la forma `round`: el aviso de asistente automático y el enlace de privacidad siguen con su texto original y antes del primer mensaje, y el título, el campo, Enviar, cerrar y el contacto de no disponible siguen presentes (US2-6, FR-021, FR-030b, SC-004)
- [ ] T048 [US3] Ampliar `tests/contract/admin/chat-design.test.ts`: guardado multipart con las tres imágenes válidas → `303`; con un SVG, un fichero de más de 256 KB (llega `truncated`) o de 2000×2000 junto con colores válidos → `422` con el error **en el campo de esa imagen**, "Vuelve a elegir la imagen" en las elegidas y nada guardado; `logo_remove` solo aparece si hay logo guardado
- [ ] T049 [P] [US3] Test de integración en `tests/integration/chat-design/images.test.ts`: todo o nada (una imagen inválida y el resto válido → ni opciones ni imágenes cambian y la imagen anterior se conserva, US3-4); sustituir, quitar y conservar por hueco en el mismo guardado (FR-029); tras sustituir, la URL antigua da `404` y la nueva `200` (US3-5); los bytes guardados no llevan metadatos
- [ ] T050 [P] [US3] Ampliar `tests/unit/webchat/design/store.test.ts`: una imagen guardada cuyos bytes ya no pasan la validación se ignora (hueco vacío) sin afectar al resto (R13)

### Implementation for User Story 3

- [ ] T051 [P] [US3] Crear `src/webchat/design/images.ts` en TypeScript puro y síncrono, sin dependencias: detección por contenido (PNG: firma, `IHDR` primero, longitudes y CRC de cada bloque, `IEND`; JPEG: `FFD8`, segmentos coherentes, `SOFn` con dimensiones, `SOS`, `FFD9`; WebP: `RIFF` + longitud + `WEBP` y `VP8 `/`VP8L`/`VP8X` con dimensiones), límites (≤ 262 144 bytes, 16–1024 px), eliminación de metadatos sin recodificar (R7), cálculo de `sha256` con `node:crypto`; `validateDesignImage({ bytes, truncated })` → `DesignImage` o error con los mensajes de data-model §3; también `ImageChange` (`keep` | `remove` | `replace`)
- [ ] T052 [US3] En `src/webchat/design/schemas.ts`, extender `validateChatDesign` para aceptar un `ImageChange` por hueco y devolver los errores de imagen en `logo`, `avatar` o `icon` junto con los demás (FR-011a) (depende de T051)
- [ ] T053 [US3] En `src/webchat/design/store.ts`: `saveChatDesign(tx, options, imageChanges)` hace en la misma transacción el `upsert` de la fila y, por hueco, borra, inserta/sustituye o deja la imagen; `readChatDesign` devuelve `images` con `ImageRef` (`url = /chat/design/<slot>/<sha256[0..16]>.<png|jpg|webp>`) a partir de los metadatos; `readDesignImageBytes(tx, slot)` lee los bytes solo para servirlos; ignorar en la lectura las imágenes que no pasan `validateDesignImage` (depende de T051)
- [ ] T054 [US3] En `src/webchat/design/theme.ts`, añadir `--chat-avatar: url(/chat/design/avatar/<f>)` y `data-avatar` cuando hay avatar, y exponer las URL del logo y del icono para las vistas
- [ ] T055 [US3] En `src/channels/web/routes.ts`, añadir `GET /chat/design/:slot/:file` con la comprobación de hueco, huella y extensión y las cabeceras de contracts/chat-design-http.md; `404` en cualquier otro caso (R10) (depende de T053)
- [ ] T056 [US3] En `src/channels/web/views/partials/toggle.eta` y `header.eta`, pintar `<img class="design-icon" alt="">` dentro del botón (emoji oculto pero presente) y `<img class="design-logo" alt="">` a la izquierda del título, solo si existen; en `messages.eta`, nada cambia (el avatar es fondo CSS)
- [ ] T057 [US3] En `src/channels/web/assets/frame.css`: `.design-icon` y `.design-logo` con `object-fit: contain`, tamaño fijo del hueco e `image-orientation: none`; `[data-avatar]` muestra `--chat-avatar` junto a los mensajes del bot sin cambiar la disposición (FR-030); el emoji del botón se oculta solo si hay `.design-icon`
- [ ] T058 [US3] En `src/channels/web/assets/frame.js`, quitar un `img.design-icon` o `img.design-logo` que dispare `error` y volver a mostrar el emoji original (FR-018, R13)
- [ ] T059 [US3] En `src/admin/routes/chat-design.ts`, un `onFile` que lea cada fichero (`logo`, `avatar`, `icon`) a un `Buffer` y anote `truncated`; construir el `ImageChange` de cada hueco (fichero nuevo → `replace`; si no, `<hueco>_remove` → `remove`; si no, `keep`); pasar los errores de imagen a la vista; registrar `images` por hueco (`kept` | `added` | `replaced` | `removed` | `none`) en `chat_design_saved` sin nombres de fichero (R8, R12) (depende de T052, T053)
- [ ] T060 [US3] En `src/admin/views/chat-design.eta`, añadir los tres `<input type="file" accept="image/png,image/jpeg,image/webp">`, la miniatura de la imagen guardada, la casilla "Quitar" (solo si hay imagen) y los errores por imagen con "Vuelve a elegir la imagen"
- [ ] T061 [US3] En `src/admin/views/chat-design.js`, mostrar cada imagen elegida en los iframes con `URL.createObjectURL` (logo e icono como `src`, avatar como `--chat-avatar` por CSSOM), retirarla al marcar "Quitar", revocar las URL al cambiar, y avisar en el campo, sin bloquear, si el fichero supera 256 KB o su tipo declarado no es PNG, JPEG o WebP (FR-009, FR-011)
- [ ] T062 [US3] En `src/admin/views/chat-design/preview.eta`, pintar las imágenes guardadas en las parciales igual que el frame

**Checkpoint**: imágenes validadas, servidas con seguridad y visibles en vista previa y chat real.

---

## Phase 6: User Story 4 - Posición y tamaño del chat (Priority: P2)

**Goal**: el botón y el chat abierto aparecen en la esquina elegida y con el tamaño elegido en una
web con el fragmento antiguo, sin que el negocio cambie nada.

**Independent Test**: guardar "Abajo a la izquierda" y "Grande", recargar una web con el fragmento
de antes y comprobar la esquina y 440×640; en un móvil, nada sale de la pantalla (quickstart §5).

### Tests for User Story 4 ⚠️

- [ ] T063 [P] [US4] Ampliar `tests/unit/channels/web-widget.test.ts`: `chat:resize` con `size: 'small' | 'medium' | 'large'` da 320×480, 380×560 y 440×640 con `max-width: calc(100vw - 32px)` y `max-height: calc(100vh - 32px)`; `position: 'left'` pone `left: 16px; right: auto` antes de hacer visible el iframe; sin campos o con valores desconocidos (`'huge'`, `'999px'`, números) → `medium` y `right`; cerrado sigue en 72×72; mensajes de otro origen u otra ventana se siguen ignorando
- [ ] T064 [P] [US4] Ampliar `tests/unit/channels/web-assets.test.ts` (o el test de `frame.js` existente): `tellParent(open)` incluye `size` y `position` leídos de `document.documentElement.dataset`, con `medium`/`right` si faltan
- [ ] T065 [US4] Ampliar `tests/unit/webchat/design/theme.test.ts` y `tests/contract/web-chat-design.test.ts`: `position: 'left'` → `data-position="left"`; `size: 'small' | 'large'` → `data-size`; `right` y `medium` no emiten atributos (R3); el formulario del panel muestra los radios de posición y tamaño y guarda sus valores

### Implementation for User Story 4

- [ ] T066 [US4] En `src/webchat/design/theme.ts`, emitir `data-position` y `data-size` solo cuando difieren del original
- [ ] T067 [US4] En `src/channels/web/assets/frame.css`, `[data-position="left"] .toggle { left: 8px; right: auto }` y lo que haga falta para que el chat abierto se alinee a la izquierda dentro del iframe
- [ ] T068 [US4] En `src/channels/web/assets/frame.js`, añadir `size` y `position` (por nombre, nunca medidas) al mensaje `chat:resize` (R6)
- [ ] T069 [US4] En `src/channels/web/assets/widget.js`, tabla propia de tamaños de R5, traducción por nombre con `medium`/`right` por defecto ante cualquier otro valor, cambio de `left`/`right` del iframe antes de hacerlo visible, conservando los límites de pantalla pequeña y la comprobación de origen (FR-013, FR-034)
- [ ] T070 [US4] En `src/admin/views/chat-design.eta`, radios de posición ("Abajo a la derecha", "Abajo a la izquierda") y tamaño ("Pequeño", "Mediano", "Grande"); en `src/admin/views/chat-design.js`, ajustar tamaño y esquina del iframe abierto de la vista previa con la misma tabla (FR-008, US4-6)

**Checkpoint**: posición y tamaño llegan a la web del negocio con el fragmento ya pegado.

---

## Phase 7: User Story 5 - El diseño viaja con la exportación e importación (Priority: P2)

**Goal**: formato de configuración v2 con la sección `chatDesign` (imágenes en base64), validada
con las mismas reglas, reemplazada como el resto, mostrada en la vista previa de la importación e
incluida en la configuración anterior; los ficheros v1 siguen importándose.

**Independent Test**: exportar un diseño completo, importarlo en otra instancia con otro diseño,
revisar la vista previa, confirmar: mismo diseño y la activación del destino intacta; reimportar
no muestra cambios (quickstart §6).

### Tests for User Story 5 ⚠️

- [ ] T071 [P] [US5] Comprobar que `tests/unit/config-transfer/column-coverage.test.ts` (ampliado en T006a) sigue fallando con las columnas de `chat_design` y `chat_design_image` y que pasa tras T080
- [ ] T072 [P] [US5] Ampliar `tests/unit/config-transfer/parse.test.ts`: un fichero de `formatVersion: 1` se actualiza con `chatDesign: null`; uno de la 2 se acepta; uno de la 3 se rechaza como "versión posterior"
- [ ] T073 [P] [US5] Ampliar `tests/unit/config-transfer/schema.test.ts`: `chatDesign` obligatorio (objeto o `null`), objetos estrictos (clave desconocida → error), las cuatro claves de `images` obligatorias; errores de contracts/config-file-chat-design.md (contraste, `type` que no coincide, base64 inválido, imagen de más de 256 KB, `"size": "huge"`, texto de 300 caracteres) todos a la vez con la sección "Diseño del chat" y su campo
- [ ] T074 [P] [US5] Ampliar `tests/unit/config-transfer/diff.test.ts`: destino sin diseño y fichero con diseño → `added` "Diseño del chat"; al revés → `removed` "Diseño del chat (vuelve al aspecto original)"; cambios campo a campo con las etiquetas de data-model §6 sobre valores **efectivos**; imágenes como añadida/cambiada/eliminada por huella con "Imagen (PNG, 128 × 128)"; mismo diseño → sin cambios
- [ ] T075 [P] [US5] Ampliar `tests/unit/config-transfer/log.test.ts`: `counts.chatDesign` (0/1) y `changes.chatDesign`, sin textos, colores ni bytes
- [ ] T076 [P] [US5] Crear `tests/fixtures/config/v2-chat-design.json` (diseño completo con las tres imágenes de `tests/fixtures/images/` en base64; nombres de ejemplo solo aquí) y comprobar que el fichero `v1` existente de `tests/fixtures/config/` sigue sirviendo para la importación antigua
- [ ] T077 [US5] Ampliar `tests/contract/admin/config-import.test.ts`: la exportación trae `formatVersion: 2` y `chatDesign` (o `null`); importar v1 en un destino con diseño anuncia la eliminación del diseño; importar v2 muestra la sección "Diseño del chat" en la vista previa; un fichero con diseño inválido se rechaza entero con errores por campo
- [ ] T078 [P] [US5] Ampliar `tests/integration/config-transfer/round-trip.test.ts` y `tests/integration/config-transfer/apply.test.ts`: ida y vuelta con las tres imágenes (bytes idénticos); reimportar el mismo fichero no muestra cambios de diseño (SC-008); la importación no cambia `web_chat_settings` ni la activación (FR-037); importar la configuración anterior restaura el diseño previo (FR-038); con tres imágenes de 256 KB el fichero queda por debajo de 5 MB (FR-039); importar `chatDesign: null` borra la fila y sus imágenes

### Implementation for User Story 5

- [ ] T079 [US5] En `src/webchat/design/schemas.ts`, añadir `chatDesignFileSchema` (estricto) con `images.<hueco>` = `null` | `{ type, data }`, validación de base64, `validateDesignImage` y comprobación de que el `type` declarado coincide con el detectado, reutilizando las reglas de opciones, textos y contraste (FR-036)
- [ ] T080 [US5] En `src/config-transfer/format.ts`: `CURRENT_FORMAT_VERSION = 2`, `UPDATERS[1]` que añade `chatDesign: null`, tipo `ConfigChatDesign`, sección "Diseño del chat" después de `webChat` en el orden de secciones, y `COLUMN_COVERAGE` / `EXCLUDED_COLUMNS` de data-model §6 (excluidas `id`, `updated_at`, `design_id`, `sha256`, `width`, `height`, `byte_size`) (depende de T079)
- [ ] T081 [US5] En `src/config-transfer/schema.ts`, añadir `chatDesign: chatDesignFileSchema.nullable()` a `configFileSchema` con sus errores por campo en el formato de la 008 (depende de T079)
- [ ] T082 [US5] En `src/config-transfer/read.ts`, incluir `chatDesign` en `readConfigWithInfo` y `readConfigDocument` (opciones guardadas y las imágenes guardadas en base64, claves en el orden del contrato), de modo que la huella de la vista previa y la configuración anterior lo incluyan (FR-038)
- [ ] T083 [US5] En `src/config-transfer/replace.ts`, `replaceChatDesign(tx, doc.chatDesign)` dentro de la escritura protegida existente: no escribe si opciones y huellas no cambian; `null` borra la fila (cascada); nunca toca `web_chat_settings` (FR-037)
- [ ] T084 [US5] En `src/config-transfer/diff.ts`, `chatDesignDiff(current, next)` sobre valores efectivos con las etiquetas de data-model §6 y la comparación de imágenes por huella; integrarlo en el cálculo de diferencias de la vista previa
- [ ] T085 [US5] En `src/config-transfer/log.ts`, recuentos y cambios de `chatDesign` en `countsOf` / `changesOf`
- [ ] T086 [US5] Comprobar que `src/admin/views/partials/config-diff.eta` pinta la sección nueva (campos con antes/después e imágenes); ajustar solo si la parcial no es genérica

**Checkpoint**: el diseño viaja con la configuración; el test de cobertura de columnas vuelve a
pasar.

---

## Phase 8: User Story 6 - Volver al aspecto original (Priority: P3)

**Goal**: una acción con confirmación expresa borra el diseño y sus imágenes, y el chat vuelve al
de la 004.

**Independent Test**: con un diseño guardado con imágenes, restaurar: el formulario y el chat
vuelven a los originales y las URL de las imágenes dan `404` (quickstart §7).

### Tests for User Story 6 ⚠️

- [ ] T087 [P] [US6] Ampliar `tests/contract/admin/chat-design.test.ts`: con diseño, la página muestra "Restaurar el aspecto original" con `hx-confirm`; `GET /admin/chat-design/reset` muestra la confirmación sin JavaScript; `POST /admin/chat-design/reset` → `303` con "Aspecto original restaurado"; sin diseño → "El chat ya usa el aspecto original" y la página no muestra el botón (US6-3); sin sesión o sin CSRF no borra nada
- [ ] T088 [P] [US6] Ampliar `tests/integration/chat-design/images.test.ts`: restaurar borra la fila y las imágenes en cascada; las URL antiguas dan `404`; el frame vuelve a ser idéntico a `frame-004.html`; `web_chat_settings` no cambia

### Implementation for User Story 6

- [ ] T089 [US6] En `src/webchat/design/store.ts`, `resetChatDesign(tx)` → `'reset' | 'nothing_to_reset'`
- [ ] T090 [US6] En `src/admin/routes/chat-design.ts`, `GET /admin/chat-design/reset` (página de confirmación) y `POST /admin/chat-design/reset` con el flash de cada caso y el evento `chat_design_reset { outcome }` (R12)
- [ ] T091 [P] [US6] Crear `src/admin/views/chat-design/reset.eta` con el texto "¿Restaurar el aspecto original? Se borrarán los colores, los textos y las imágenes del diseño." y el botón que envía el `POST` con `_csrf`; en `src/admin/views/chat-design.eta`, el botón con `hx-confirm` (solo con diseño guardado) o el texto "El chat usa el aspecto original"

**Checkpoint**: todas las historias funcionan por separado.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: copias de seguridad, no regresión, neutralidad de sector, documentación y validación
manual.

- [ ] T092 [P] Ampliar `tests/integration/backup/backup-restore.test.ts`: copia con un diseño con imágenes, borrar el diseño, restaurar: fila e imágenes vuelven con los mismos bytes; `db:verify` pasa (Edge case 006, FR-028)
- [ ] T093 [P] Comprobar que `tests/integration/sector-neutrality.test.ts` recorre `src/webchat/design/`, `src/channels/web/views/partials/` y las vistas nuevas del panel, y que la conversación de ejemplo de la vista previa no contiene nombres de sector (FR-044); ampliarlo si no los cubre
- [ ] T094 [P] Añadir en `tests/contract/admin/chat-design.test.ts` la comprobación de seguridad de la vista previa y del panel: textos con `<script>`, `{{ }}` y `"><img onerror>` salen escapados en el formulario, en la vista previa y en el frame; `preview.css` con valores maliciosos en la consulta no contiene ese texto (FR-040, SC-010)
- [ ] T095 Ejecutar `pnpm test` completo y confirmar que siguen pasando sin cambios los tests de la 004 (`tests/contract/web-chat*.test.ts`), la 005, la 008 y la 010 (FR-043, SC-006); corregir en el código de esta feature, no en esos tests
- [ ] T096 Ejecutar `pnpm lint && pnpm typecheck` y corregir lo que aparezca
- [ ] T097 Recorrer la lista manual de [quickstart.md](quickstart.md) (§1–§8 y registros) en Chrome, Firefox y Safari (o WebKit), en escritorio y a 360×640, y anotar el resultado (SC-002, SC-004, R15)
- [ ] T098 Avisar al usuario y actualizar `README.md` con el estado de la feature 011 (sección "Diseño del chat" del panel, formato de configuración v2) (CLAUDE.md)
- [ ] T099 Actualizar `docs/operacion-multicliente.md`: tabla de specs realizadas (9.1) con la 011 y su fecha, orden de propuestas pendientes (9.2), marcar como hecha la propuesta de personalizar el aspecto del chat y actualizar las secciones de operación afectadas (formato v2 en exportación e importación; el diseño viaja en las copias) (CLAUDE.md)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias. **T001 va antes de cualquier cambio en `src/channels/web/`.**
- **Foundational (Phase 2)**: depende de Setup; bloquea todas las historias.
- **US1 (Phase 3)**: depende de Foundational.
- **US2 (Phase 4)**: depende de US1 (amplía `theme.ts`, `schemas.ts`, `frame.css` y la ruta del
  panel). US1 + US2 forman el MVP; no se entrega una sin la otra.
- **US3 (Phase 5)**: depende de US1 (formulario, guardado, parciales); conviene después de US2 para
  que el guardado ya valide contraste.
- **US4 (Phase 6)**: depende de US1; independiente de US2, US3 y US5.
- **US5 (Phase 7)**: depende de US2 (contraste en la validación) y de US3 (imágenes en el fichero).
  **Obligatoria antes de integrar en `main`**: desde T006a el test de cobertura de columnas falla
  hasta T080.
- **US6 (Phase 8)**: depende de US1; las pruebas de cascada usan imágenes (US3).
- **Polish (Phase 9)**: depende de todas las historias.

### User Story Dependencies

```text
Setup → Foundational → US1 → US2 ─┬─→ US3 ─┬─→ US5 ─┐
                        │         │        └─→ US6 ─┤
                        └─────────┴─→ US4 ──────────┴─→ Polish
```

### Within Each User Story

- Tests primero, y deben fallar antes de implementar.
- Dominio (`src/webchat/design/`) antes que rutas; rutas antes que vistas y scripts.
- T004 (frame sin diseño idéntico al de la 004) debe pasar al cerrar cada fase.

### Parallel Opportunities

- Setup: T002 y T003 en paralelo (T001 primero o a la vez, sin tocar `src/channels/web/`).
- Foundational: T007, T008, T010 y T011 en paralelo; T005 → T006 → T006a; T009 tras T007 y T008; T012
  tras T004.
- US1: tests T013, T014, T015, T017, T018 y T019 en paralelo; T028, T029 y T032 en paralelo una vez
  existen la ruta y el tema.
- US2: T033, T034, T035 y T038 en paralelo; T039 y T045 en paralelo.
- US3: T046, T049 y T050 en paralelo; T051 en paralelo con los tests.
- US4 puede hacerse en paralelo con US3 por otra persona (ficheros distintos salvo `frame.css`,
  `frame.js`, `chat-design.eta` y `chat-design.js`: coordinar esas ediciones).
- US5: T071–T076 en paralelo.
- Polish: T092, T093 y T094 en paralelo.

---

## Parallel Example: User Story 1

```bash
# Tests de la US1 a la vez:
Task: "Tests unitarios del tema en tests/unit/webchat/design/theme.test.ts"
Task: "Tests unitarios de la hoja en tests/unit/webchat/design/css.test.ts"
Task: "Tests unitarios de opciones y textos en tests/unit/webchat/design/schemas.test.ts"
Task: "Tests de contrato del panel en tests/contract/admin/chat-design.test.ts"
Task: "Test de integración en tests/integration/chat-design/save.test.ts"

# Vistas de la US1 a la vez (tras T026):
Task: "Crear src/admin/views/chat-design.eta"
Task: "Crear src/admin/views/chat-design/preview.eta"
Task: "Estilos en src/admin/views/app.css"
```

## Parallel Example: User Story 5

```bash
Task: "CONFIG_TABLES en tests/unit/config-transfer/column-coverage.test.ts"
Task: "Actualizador 1→2 en tests/unit/config-transfer/parse.test.ts"
Task: "Esquema chatDesign en tests/unit/config-transfer/schema.test.ts"
Task: "Diferencias en tests/unit/config-transfer/diff.test.ts"
Task: "Recuentos en tests/unit/config-transfer/log.test.ts"
Task: "Fichero v2 en tests/fixtures/config/v2-chat-design.json"
```

---

## Implementation Strategy

### MVP (US1 + US2, ambas P1)

1. Phase 1: Setup (T001 antes de tocar el canal web).
2. Phase 2: Foundational.
3. Phase 3: US1 → validar con quickstart §1–§2.
4. Phase 4: US2 → validar con quickstart §3.
5. **Parar y validar**: colores, forma, nombre y textos con vista previa, siempre legibles y con los
   elementos obligatorios.

El MVP no se integra en `main` sin la US5 (formato v2): la migración `0007` añade configuración del
negocio y CLAUDE.md exige subir `formatVersion` con ella.

### Entrega incremental

1. Setup + Foundational → base lista.
2. US1 + US2 → MVP demostrable.
3. US3 → imágenes.
4. US4 → posición y tamaño.
5. US5 → exportación e importación (desbloquea la integración en `main`).
6. US6 → restaurar.
7. Polish → copias, no regresión, documentación y validación manual.

### Con varias personas

Tras US1 + US2: una persona con US3 → US5, otra con US4 → US6, coordinando las ediciones de
`frame.css`, `frame.js`, `chat-design.eta` y `chat-design.js`.

---

## Notes

- [P] = ficheros distintos y sin dependencias pendientes.
- [Story] relaciona cada tarea con su historia para la trazabilidad.
- Nada de lo que la spec no menciona cambia en el chat web (FR-043): si un test existente de la
  004, 005, 008 o 010 falla, se corrige el código de esta feature.
- Hacer commit tras cada tarea o grupo lógico.
