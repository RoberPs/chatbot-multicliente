# Data Model: Diseño del chat web

**Feature**: 011-chat-design · **Fecha**: 2026-10-02

Entidades, reglas y estados del diseño del chat. Las decisiones que justifican cada punto están en
[research.md](research.md) (R1–R15).

---

## 1. Tablas (migración `0007_chat_design.sql`, solo añade)

### `chat_design` — fila única; su ausencia es el aspecto original (R1)

| Columna | Tipo | Nulo | Notas |
|---|---|---|---|
| `id` | `smallint` PK, `DEFAULT 1` | no | `CHECK (id = 1)` |
| `primary_color` | `text` | no | `#rrggbb` en minúsculas (validado en el dominio) |
| `on_primary_color` | `text` | no | texto e icono sobre el principal |
| `background_color` | `text` | no | fondo del chat |
| `text_color` | `text` | no | texto del chat |
| `bot_bubble_color` | `text` | no | fondo de los mensajes del bot |
| `shape` | `text` | no | `square` \| `soft` \| `round` |
| `position` | `text` | no | `right` \| `left` |
| `size` | `text` | no | `small` \| `medium` \| `large` |
| `chat_name` | `text` | sí | `NULL` = "Asistente de" + nombre del negocio |
| `welcome_text` | `text` | sí | `NULL` = sin bienvenida |
| `placeholder_text` | `text` | sí | `NULL` = "Escribe tu mensaje" |
| `send_label` | `text` | sí | `NULL` = "Enviar" |
| `updated_at` | `timestamptz` | no | `DEFAULT clock_timestamp()`, como el resto |

Sin enums ni `CHECK` de valores en las opciones: la lectura es tolerante (R13).

### `chat_design_image` — una fila por hueco ocupado

| Columna | Tipo | Nulo | Notas |
|---|---|---|---|
| `slot` | `text` PK | no | `logo` \| `avatar` \| `icon` |
| `design_id` | `smallint` | no | FK → `chat_design.id` `ON DELETE CASCADE` |
| `mime_type` | `text` | no | tipo **detectado**: `image/png` \| `image/jpeg` \| `image/webp` |
| `bytes` | `bytea` | no | imagen ya normalizada (sin metadatos, R7) |
| `sha256` | `text` | no | hex de 64 caracteres de `bytes` |
| `width`, `height` | `integer` | no | 16 – 1024 |
| `byte_size` | `integer` | no | 1 – 262 144 |
| `updated_at` | `timestamptz` | no | |

`CHECK (byte_size BETWEEN 1 AND 262144)` y `CHECK (width BETWEEN 16 AND 1024 AND height BETWEEN 16
AND 1024)` como red de seguridad; la validación con mensajes está en el dominio.

Ambas tablas son configuración del negocio: viajan en el fichero de la 008 (§6) y entran solas en
las copias de la 006.

---

## 2. Tipos del dominio (`src/webchat/design/`)

```text
ChatDesignOptions            // lo que el operador elige (sin imágenes)
  primaryColor, onPrimaryColor, backgroundColor, textColor, botBubbleColor : Hex   // '#rrggbb'
  shape    : 'square' | 'soft' | 'round'
  position : 'right' | 'left'
  size     : 'small' | 'medium' | 'large'
  chatName, welcomeText, placeholder, sendLabel : string | null

DesignImage
  slot     : 'logo' | 'avatar' | 'icon'
  mimeType : 'image/png' | 'image/jpeg' | 'image/webp'
  bytes    : Buffer
  sha256, width, height, byteSize

ImageChange (por hueco, solo al guardar desde el panel)
  { kind: 'keep' } | { kind: 'remove' } | { kind: 'replace', upload: { bytes, truncated } }

ResolvedChatDesign           // lo que se aplica al chat y a la vista previa
  saved       : boolean                     // hay fila
  options     : ChatDesignOptions           // efectivos: los originales donde no hay o no vale
  images      : Partial<Record<Slot, ImageRef>>   // ImageRef = { url, mimeType, width, height }
  unsupported : string[]                    // campos guardados que no se han podido aplicar (R13)

Theme                        // derivado de ResolvedChatDesign (theme.ts)
  customPalette : boolean                   // ≠ paleta original (R3)
  tokens        : Record<CssVar, string>    // solo los que cambian respecto del original
  htmlAttrs     : { 'data-palette'?, 'data-position'?, 'data-size'?, 'data-avatar'? }
  texts         : { chatName, welcomeText | null, placeholder, sendLabel }   // ya con defectos
```

### Valores originales (`ORIGINAL_DESIGN`)

Los del chat de la 004 (FR-015): `primaryColor #1f5fbf`, `onPrimaryColor #ffffff`,
`backgroundColor #ffffff`, `textColor #1d2330`, `botBubbleColor #ffffff`, `shape round`,
`position right`, `size medium`, los cuatro textos `null`, sin imágenes. Es un diseño válido: cumple
todas las parejas de §3.

---

## 3. Reglas de validación (al guardar en el panel y al importar)

| Regla | Mensaje (en el campo) |
|---|---|
| Color: `#` + 6 hexadecimales (sin alfa, sin nombres); se normaliza a minúsculas (FR-006) | "Indica un color opaco en formato #RRGGBB" |
| `shape`, `position`, `size` en su lista | "Opción no válida" |
| Textos: longitud máxima (unidades UTF-16, como `maxlength`; R14) y saltos de línea según R14; sin caracteres de control | "Máximo N caracteres" · "Este texto va en una sola línea" |
| Parejas de contraste (R4), cada una ≥ 4,5:1 | "El texto sobre el color principal tiene un contraste de 3,21:1; el mínimo es 4,5:1" (en el control del color de la pareja que el operador está cambiando: el segundo de la tabla de R4 se marca en ambos) |
| Imagen: formato real PNG/JPEG/WebP (R7) | "Formato no admitido: solo PNG, JPEG o WebP" |
| Imagen dañada, vacía o con estructura incoherente | "La imagen está dañada o vacía" |
| Imagen > 256 KB (`truncated` o `byte_size`) | "La imagen supera el máximo de 256 KB" |
| Dimensiones fuera de 16 – 1024 px | "La imagen debe medir entre 16 y 1024 px de ancho y de alto" |
| Importación: `type` declarado ≠ detectado | "El tipo declarado no coincide con el contenido de la imagen" |
| Importación: `data` no es base64 válido | "La imagen no está en base64" |

Todo se valida a la vez y se devuelven todos los errores (FR-011a, FR-036). Los campos del aviso de
asistente automático y del enlace de privacidad **no existen** en el esquema: una petición que los
mande no tiene efecto (los objetos del esquema descartan las claves desconocidas en el panel y las
rechazan en la importación, que es estricta) (US2-5).

### Parejas de contraste

`onPrimary/primary`, `text/background`, `text/botBubble`, `primary/background`, `primary/botBubble`
— mínimo 4,5:1, razón sin redondear (R4).

### Derivados (solo con paleta propia)

`--chat-muted` (≥ 4,5:1 frente a `background`), `--chat-field-border` (≥ 3:1 frente a
`background`), `--chat-line` (decorativo), `--chat-focus` (= `text`), franja de derivación con
texto `#1d2330` sobre su amarillo de hoy. Siempre existen (R4).

---

## 4. Tokens CSS (`/chat/design.css`)

Solo se emiten los que difieren del original (R3). Nombres cerrados; valores de tablas o colores
ya validados.

| Token | Origen | Respaldo en `frame.css` (= hoy) |
|---|---|---|
| `--chat-accent` | `primaryColor` | `#1f5fbf` |
| `--chat-on-accent` | `onPrimaryColor` | `#fff` |
| `--chat-bg` | `backgroundColor` | `#fff` |
| `--chat-fg` | `textColor` | `#1d2330` |
| `--chat-bot-bg` | `botBubbleColor` | `var(--chat-bg)` |
| `--chat-muted` | derivado | `#5f6878` |
| `--chat-line` | derivado | `#d9dde4` |
| `--chat-field-border` | derivado | `var(--chat-line)` |
| `--chat-focus` | derivado | (sin regla: foco del navegador) |
| `--chat-radius-panel` / `-bubble` / `-control` / `-toggle` | `shape` (R5) | `12px` / `10px` / `8px` / `50%` |
| `--chat-avatar` | `url(/chat/design/avatar/<huella>.<ext>)` | (sin `data-avatar` no se usa) |

Tamaño y posición no son tokens: van como `data-size` / `data-position` en `<html>` (los lee
`frame.js` para el fragmento) y como reglas fijas de `frame.css`.

---

## 5. Estados del diseño

```text
            guardar (válido)               guardar (válido)
 [Original] ───────────────▶ [Guardado] ◀───────────────┐
     ▲   ▲                     │   │                     │
     │   │  restaurar          │   └─────────────────────┘
     │   └─────────────────────┘
     │        importar fichero con chatDesign: null
     └──────────────────────────────────────── (desde Guardado)

 importar fichero con chatDesign: {…} → [Guardado] (desde cualquiera)
 guardar o importar no válido → sin cambios
```

- `Original`: no hay fila en `chat_design` (ni imágenes).
- `Guardado`: hay fila; 0 a 3 imágenes.
- Ninguna transición cambia `web_chat_settings` (activación, webs, privacidad, topes) ni el estado
  del negocio (FR-014, FR-037).
- Dos guardados seguidos: gana el último (FR-017); cada guardado reemplaza la fila entera.

---

## 6. Sección `chatDesign` del fichero de configuración (formato v2)

Forma completa en [contracts/config-file-chat-design.md](contracts/config-file-chat-design.md).

```text
ConfigDocument.chatDesign : ConfigChatDesign | null

ConfigChatDesign
  primaryColor, onPrimaryColor, backgroundColor, textColor, botBubbleColor : string
  shape, position, size : string
  chatName, welcomeText, placeholder, sendLabel : string | null
  images : { logo, avatar, icon : { type: string, data: string /* base64 */ } | null }
```

### Cobertura de columnas (`COLUMN_COVERAGE`)

| Tabla.columna | Campo del documento |
|---|---|
| `chat_design.primary_color` … `bot_bubble_color` | `chatDesign.primaryColor` … `botBubbleColor` |
| `chat_design.shape` / `position` / `size` | `chatDesign.shape` / `position` / `size` |
| `chat_design.chat_name` / `welcome_text` / `placeholder_text` / `send_label` | `chatDesign.chatName` / `welcomeText` / `placeholder` / `sendLabel` |
| `chat_design_image.slot` | `chatDesign.images.<slot>` |
| `chat_design_image.mime_type` | `chatDesign.images.<slot>.type` |
| `chat_design_image.bytes` | `chatDesign.images.<slot>.data` |

Excluidas: `chat_design.id`, `chat_design.updated_at`, `chat_design_image.design_id`, `sha256`,
`width`, `height`, `byte_size`, `updated_at` (internas o derivadas de `bytes`).

### Diferencias en la vista previa de la importación (`SectionDiff` de `chatDesign`)

- `added: [{ label: 'Diseño del chat' }]` si el destino no tiene diseño y el fichero sí.
- `removed: [{ label: 'Diseño del chat (vuelve al aspecto original)' }]` si el destino tiene y el
  fichero no.
- `modified: [{ label: 'Diseño del chat', fields }]` con cada campo **efectivo** que cambia:
  "Color principal", "Texto sobre el principal", "Fondo del chat", "Texto del chat", "Fondo de los
  mensajes del bot", "Forma" (Recta/Suave/Redondeada), "Posición" (Abajo a la derecha/izquierda),
  "Tamaño" (Pequeño/Mediano/Grande), "Nombre del chat", "Bienvenida" (recortada como los textos
  largos), "Texto de ayuda", "Botón Enviar"; y "Logo", "Avatar", "Icono del botón" con
  `before`/`after` = "—" / "Imagen (PNG, 128 × 128)" y la etiqueta añadida, cambiada o eliminada
  según las huellas.
- Reimportar el mismo fichero: sin cambios (huellas e idempotencia de R7, SC-008).

---

## 7. Registros (R12)

| Evento | Campos |
|---|---|
| `chat_design_saved` | `outcome`, `reasons[]` (solo si `rejected`), `images` por hueco |
| `chat_design_reset` | `outcome` |
| `config_import_*` (existentes) | `counts.chatDesign` (0/1) y `changes.chatDesign` |

Nunca textos, nombres de fichero, colores ni bytes.
