# Contrato: sección `chatDesign` del fichero de configuración (formato v2)

**Feature**: 011-chat-design · Amplía contracts/config-file-format.md de la 008.

## Cambios en el sobre

- `formatVersion`: **2**. Esta instancia escribe la 2 y entiende la 1 y la 2.
- Actualizador `1 → 2`: añade `"chatDesign": null` (un fichero antiguo se importa como "sin diseño":
  el destino vuelve al aspecto original, US5-4).
- Un fichero con `formatVersion` 3 o mayor se rechaza como hoy ("versión posterior").

## Sección

Va después de `webChat`. Clave obligatoria (con objeto o `null`); objetos estrictos (una clave
desconocida es un error).

```json
"chatDesign": {
  "primaryColor": "#0b6e4f",
  "onPrimaryColor": "#ffffff",
  "backgroundColor": "#ffffff",
  "textColor": "#1d2330",
  "botBubbleColor": "#eef6f2",
  "shape": "soft",
  "position": "left",
  "size": "large",
  "chatName": "Atención al cliente",
  "welcomeText": "Pregúntame por horarios y servicios.\nTe respondo al momento.",
  "placeholder": null,
  "sendLabel": null,
  "images": {
    "logo": { "type": "image/png", "data": "iVBORw0KGgoAAAANSUhEUgAA…" },
    "avatar": null,
    "icon": null
  }
}
```

| Campo | Regla |
|---|---|
| cinco colores | `#RRGGBB` (se normaliza a minúsculas); parejas de contraste ≥ 4,5:1 (data-model §3) |
| `shape` | `square` \| `soft` \| `round` |
| `position` | `right` \| `left` |
| `size` | `small` \| `medium` \| `large` |
| `chatName` | `null` o texto de 1–40, una línea |
| `welcomeText` | `null` o texto de 1–280, admite `\n` |
| `placeholder` | `null` o texto de 1–80, una línea |
| `sendLabel` | `null` o texto de 1–20, una línea |
| `images.<hueco>` | `null` o `{ type, data }`; `type` ∈ `image/png`, `image/jpeg`, `image/webp` y debe coincidir con el contenido; `data` en base64 estándar; la imagen cumple R7 (formato real, ≤ 256 KB, 16–1024 px) |

Las cuatro claves de `images` son obligatorias (con `null` si no hay). Al exportar, las imágenes
salen tal como están guardadas (ya normalizadas) y las claves en este orden.

## Errores

Con las reglas de la 008: todos a la vez, con sección "Diseño del chat", campo
(`images.logo.data`, `primaryColor`…) y motivo; un solo error rechaza el fichero entero sin cambiar
nada (FR-036). Ejemplos:

- `chatDesign.primaryColor` — "El color principal frente al fondo del chat tiene un contraste de
  2,10:1; el mínimo es 4,5:1"
- `chatDesign.images.icon.type` — "El tipo declarado no coincide con el contenido de la imagen"
- `chatDesign.images.logo.data` — "La imagen supera el máximo de 256 KB"
- `chatDesign.size` — "Valor no válido; se admite: \"small\", \"medium\", \"large\""

## Aplicación

- Reemplazo completo: el diseño del destino pasa a ser el del fichero; `null` lo borra (FR-037).
- No cambia `info.webChatEnabled` del destino ni su configuración del chat web.
- La configuración anterior guardada por la importación incluye el diseño del destino (FR-038).
- Tamaño: con las tres imágenes al máximo, la sección ocupa ≈ 1 MB (límite del fichero: 5 MB,
  FR-039).
