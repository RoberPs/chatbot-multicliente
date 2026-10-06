---

description: "Lista de tareas de la feature 003: claridad del panel del operador y enlace a mapa"
---

# Tasks: Claridad del panel del operador y enlace a mapa

**Input**: documentos de diseño de `/specs/003-admin-panel-clarity/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Ámbito**: núcleo. Se implementa sobre la rama `004-web-channel` ([research R1](research.md#r1-rama-y-punto-de-partida)).

**Tests**: se incluyen. El plan los enumera y la constitución exige pruebas de los Principios IV
(verificador con el enlace guardado y con uno inventado) y V (FR-032 al quitar el último medio).
Dentro de cada historia, los tests se escriben primero y deben fallar antes de implementar.

**Organización**: por historia de usuario, para implementarlas y probarlas por separado.

## Formato: `[ID] [P?] [Story] Descripción`

- **[P]**: se puede hacer en paralelo (ficheros distintos, sin dependencias pendientes)
- **[Story]**: historia a la que pertenece (US1 … US5)

## Reglas que aplican a todas las tareas

- Nada de nombres ni lógica de sector o cliente en `src/` (Principio I); solo en `tests/fixtures/`.
- El dominio (`src/knowledge`) no depende de HTTP ni produce frases de interfaz; los textos
  para el operador viven en `src/admin`.
- Todo guardado pasa por `runGuardedWrite` (o su variante `runTrackedWrite`): aplicar →
  recalcular avisos → revertir si un negocio activo queda con aviso crítico (FR-032).
- Los derivados (contacto del bot, `HandoffChange`, resúmenes) se calculan en cada petición;
  nunca se guardan. `getSnapshot()` sigue sin caché.
- Todo funciona sin JavaScript. Textos, comentarios y mensajes en español; los textos exactos
  están en [contracts/admin-panel.md](contracts/admin-panel.md).

---

## Phase 1: Setup

**Purpose**: partir de una base verde en la rama correcta.

- [X] T001 Comprobar que se trabaja en la rama `004-web-channel` y que `pnpm lint`, `pnpm typecheck` y `pnpm test` pasan antes de tocar nada (anotar cualquier fallo previo para no confundirlo con regresiones de esta feature)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: piezas compartidas por varias historias.

- [X] T002 Añadir a `src/admin/views/app.css` una clase de ayuda reutilizable para los textos explicativos (`.hint`, si no existe ya) y el estilo del recuadro `.handoff-effective` que usarán US2 y US3; sin JavaScript

**Checkpoint**: la base está lista. US1, US3 y US4 pueden empezar en paralelo; US2 comparte
`src/admin/routes/handoff.ts` y `src/admin/views/handoff.eta` con US1 y US3 (ver dependencias).

---

## Phase 3: User Story 1 - Quitar medios del contacto de derivación (Priority: P1) 🎯 MVP

**Goal**: cada medio guardado tiene una casilla "Quitar"; al guardar, las filas marcadas se
descartan sin validarse. Quitar todos aplica FR-019 (teléfono del negocio) y sigue protegido
por FR-032 ([research R2, R3](research.md#r2-quitar-un-medio-de-derivación-sin-javascript-fr-001-fr-004-sc-002)).

**Independent Test**: registrar dos medios, marcar "Quitar" en uno y guardar → `pnpm kb:snapshot`
muestra un único medio en `handoff.channels`. Quitar todos → el bot usa el teléfono del negocio.
Con el negocio activo, sin teléfono y un solo medio → `409` y el medio sigue guardado.

### Tests for User Story 1 ⚠️

- [X] T003 [P] [US1] Crear `tests/unit/schemas/handoff.test.ts` con los casos de `channels[i].remove` en `handoffSchema`: fila marcada se descarta aunque su valor sea inválido (`abc`); los errores de las filas no marcadas conservan su índice original (`channels.2.value` sigue siendo el 2); el orden de los medios restantes se mantiene; marcar todas → `channels: []`; un medio repetido con la copia marcada no da error de repetido
- [X] T004 [P] [US1] Crear `tests/contract/admin/handoff.test.ts` (con `fastify.inject`, siguiendo `tests/contract/admin/settings.test.ts`): el `GET /admin/handoff` pinta la casilla `channels[i].remove` con el texto "Quitar" solo en las filas guardadas, no en la fila vacía de reserva; `GET /admin/partials/channel-row` no la incluye; `POST` con una fila marcada → `303` y el medio desaparece del snapshot; `POST` con `422` en otra fila → se vuelven a pintar los valores y la casilla marcada; `POST` que provoca `409` → se pintan los medios guardados, sin casillas marcadas, con el error general y el aviso que lo provoca (FR-003)
- [X] T005 [P] [US1] Ampliar `tests/integration/handoff-protection.test.ts` (Testcontainers): negocio activo sin teléfono y con un único medio → enviar la fila marcada para quitar lanza `CriticalWarningError` y el medio sigue en la BD; con teléfono del negocio registrado → se guarda y `effectiveHandoff(state).source === 'business_phone'`

### Implementation for User Story 1

- [X] T006 [US1] En `src/knowledge/schemas/handoff.ts`, aceptar `remove` en cada fila de `channels` usando el `checkbox` de `src/knowledge/schemas/common.ts` y, en el `transform`, saltar las filas con `remove === true` antes de validar su valor, manteniendo `i` como el índice original para los `path` de los errores (hace pasar T003)
- [X] T007 [US1] En `src/admin/views/partials/channel-row.eta`, añadir la clase `channel-row` al `div` y, solo si `it.removable` es verdadero, la casilla `<label class="checkbox remove"><input type="checkbox" name="channels[i].remove"> Quitar</label>` marcada cuando `it.remove` sea verdadero (forma exacta en [contracts/admin-panel.md](contracts/admin-panel.md#fila-de-medio))
- [X] T008 [US1] En `src/admin/views/handoff.eta`, pasar `removable: true` y `remove: c.remove` a las filas de medios existentes y `removable: false` a la fila vacía de reserva; comprobar que `src/admin/routes/partials.ts` (ruta `channel-row` de "Añadir medio") no pasa `removable`
- [X] T009 [US1] En `src/admin/routes/handoff.ts`, conservar `remove` en los valores leídos del formulario (revisar que `compactRows(form.channels, ['value'])` no lo pierde) y, en `onError`, si `error.status === 409` volver a pintar con `handoffValues(state)` del estado recién leído (medios guardados, sin marcas); con `422` mantener los valores y marcas del operador (R3; hace pasar T004 y T005)
- [X] T010 [P] [US1] En `src/admin/views/app.css`, añadir la regla `.channel-row:has(.remove input:checked)` que atenúa la fila y tacha el valor, sin JavaScript

**Checkpoint**: US1 funciona y se prueba sola (quickstart, escenarios 2 y 3).

---

## Phase 4: User Story 2 - Saber a quién pasará el bot la conversación (Priority: P1)

**Goal**: Datos y Derivación muestran el recuadro "Contacto que usa el bot" y, al guardar, el
flash explica el contacto cuando cambia o cuando se toca el teléfono o los medios (FR-005 –
FR-007; [research R4 – R6](research.md#r4-contacto-que-usa-el-bot-cálculo-y-comparación-fr-005-fr-006)).

**Independent Test**: con un contacto de derivación configurado, borrar el teléfono en Datos y
guardar → el flash dice que el teléfono no se usa y el bot sigue con el contacto configurado.
Cambiar solo el nombre → solo "Guardado". Quitar el contacto → el flash dice que el bot usa el
teléfono del negocio. Igual con y sin la cabecera `HX-Request`.

### Tests for User Story 2 ⚠️

- [X] T011 [P] [US2] Crear `tests/unit/knowledge/handoff-change.test.ts`: `sameContact` es verdadero con mismos `source` y lista ordenada de `(type, value)` aunque cambie `hours`, y falso si cambia el orden, un valor o el `source`; `describeHandoffChange(before, after, touched, status)` devuelve el `HandoffChange` de [data-model](data-model.md#handoffchange-derivado-no-se-guarda)
- [X] T012 [P] [US2] Crear `tests/unit/admin/handoff-notice.test.ts`: un caso por cada fila de la tabla "Mensajes del contacto que usa el bot" y por cada fila del recuadro de [contracts/admin-panel.md](contracts/admin-panel.md#recuadro-contacto-que-usa-el-bot-fr-005), incluido `none` en preparación (FR-007) y el formato `Teléfono +34…`, `WhatsApp +34…`, `Email …` con los medios en orden
- [X] T013 [P] [US2] Ampliar `tests/integration/guarded-write.test.ts` con `runTrackedWrite`: devuelve `before` y `after` coherentes con lo guardado, el resultado de `fn`, y sigue revirtiendo con `CriticalWarningError` cuando el negocio activo queda con un aviso crítico
- [X] T014 [P] [US2] Ampliar `tests/contract/admin/business.test.ts`: el `GET /admin/business` muestra el recuadro con los tres orígenes; tras `POST` el flash de la página siguiente es: borrar el teléfono con contacto configurado → caso (b) de Datos; cambiar el teléfono sin contacto configurado → caso (a) `business_phone` con el nuevo número (US2-2); cambiar solo el nombre → `Guardado`; los mismos resultados con `HX-Request: true` (`200` + `HX-Location`)
- [X] T015 [P] [US2] Ampliar `tests/contract/admin/handoff.test.ts` (creado en T004): el `GET /admin/handoff` muestra el recuadro; añadir medios → caso (a) `configured`; vaciar todos con teléfono → caso (a) `business_phone`; vaciar todos en preparación sin teléfono → caso (a) `none` (US2-3); guardar sin medios cuando ya no había contacto → solo `Guardado` (R5); cambiar solo el horario → solo `Guardado`

### Implementation for User Story 2

- [X] T016 [US2] En `src/knowledge/types.ts`, añadir la interfaz `HandoffChange` (`before`, `after`, `touched`, `status`) con los comentarios de [data-model](data-model.md#handoffchange-derivado-no-se-guarda)
- [X] T017 [US2] En `src/knowledge/handoff.ts`, añadir `sameContact(a, b)` (sin `hours`) y `describeHandoffChange(before, after, touched, status)` (hace pasar T011)
- [X] T018 [US2] En `src/knowledge/services/guarded-write.ts`, añadir `runTrackedWrite(db, fn)` que, tras `lockBusiness`, carga el estado antes de `fn`, reutiliza el estado que ya se carga para los avisos como "después" y devuelve `{ result, before, after }`; reutilizar la lógica de `runGuardedWrite` para no duplicar la comprobación de FR-032 ni `translateDbError` (hace pasar T013)
- [X] T019 [US2] En `src/knowledge/services/business-info.ts`, que `saveBusiness` use `runTrackedWrite` y devuelva un `HandoffChange` con `touched` = el teléfono E.164 guardado cambió (incluido desde o hacia vacío)
- [X] T020 [US2] En `src/knowledge/services/settings.ts`, que `saveHandoff` use `runTrackedWrite` y devuelva un `HandoffChange` con `touched` = cambió la lista ordenada de medios guardados (`state.handoff?.channels`, antes frente a después)
- [X] T021 [P] [US2] Crear `src/admin/handoff-notice.ts` con `effectiveHandoffNotice(effective)` (texto del recuadro) y `handoffChangeMessage(change)` (texto del flash), con los textos exactos del contrato (hace pasar T012)
- [X] T022 [US2] En `src/admin/render.ts`, que la opción `message` de `submitForm` acepte `string | ((result: T) => string)` y la resuelva con el resultado antes de llamar a `savedResponse`
- [X] T023 [P] [US2] Crear `src/admin/views/partials/handoff-effective.eta` con el recuadro "Contacto que usa el bot", que recibe el texto (o sus partes) calculado por `effectiveHandoffNotice`
- [X] T024 [US2] En `src/admin/routes/business.ts` y `src/admin/views/business.eta`, pasar `effectiveHandoff(state)` al renderizar e incluir el parcial `handoff-effective`; en el `POST`, `message: (change) => handoffChangeMessage(change)` (hace pasar T014)
- [X] T025 [US2] En `src/admin/routes/handoff.ts` y `src/admin/views/handoff.eta`, lo mismo que T024 para Derivación, sin perder el comportamiento de US1 (hace pasar T015)

**Checkpoint**: US1 y US2 funcionan juntas y por separado (quickstart, escenario 1).

---

## Phase 5: User Story 3 - Entender las pantallas de registro único (Priority: P2)

**Goal**: Políticas, Tono y Derivación explican que son registros únicos, y la portada muestra un
resumen de cada una (FR-008, FR-009; [research R10, R11](research.md#r10-resúmenes-de-la-portada-fr-009-sc-004)).

**Independent Test**: abrir cada pantalla y ver su texto fijo; en la portada, "Sin configurar"
con Políticas y Tono vacíos, y "3 formas de pago · sin política de cancelación" y "trato de
usted" tras guardarlos.

### Tests for User Story 3 ⚠️

- [X] T026 [P] [US3] Crear `tests/unit/admin/section-summaries.test.ts` con cada regla de la tabla "Resumen de sección" de [data-model](data-model.md#resumen-de-sección-derivado-no-se-guarda): singular y plural (`1 forma de pago`, `sin formas de pago`, `1 medio`), política con todos los campos vacíos → "Sin configurar", tono con y sin estilo propio, derivación `configured`, `business_phone` y `none`; construir el estado con `tests/helpers/state.ts`
- [X] T027 [P] [US3] Añadir pruebas de contrato: en `tests/contract/admin/settings.test.ts`, que `GET /admin/policies`, `GET /admin/tone` y `GET /admin/handoff` contienen su texto fijo de [contracts/admin-panel.md](contracts/admin-panel.md#textos-fijos); en un nuevo `tests/contract/admin/dashboard.test.ts`, que `GET /admin` muestra los resúmenes y que cambian tras guardar Políticas y Tono

### Implementation for User Story 3

- [X] T028 [P] [US3] Crear `src/admin/section-summaries.ts` con la función pura `sectionSummaries(state)` que devuelve `{ policies, tone, handoff }` usando `effectiveHandoff(state)` para Derivación (hace pasar T026)
- [X] T029 [US3] En `src/admin/routes/dashboard.ts` y `src/admin/views/dashboard.eta`, calcular `sectionSummaries(state)` en cada petición y pintarlo junto a Políticas, Tono y Contacto de derivación en "Secciones"
- [X] T030 [P] [US3] Añadir el texto fijo de registro único en `src/admin/views/policies.eta` y `src/admin/views/tone.eta`
- [X] T031 [US3] Añadir el texto fijo de Derivación (cómo añadir y quitar medios) en `src/admin/views/handoff.eta`; coordinar con T008 y T025, que tocan el mismo fichero (hace pasar T027)

**Checkpoint**: US3 funciona sola (quickstart, escenario 4).

---

## Phase 6: User Story 4 - Explicar cómo llegar y enlazar un mapa (Priority: P2)

**Goal**: campo opcional "Enlace a mapa" (`https://`, ≤ 500 caracteres) con ayuda en "Cómo
llegar"; el enlace llega al bot en `snapshot.business.mapUrl` y el prompt le deja copiarlo
(FR-010 – FR-015; [research R7 – R9](research.md#r7-validación-de-enlace-a-mapa-fr-011-fr-012-fr-015)).

**Independent Test**: guardar `https://maps.example.com/@40.41,-3.70,17z?q=Plaza+Mayor` →
aparece en `pnpm kb:snapshot` junto a `address` y `directions`; `maps.example.com/abc` y
`http://…` se rechazan con el error junto al campo; vaciarlo → `mapUrl: null` en la siguiente
consulta.

### Tests for User Story 4 ⚠️

- [X] T032 [P] [US4] Ampliar `tests/unit/schemas/common.test.ts` con `optionalHttpsUrl(500)`, en el orden de reglas de R7: vacío → `null`; 501 caracteres → "Máximo 500 caracteres"; con espacios; sin `://`; `http://` y `HTTP://` → mensaje del enlace seguro; `https://localhost/x`, `https://user:pass@example.com` y `ftp://…` → no válido; enlace con `@`, `,`, `+`, `!` y `?` → se acepta y se devuelve recortado, sin recodificar
- [X] T033 [P] [US4] Ampliar `tests/unit/schemas/business.test.ts` con `map_url`: válido, vacío → `null`, inválido → error en el campo `map_url`
- [X] T034 [P] [US4] Ampliar `tests/unit/snapshot/business-services.test.ts`: `business.mapUrl` es el enlace guardado o `null`; ampliar `tests/unit/warnings/catalog.test.ts` para comprobar que sin enlace (con o sin dirección) no aparece ningún aviso nuevo (FR-015)
- [X] T035 [P] [US4] Ampliar `tests/contract/snapshot-shape.test.ts` (objeto estricto) con `business.mapUrl`
- [X] T036 [P] [US4] Ampliar `tests/unit/conversation/grounding.test.ts` (y `tests/unit/conversation/facts.test.ts` si la extracción se prueba ahí): una respuesta que copia el `mapUrl` guardado con `@`, `,`, `+`, `!` y `?` pasa el verificador; una con otro enlace de mapas se rechaza (Principio IV)
- [X] T037 [P] [US4] Ampliar `tests/unit/llm/prompt.test.ts`: la regla general admite la dirección y `DATOS_DEL_NEGOCIO.business.mapUrl`, y existe la regla de ubicación de [contracts/knowledge-reader.md](contracts/knowledge-reader.md#prompt-del-modelo-002)
- [X] T038 [P] [US4] Ampliar `tests/contract/admin/business.test.ts`: `POST` con `map_url` inválido → `422`, error junto al campo, nada guardado y el resto de campos conserva lo escrito; válido → `303`; con enlace guardado el `GET` muestra "Abrir en una pestaña nueva" con `target="_blank"` y `rel="noopener noreferrer"`; tras un `422` el `href` sigue siendo el enlace guardado, no el valor enviado (R8); el campo "Cómo llegar" muestra su ayuda y ejemplo
- [X] T039 [P] [US4] Ampliar `tests/integration/freshness.test.ts`: guardar, cambiar y vaciar `map_url` se refleja en el siguiente `getSnapshot()` sin reiniciar (SC-005)

### Implementation for User Story 4

- [X] T040 [US4] En `src/db/schema.ts`, añadir `mapUrl: text('map_url')` (nula) a la tabla `business` y generar la migración con `pnpm db:generate`, que debe quedar como `src/db/migrations/0003_*.sql` con solo `ALTER TABLE "business" ADD COLUMN "map_url" text;` (revisar también `src/db/migrations/meta/`)
- [X] T041 [US4] En `src/knowledge/types.ts`, añadir `mapUrl: string | null` a `BusinessRecord` y a `KnowledgeSnapshot.business` (junto a `address` y `directions`); actualizar `tests/helpers/state.ts` y `tests/helpers/snapshot.ts` para que construyan estados con `mapUrl: null` por defecto
- [X] T042 [P] [US4] En `src/knowledge/schemas/common.ts`, añadir `optionalHttpsUrl(max)` con las reglas y mensajes de R7 (hace pasar T032)
- [X] T043 [US4] En `src/knowledge/schemas/business.ts`, añadir `map_url: optionalHttpsUrl(500)`, y en `src/knowledge/repositories/business.ts` guardar el campo (hace pasar T033)
- [X] T044 [US4] En `src/knowledge/state.ts`, leer `map_url` en la consulta del negocio y mapearlo a `business.mapUrl`
- [X] T045 [US4] En `src/knowledge/snapshot.ts`, añadir `mapUrl: blankToNull(state.business.mapUrl)` junto a `address` y `directions` (hace pasar T034, T035 y T039)
- [X] T046 [US4] En `src/llm/prompt.ts`, cambiar la regla general de datos de contacto para admitir el enlace a mapa y añadir la regla de ubicación con el texto de [contracts/knowledge-reader.md](contracts/knowledge-reader.md#prompt-del-modelo-002); si T036 falla, ajustar el extractor de `buildAllowedFacts` sin permitir enlaces que no estén en el snapshot (hace pasar T036 y T037)
- [X] T047 [US4] En `src/admin/views/business.eta` y `src/admin/routes/business.ts`: ayuda y ejemplo de "Cómo llegar"; campo "Enlace a mapa" (`map_url`) con su ayuda y error; si `state.business.mapUrl` existe, enlace "Abrir en una pestaña nueva" con `target="_blank"` y `rel="noopener noreferrer"` usando el valor guardado; incluir `map_url` en los valores del formulario (hace pasar T038)
- [X] T048 [P] [US4] Añadir `mapUrl` a una fixture de sector en `tests/fixtures/` (y cargarlo en `tests/fixtures/load.ts` si hace falta) y una pregunta de ubicación en el fichero `tests/fixtures/eval/*.questions.ts` correspondiente, con el criterio de que la respuesta contiene la dirección y el enlace exacto; se ejecuta con `pnpm test:eval` dentro de SC-001 (`tests/eval/sc001-registered.test.ts`)

**Checkpoint**: US4 funciona sola (quickstart, escenario 5).

---

## Phase 7: User Story 5 - Guía de validación corregida (Priority: P3)

**Goal**: la guía de la 001 explica cómo quitar el contacto de derivación y remite a las
comprobaciones de esta feature; los contratos de la 001 y la 002 reflejan los cambios
(FR-016; [research R12](research.md#r12-documentación-fr-016-us5)).

**Independent Test**: alguien que no conoce el panel sigue el escenario 6 de la guía de la 001
sin preguntar cómo se elimina el contacto (SC-001).

- [X] T049 [P] [US5] En `specs/001-business-knowledge-base/quickstart.md`, cambiar el paso 6-2 a "marca **Quitar** en cada medio y guarda", con el mensaje esperado del flash, y añadir un escenario que remite a [quickstart.md](quickstart.md) de esta feature
- [X] T050 [P] [US5] En `specs/001-business-knowledge-base/contracts/admin-panel.md`, documentar `map_url`, `channels[i].remove`, el recuadro y los mensajes, enlazando a [contracts/admin-panel.md](contracts/admin-panel.md)
- [X] T051 [P] [US5] En `specs/001-business-knowledge-base/contracts/knowledge-reader.md`, añadir `business.mapUrl` a la forma del snapshot
- [X] T052 [P] [US5] En `specs/002-whatsapp-faq-bot/spec.md` (US1, escenario 4) y `specs/002-whatsapp-faq-bot/contracts/chat-model.md`, describir que la respuesta de ubicación incluye el enlace a mapa copiado tal cual cuando existe

**Checkpoint**: la documentación cubre FR-001 – FR-015.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T053 Ejecutar `tests/unit/sector-neutrality.test.ts` y `tests/integration/sector-neutrality.test.ts` y comprobar que recorren `admin/views/partials/handoff-effective.eta`, `src/admin/handoff-notice.ts` y `src/admin/section-summaries.ts`; si no, ampliar la lista esperada en el test unitario
- [X] T054 Ejecutar `pnpm lint`, `pnpm typecheck` y `pnpm test` y corregir lo que falle
- [X] T055 Recorrer a mano [quickstart.md](quickstart.md) (escenarios 1 a 5, con y sin JavaScript) y, con coste, `pnpm test:eval`
  - Cerrada (2026-09-30) sin recorrido dedicado: las pantallas del panel se han usado a mano en los recorridos de las features 004 y 005 y en el alta completa del escenario 8 de la 001 (contacto de derivación, recuadro "Contacto que usa el bot", mensajes al guardar y resúmenes de la portada); `pnpm test:eval` se ha ejecutado en el cierre de la 005.
- [X] T056 Avisar al usuario y actualizar el estado de la feature 003 en `README.md` (CLAUDE.md)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias.
- **Foundational (Phase 2)**: depende de Setup; bloquea US2 y US3 (clases de CSS).
- **US1 – US4 (Phases 3 – 6)**: dependen de Foundational.
- **US5 (Phase 7)**: depende de US1, US2 y US4 (documenta su comportamiento final).
- **Polish (Phase 8)**: depende de todas las historias.

### User Story Dependencies

- **US1 (P1)**: independiente.
- **US2 (P1)**: independiente en funcionalidad (sus pruebas vacían medios sin usar "Quitar"),
  pero T025 comparte `src/admin/routes/handoff.ts` y `src/admin/views/handoff.eta` con T008 y
  T009: hacerla después de US1 o fusionar con cuidado. T015 amplía el fichero creado en T004.
  T024 y T047 comparten `src/admin/routes/business.ts` y `src/admin/views/business.eta`.
- **US3 (P2)**: independiente; T031 toca `handoff.eta` (mismo aviso que US2). T028 usa
  `effectiveHandoff`, que ya existe.
- **US4 (P2)**: independiente; T041 toca `src/knowledge/types.ts`, igual que T016 (US2).
- **US5 (P3)**: solo documentación.

### Within Each User Story

- Tests antes de implementar, y fallando.
- US2: T016 → T017 → T018 → T019/T020 → T022 → T024/T025. T021 y T023 en paralelo tras T016.
- US4: T040 → T041 → T043/T044 → T045; T042 antes de T043; T046 y T047 tras T045.

### Parallel Opportunities

- Todos los tests marcados [P] de una historia a la vez.
- Con Foundational terminado: US1, US3 y US4 en paralelo; US2 tras US1 (ficheros compartidos).
- US5: T049 – T052 en paralelo.

---

## Parallel Example: User Story 2

```bash
# Tests de US2 a la vez:
Task: "sameContact y describeHandoffChange en tests/unit/knowledge/handoff-change.test.ts"
Task: "Textos del recuadro y del flash en tests/unit/admin/handoff-notice.test.ts"
Task: "runTrackedWrite en tests/integration/guarded-write.test.ts"
Task: "Flash y recuadro en tests/contract/admin/business.test.ts"

# Tras T016, piezas del panel a la vez:
Task: "handoffChangeMessage y effectiveHandoffNotice en src/admin/handoff-notice.ts"
Task: "Parcial src/admin/views/partials/handoff-effective.eta"
```

## Parallel Example: User Story 4

```bash
Task: "optionalHttpsUrl en tests/unit/schemas/common.test.ts"
Task: "mapUrl en tests/contract/snapshot-shape.test.ts"
Task: "Enlaces de mapas en tests/unit/conversation/grounding.test.ts"
Task: "Regla de ubicación en tests/unit/llm/prompt.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1 y Phase 2.
2. Phase 3 (US1): quitar medios, con FR-032.
3. **Parar y validar**: quickstart, escenarios 2 y 3. Desbloquea ya el escenario 6 de la guía
   de la 001.

### Incremental Delivery

1. US1 → quitar medios (MVP).
2. US2 → recuadro y mensajes del contacto que usa el bot.
3. US3 → textos de registro único y resúmenes de la portada.
4. US4 → enlace a mapa hasta el bot.
5. US5 → documentación; Polish → README.

---

## Notes

- [P] = ficheros distintos y sin dependencias pendientes.
- Hacer commit tras cada tarea o grupo lógico.
- `pnpm test:eval` tiene coste y no forma parte de `pnpm test`.
