# Research: Claridad del panel del operador y enlace a mapa

**Feature**: `003-admin-panel-clarity` | **Fecha**: 2026-09-28 | **Spec**: [spec.md](spec.md)

No quedaba ningún `NEEDS CLARIFICATION` en el contexto técnico: el stack es el de las features
001, 002 y 004. Estas son las decisiones de diseño que la spec deja abiertas.

## R1. Rama y punto de partida

- **Decisión**: la 003 se implementa sobre la rama `004-web-channel` (donde ya se aclaró la
  spec), no sobre `003-admin-panel-clarity`.
- **Motivo**: la rama `003-admin-panel-clarity` se quedó en el último commit de la 002; la 004
  ha seguido encima y contiene todo el código que esta feature toca (panel, snapshot, prompt,
  "Probar el bot"). Partir de la rama 003 obligaría a reimplementar sobre código antiguo y a
  resolver conflictos con la 004.
- **Consecuencia**: la suposición de la spec "la spec 002 todavía no está implementada" ya no
  es cierta. Ver R9.
- **Alternativas**: rebasar la rama 003 sobre la 004 (mismo resultado, más pasos); trabajar en
  la rama 003 antigua (descartado por lo anterior).

## R2. Quitar un medio de derivación sin JavaScript (FR-001, FR-004, SC-002)

- **Decisión**: cada fila de medio lleva una casilla **"Quitar"** (`channels[i].remove`). Al
  guardar, las filas marcadas no se guardan. Una regla CSS con `:has(input:checked)` atenúa y
  tacha la fila marcada, así que el operador ve el efecto antes de guardar, sin JavaScript.
- **Motivo**: funciona igual con y sin JavaScript, son exactamente 2 acciones (marcar y
  guardar, SC-002) y "quitar solo tiene efecto al guardar" (US1-4) es el comportamiento
  natural: recargar descarta la marca.
- **Dónde se filtra**: en `handoffSchema`, que ya acepta la forma del formulario (como
  `checkbox` en `schemas/common.ts`). La fila marcada se descarta **antes** de validar su
  valor, así se puede quitar un medio mal escrito, y los índices de los errores siguen
  coincidiendo con los del formulario (si se filtrara en la ruta, los errores de Zod
  apuntarían a otra fila).
- **Alternativas**:
  - Botón que borra la fila del DOM: necesita JavaScript (incumple FR-004) o una segunda vía.
  - `POST /admin/handoff/channels/:i/delete` que guarda al momento: el contacto se modificaría
    sin pulsar "Guardar" y rompería la atomicidad del formulario (medios + horario).

## R3. Formulario tras un rechazo por FR-032 (FR-003)

- **Decisión**: en `POST /admin/handoff`, si el error es `409` (aviso crítico con el negocio
  activo) el formulario se vuelve a pintar con los **medios guardados** (`handoffValues(state)`)
  y sin marcas de quitar. Si es `422` (dato inválido) se mantienen los valores y las marcas del
  operador, como hasta ahora.
- **Motivo**: con `409` no se ha guardado nada y el operador tiene que ver que los medios
  siguen ahí (caso límite de la spec). Con `422` lo útil es corregir el campo sin volver a
  escribir el resto.
- **Alcance**: solo Derivación. En Datos el `409` al borrar el teléfono ya muestra el error
  general y el aviso; la spec no pide cambiarlo.

## R4. "Contacto que usa el bot": cálculo y comparación (FR-005, FR-006)

- **Decisión**: se reutiliza `effectiveHandoff(state)` (FR-019 de la 001), que ya devuelve
  `source` y `channels`. Se añaden al dominio (`src/knowledge/handoff.ts`):
  - `sameContact(a, b)`: igualdad por `source` y por la lista ordenada de `(type, value)`.
    El horario de atención **no** forma parte del contacto (cambiarlo no dispara el mensaje).
  - `describeHandoffChange(before, after, touched, status)`: devuelve un
    `HandoffChange` ([data-model](data-model.md#handoffchange-derivado-no-se-guarda)).
- **Captura del antes y el después**: `runGuardedWrite` gana una variante
  `runTrackedWrite(db, fn)` que carga el estado justo después del bloqueo (antes de `fn`) y
  devuelve también el estado que ya carga para calcular los avisos. Así el "antes" y el
  "después" salen de la misma transacción serializada y no hay carreras con otro guardado.
- **Alternativas**: leer el estado en la ruta antes de llamar al servicio (carrera entre la
  lectura y el guardado); guardar el contacto efectivo en la BD (contradice "los avisos y
  derivados se calculan, no se guardan").

## R5. Cuándo se modifica "el teléfono o los medios" (FR-006 caso b)

- **Decisión**: se compara lo **guardado**, no lo enviado:
  - Datos: `touched` si el teléfono en E.164 cambia (incluido pasar a vacío o desde vacío).
  - Derivación: `touched` si cambia la lista ordenada de medios guardados.
- **Caso límite "quitar todos con el formulario inicial vacío"**: no cambia nada guardado, así
  que el mensaje es solo "Guardado"; el origen actual lo sigue indicando el recuadro fijo de
  la pantalla (FR-005). Es la lectura coherente con FR-006, que prohíbe añadir el mensaje
  cuando no se tocan ni el teléfono ni los medios.

## R6. Texto de los mensajes y flash (FR-006, FR-007, SC-003)

- **Decisión**: el texto se compone en el panel (`src/admin/handoff-notice.ts`), a partir del
  `HandoffChange` que devuelve el dominio. El dominio no produce frases de interfaz.
  `submitForm` acepta `message` como texto o como función del resultado del guardado, y el
  mensaje va en el flash de la sesión como el "Guardado" actual.
- **Motivo**: el flash ya se muestra igual con htmx (`HX-Location` + recarga) y sin JavaScript
  (`303` + recarga), que es lo que exige el caso límite "mensaje de contacto sin JavaScript".
- Catálogo de mensajes: [contracts/admin-panel.md](contracts/admin-panel.md#mensajes-del-contacto-que-usa-el-bot).

## R7. Validación de "Enlace a mapa" (FR-011, FR-012, FR-015)

- **Decisión**: nuevo esquema `optionalHttpsUrl(500)` en `schemas/common.ts`. Vacío → `null`.
  Si no, en este orden:
  1. Más de 500 caracteres → "Máximo 500 caracteres".
  2. Contiene espacios → "Enlace no válido: copia el enlace completo, empezando por https://".
  3. No contiene `://` → "Escribe el enlace completo, empezando por https://".
  4. Empieza por `http://` (sin distinguir mayúsculas) → "Usa el enlace seguro, que empieza
     por https://". No se convierte.
  5. `new URL()` falla, el protocolo no es `https:`, el host no tiene un punto o lleva usuario
     y contraseña → "Enlace no válido: copia el enlace completo, empezando por https://".
- Se guarda el texto recortado tal como lo pegó el operador (no `URL.href`, que recodifica
  caracteres y cambiaría lo que ve el operador y lo que copia el bot).
- Sin lista de proveedores (FR-012) ni comprobación de que exista (suposición de la spec).
- **BD**: columna `business.map_url text` nula, migración `0003` generada con drizzle-kit. Sin
  `CHECK`: la validación vive solo en los esquemas Zod del dominio (CLAUDE.md), igual que la
  longitud de `address` o `directions`.
- Ningún aviso nuevo (FR-015): `computeWarnings` no cambia.

## R8. Abrir el enlace desde el panel (FR-013)

- **Decisión**: junto al campo, si hay un enlace **guardado** (`state.business.mapUrl`, no el
  valor del formulario), un enlace "Abrir en una pestaña nueva" con `target="_blank"` y
  `rel="noopener noreferrer"`.
- **Motivo**: tras un `422` el valor del formulario no está validado; usar el guardado evita
  pintar como `href` un texto arbitrario (por ejemplo `javascript:`). Eta escapa el valor.

## R9. El bot y el enlace a mapa (FR-014; suposición sobre la 002)

La 002 ya está implementada (R1), así que esta feature tiene que dejar el enlace utilizable:

- **Snapshot**: `business.mapUrl: string | null` junto a `address` y `directions`. Lo recibe
  `buildSnapshot`, `pnpm kb:snapshot` y "Probar el bot" sin cambios adicionales. Sin caché
  (FR-021 de la 001), así que SC-005 se cumple por construcción.
- **Verificador de cifras**: `buildAllowedFacts` ya extrae de todos los textos del snapshot,
  así que la URL guardada pasa a estar permitida automáticamente. Hay que probarlo con enlaces
  reales de mapas (con `@`, `,`, `+`, `!` y `?`): el extractor corta en `)` y `"`, pero lo hace
  igual en el snapshot y en la respuesta, así que la comparación sigue coincidiendo.
- **Prompt**: hoy la regla general dice "No escribas datos de contacto (teléfonos, correos,
  enlaces) salvo la dirección del negocio", así que el modelo **no** daría el enlace. Se
  cambia a "salvo la dirección del negocio y su enlace a mapa (`business.mapUrl`)" y se añade
  una regla de ubicación: dirección, indicaciones y, si existe, el enlace copiado tal cual.
- **Documentación de la 002**: se actualizan el escenario 4 de la US1 de su spec y
  `contracts/chat-model.md`, como pide la suposición de esta spec.
- **Evaluación**: un caso nuevo en `tests/eval` con el modelo real (fuera de `pnpm test`).
- **Fuera de alcance**: en el chat web el texto se pinta con `textContent`, así que el enlace
  aparece como texto, no como enlace pulsable. Convertir URLs en enlaces en el chat web es
  otra decisión de seguridad y queda para una spec aparte.

## R10. Resúmenes de la portada (FR-009, SC-004)

- **Decisión**: función pura `sectionSummaries(state)` en `src/admin/section-summaries.ts`, con
  los datos que ya carga la portada (suposición de la spec). Reglas en
  [data-model](data-model.md#resumen-de-sección-derivado-no-se-guarda).
- Políticas con fila guardada pero todo vacío cuenta como "Sin configurar": para el operador
  es lo mismo.

## R11. Textos explicativos y ejemplo de "Cómo llegar" (FR-008, FR-010)

- **Decisión**: párrafos `hint` fijos en las vistas. El ejemplo de "Cómo llegar" es genérico:
  referencias cercanas, transporte público y aparcamiento, sin nombres de sector (el test de
  neutralidad prohíbe, entre otras, "taller" y "clínica" en `src/`).
- Textos exactos en [contracts/admin-panel.md](contracts/admin-panel.md#textos-fijos).

## R12. Documentación (FR-016, US5)

- La guía de la 001 (`specs/001-business-knowledge-base/quickstart.md`): el paso 6-2 pasa a
  "marca **Quitar** en cada medio y guarda", con el mensaje esperado, y se añade un escenario
  que remite a los pasos de esta feature ([quickstart.md](quickstart.md)).
- Contratos de la 001 que cambian: `admin-panel.md` (campo `map_url`, `channels[i].remove`) y
  `knowledge-reader.md` (`business.mapUrl`).
- `README.md`: se actualiza el estado de la feature, avisando antes al usuario (CLAUDE.md).
