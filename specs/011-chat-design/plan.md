# Implementation Plan: Diseño del chat web

**Branch**: `011-chat-design` | **Date**: 2026-10-02 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/011-chat-design/spec.md`

**Ámbito**: Núcleo

## Summary

El operador personaliza el aspecto del chat web de su instancia en una sección nueva del panel,
"Diseño del chat": cinco colores, forma, posición, tamaño, cuatro textos y tres imágenes, con vista
previa en vivo. Lo guardado se aplica en la siguiente carga del chat sin que el negocio cambie su
fragmento, nunca deja el texto ilegible ni quita el aviso de asistente automático, el enlace de
privacidad o la salida a una persona, y viaja en la exportación de la configuración.

Enfoque técnico: un módulo de dominio nuevo `src/webchat/design` y ganchos pequeños en el canal web,
el panel y la exportación.

1. **Datos** — `chat_design` (fila única; sin fila = aspecto original) y `chat_design_image` (una
   fila por hueco, `bytea`, en cascada), con opciones como `text` y lectura tolerante campo a campo
   (R1, R13).
2. **Tema** — función pura que, a partir del diseño, da los tokens CSS que difieren del original,
   los atributos de `<html>` y los textos con sus valores por defecto. Contraste WCAG 2.x en el
   servidor; los colores derivados (atenuado, borde del campo, foco) se calculan mezclando el texto
   hacia el fondo y siempre cumplen 4,5:1 y 3:1. La paleta original no se deriva (R3–R5).
3. **Chat** — el frame (`no-store`) lee el diseño en cada petición; `/chat/design.css` sirve solo
   propiedades personalizadas; `frame.css` pasa sus valores fijos a `var(--…, <valor de hoy>)`; las
   imágenes se sirven por huella con caché inmutable, tipo real, `nosniff` y `sandbox`. El
   fragmento recibe tamaño y posición **por nombre** en el mensaje `chat:resize` que ya existe
   (R2, R6, R10).
4. **Imágenes** — validación por contenido en TypeScript puro (PNG con CRC, JPEG por segmentos, WebP
   por bloques), ≤ 256 KB, 16–1024 px, sin metadatos y sin recodificar; la misma función para el
   panel y la importación (R7).
5. **Panel** — `/admin/chat-design` con un único guardado multipart todo o nada en su propio
   contexto (como la importación de la 008), contraste en vivo con htmx y vista previa en dos
   iframes del mismo origen que pintan las mismas parciales que el frame; el script del panel
   aplica colores, textos, imágenes elegidas (`blob:`) y tamaño sin recargar (R8, R9).
6. **Exportación** — `formatVersion` 1 → 2 con actualizador; sección `chatDesign` con imágenes en
   base64, validada con las mismas reglas, reemplazada como el resto y mostrada en la vista previa
   de la importación (R11).

Detalle de decisiones en [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.x (strict) sobre Node.js 22 LTS (heredado)

**Primary Dependencies**: las existentes — Fastify 5, `@fastify/multipart` (ya usado en la 008),
Eta + htmx (panel), Drizzle ORM + drizzle-kit, `pg`, Zod. **Sin dependencias nuevas**: el contraste,
la derivación y la validación de imágenes son código propio y puro (R4, R7).

**Storage**: PostgreSQL 16, una BD por instancia. Migración de solo añadir `0007_chat_design.sql`:
tablas `chat_design` y `chat_design_image` ([data-model.md](data-model.md) §1). Es configuración del
negocio: **sube `formatVersion` a 2** con su actualizador y entra en el test de cobertura de
columnas. Entra sola en las copias de la 006.

**Testing**: Vitest —
`unit` (`contrast` en los bordes 4,4999/4,5 y 3:1; propiedad "toda paleta guardable da derivados que
cumplen" con semilla fija; tokens solo de la lista cerrada y la paleta original sin tokens; tablas
de forma y tamaño; validación de imágenes con `tests/fixtures/images/` —válidas, SVG/HTML
renombrados, vacía, truncada, CRC roto, dimensiones fuera de rango, con metadatos, animadas— e
idempotencia de quitar metadatos; esquema de textos y opciones; lectura tolerante; actualizador
1 → 2, esquema `chatDesign`, diferencias y recuentos; cobertura de columnas),
`contract` (`fastify.inject`: frame sin diseño **idéntico** al de la 004 frente a una copia en
`tests/fixtures/`; frame con diseño —atributos, hoja, textos escapados, elementos obligatorios con
los valores extremos, no disponible—; `design.css`, imágenes y sus cabeceras, 404 por huella
antigua; sección del panel con sesión y CSRF, guardado multipart, 422 con errores por campo y por
imagen (también `truncated`), contraste en vivo, vista previa y sus cabeceras, restauración;
exportación con `chatDesign` e importación v1 y v2),
`integration` (Testcontainers: guardado todo o nada con imágenes, sustituir/quitar/conservar por
hueco, restaurar en cascada, último guardado gana; ida y vuelta de la exportación e importación con
imágenes sin cambios al reimportar; configuración anterior que restaura el diseño; la importación no
cambia la activación; copia de seguridad y restauración con diseño).
Sin `eval` nuevo: el prompt y las respuestas del bot no cambian. El aspecto (nada tapado en
escritorio y móvil, vista previa igual al chat) se verifica con la lista manual de
[quickstart.md](quickstart.md) (R15).

**Target Platform**: servidor Linux (contenedor `node:22-slim`); chat en navegadores actuales de
escritorio y móvil (Chrome, Firefox, Safari).

**Project Type**: servicio web (monolito modular): módulo nuevo `src/webchat/design`; cambios en
`src/channels/web`, `src/admin`, `src/config-transfer`, `src/db` y `src/app.ts`.

**Performance Goals**: el frame añade dos lecturas pequeñas (fila del diseño y metadatos de las
imágenes, sin `bytes`) y `design.css` otra; < 5 ms en local. Imágenes con caché inmutable: tras la
primera visita no se vuelven a pedir. SC-009 (botón en < 2 s en el 95 % de las cargas) se cumple con
holgura: el botón depende del frame y de dos hojas pequeñas; el icono pesa ≤ 256 KB. Vista previa:
cada cambio se ve en < 1 s (150 ms de espera + una hoja calculada en el servidor) (SC-002).

**Constraints**: CSP del frame sin cambios (`style-src 'self'`, `img-src 'self' data:`); sin CSS ni
HTML del operador en ninguna parte; sin cookies ni peticiones a terceros desde el chat (FR-041); en
memoria nunca más de 256 KB por fichero subido; nada de lo que la spec no menciona cambia en el
chat web (FR-043); `src/` sin nombres ni reglas de ningún sector (la conversación de ejemplo de la
vista previa es genérica).

**Scale/Scope**: un diseño por instancia; tres imágenes de ≤ 256 KB; una sección del panel, cuatro
rutas públicas tocadas (`frame`, `design.css`, imágenes, `widget.js`) y una sección del fichero de
configuración.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Cómo se cumple | Estado |
|---|---|---|
| I. Base común única | Spec de núcleo. Valores por defecto = los del chat de la 004; textos y conversación de ejemplo genéricos; ningún nombre de sector o cliente en `src/` (los ejemplos con marcas, solo en `tests/fixtures/`). | ✅ |
| II. Configuración antes que código | El aspecto pasa de código fijo a configuración que el operador cambia sin despliegue; las opciones son genéricas y válidas para cualquier sector. | ✅ |
| III. Personalizaciones aisladas | No es una extensión; no añade puntos de extensión. Cada instancia guarda su diseño en su BD; ninguna afecta a otra. | ✅ |
| IV. Solo información registrada | La cadena de respuesta, el prompt y el snapshot no cambian. Bienvenida y nombre son texto de la interfaz: no se guardan como mensajes ni los usa el bot (FR-007, R14); el panel recuerda al operador que no lleven datos del negocio. | ✅ |
| V. Siempre hay salida a una persona | El diseño no oculta el contacto de derivación, la franja de derivación ni el mensaje de no disponible (FR-022); sus colores derivados garantizan su contraste (R4). Tests de contrato con valores extremos comprueban que siguen presentes; las pruebas existentes de la 004, 005 y 010 siguen en la suite. | ✅ |
| VI. El operador registra la información | La sección está en el panel, con sesión del operador y CSRF; el negocio no tiene ningún mecanismo para cambiarla. | ✅ |
| Restricciones: canales | Solo cambia el aspecto del canal web; la cadena de respuesta es la misma para todos los canales. | ✅ |
| Restricciones: aislamiento | Una BD por instancia; las imágenes se sirven solo desde su instancia. | ✅ |
| Flujo: pruebas de IV y V | La feature afecta a la interfaz de la conversación: se añaden tests de contrato de presencia del aviso, privacidad, contacto y franja de derivación con cualquier diseño (US2-4, US2-6, US2-7). | ✅ |

**Convenciones de CLAUDE.md**:
- *Dominio sin HTTP*: `src/webchat/design/*` no importa Fastify; las rutas viven en
  `src/channels/web` y `src/admin`. ✅
- *Avisos y escrituras protegidas*: el diseño no es información del negocio que lea el bot ni entra
  en `computeWarnings`, así que su guardado es una transacción propia, como `saveWebChatSettings`;
  en la importación va dentro de la escritura protegida existente de la 008. ✅
- *Migraciones de solo añadir* y *`formatVersion` + actualizador* para configuración nueva: `0007`
  nueva y formato 2. ✅
- *Tocar el código existente solo donde es imprescindible* (spec): los cambios en ficheros
  existentes se limitan a lo enumerado en la estructura de abajo; las parciales del frame se
  extraen solo para que la vista previa pinte exactamente lo mismo (R9). ✅

Sin desviaciones: no hace falta Complexity Tracking.

**Re-evaluación tras el diseño (Phase 1)**: sin cambios. El diseño no añade lógica de sector, no toca
la cadena de respuesta, no cambia la CSP del frame ni las garantías de la 004 y deja intactos la
activación y los topes. ✅

## Project Structure

### Documentation (this feature)

```text
specs/011-chat-design/
├── plan.md              # Este fichero
├── research.md          # Phase 0: decisiones R1–R15
├── data-model.md        # Phase 1: tablas, tipos, reglas, tokens, estados, formato
├── quickstart.md        # Phase 1: validación de punta a punta
├── contracts/
│   ├── admin-chat-design.md        # sección del panel, vista previa, restaurar
│   ├── chat-design-http.md         # frame, design.css, imágenes, widget.js
│   └── config-file-chat-design.md  # sección chatDesign del formato v2
└── tasks.md             # Phase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
src/
├── webchat/design/                 # NUEVO — dominio, sin HTTP
│   ├── defaults.ts                 # ORIGINAL_DESIGN, textos por defecto
│   ├── schemas.ts                  # Zod: opciones, textos, formulario y fichero (R14)
│   ├── contrast.ts                 # luminancia, razón WCAG, parejas (R4)
│   ├── theme.ts                    # tokens, derivados, atributos, tablas de forma/tamaño (R3–R5)
│   ├── css.ts                      # ResolvedChatDesign → texto de design.css
│   ├── images.ts                   # detección PNG/JPEG/WebP, límites, quitar metadatos (R7)
│   └── store.ts                    # readChatDesign (tolerante), saveChatDesign, resetChatDesign
├── channels/web/
│   ├── routes.ts                   # + /design.css, /design/:slot/:file; el frame lee el diseño
│   ├── views/frame.eta             # usa las parciales; atributos, hoja, imágenes, textos
│   ├── views/partials/             # NUEVO — toggle, cabecera, aviso, lista, composer (compartidas con la vista previa)
│   └── assets/
│       ├── frame.css               # valores fijos → var(--…, <hoy>); reglas [data-*]
│       ├── frame.js                # size/position en chat:resize; imagen que falla → original
│       └── widget.js               # tabla de tamaños y posición por nombre
├── admin/
│   ├── routes/chat-design.ts       # NUEVO — página, guardar (multipart), check, preview, reset
│   ├── routes/index.ts             # registra la sección
│   ├── views/chat-design.eta       # NUEVO
│   ├── views/chat-design/reset.eta # NUEVO — confirmación sin JavaScript
│   ├── views/chat-design/preview.eta  # NUEVO — usa las parciales del frame
│   ├── views/partials/contrast-issues.eta  # NUEVO
│   ├── views/chat-design.js        # NUEVO — vista previa en vivo (servido en /assets/chat-design.js)
│   ├── views/app.css               # estilos de la sección y de la vista previa
│   └── views/layout.eta            # entrada "Diseño del chat" en la navegación
├── config-transfer/
│   ├── format.ts                   # versión 2, UPDATERS[1], ConfigChatDesign, secciones, cobertura
│   ├── schema.ts                   # chatDesign en configFileSchema
│   ├── read.ts                     # chatDesign en el documento
│   ├── replace.ts                  # replaceChatDesign
│   ├── diff.ts                     # chatDesignDiff
│   └── log.ts                      # recuentos de chatDesign
├── db/
│   ├── schema.ts                   # chatDesign, chatDesignImage
│   └── migrations/0007_chat_design.sql (+ meta)
└── app.ts                          # /assets/chat-design.js; excepción de cabeceras de la vista previa

tests/
├── unit/webchat/design/            # contrast, theme, css, images, schemas, store (lectura tolerante)
├── unit/config-transfer/           # actualizador 1→2, esquema, diff, cobertura (CONFIG_TABLES)
├── contract/web-chat-design.test.ts      # frame sin/con diseño, design.css, imágenes, widget
├── contract/admin/chat-design.test.ts    # panel, guardado, check, preview, reset
├── contract/admin/config-import.test.ts  # (amplía) v1 y v2 con chatDesign
├── integration/chat-design/        # guardado todo o nada, restaurar, concurrencia
├── integration/config-transfer/    # (amplía) ida y vuelta, copia anterior con diseño
├── integration/backup/             # (amplía) copia y restauración con diseño
└── fixtures/
    ├── images/                     # PNG/JPEG/WebP válidos e inválidos, animados, con metadatos
    └── web-chat/frame-004.html     # HTML del frame sin diseño, para la no regresión
```

**Structure Decision**: monolito modular existente. El dominio del diseño va en `src/webchat/design`
(junto a la configuración del chat web, sin HTTP); el canal web solo lee y sirve; el panel compone
formulario, vista previa y guardado; la exportación añade una sección con el mecanismo de versiones
de la 008. Los ficheros existentes se tocan solo en los puntos listados.

## Complexity Tracking

No aplica: el Constitution Check no tiene desviaciones.
