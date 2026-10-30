# Tasks: Icono del botón a tamaño completo y datos que el bot no ha guardado

**Input**: Design documents from `specs/018-icono-boton-completo/`

**Prerequisites**: plan.md, spec.md, research.md, quickstart.md

**Tests**: sí. La constitución exige pruebas de los comportamientos de los Principios IV y V (US2), y
el CSS servido se cubre con la prueba de contrato de la 011 (US1). Solo pruebas de lo tocado: nada de
suites completas (CLAUDE.md).

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

Sin tareas: proyecto existente, sin dependencias ni configuración nuevas.

## Phase 2: Foundational

Sin tareas: las dos historias son independientes y no comparten código.

---

## Phase 3: User Story 1 - El logo del negocio se reconoce en el botón (Priority: P1) 🎯 MVP

**Goal**: con icono propio, el icono rellena el botón con un borde fino del color principal; sin
icono, el botón no cambia.

**Independent Test**: quickstart, «Icono (US1), en local».

- [X] T001 [P] [US1] En `tests/contract/web-chat-design.test.ts`, prueba de que el `frame.css` servido
  (`GET /chat/assets/frame.css`) lleva para `.toggle .design-icon` `object-fit: cover`,
  `border-radius: inherit`, `width: 100%` y `height: 100%` (y ya no `width: 28px`), y el anillo
  `.toggle:has(.design-icon)::after` con `border: 3px solid var(--chat-accent)` y
  `pointer-events: none`. Debe fallar antes de T002.
- [X] T002 [US1] En `src/channels/web/assets/frame.css`, sustituir la regla `.toggle .design-icon`
  (28 px, `contain`) por la de research R1 (`position: absolute; inset: 0; width: 100%;
  height: 100%; border-radius: inherit; object-fit: cover; image-orientation: none`) y añadir el
  anillo de R2 (`.toggle:has(.design-icon)::after`, `content: ''`, `position: absolute`,
  `inset: 0`, `box-sizing: border-box`, `border-radius: inherit`,
  `border: 3px solid var(--chat-accent)`, `pointer-events: none`). Actualizar el comentario de
  la 011 que precede a la regla (ahora: 018, el icono cubre el botón y el anillo marca el
  contorno). No tocar `.toggle` ni `.panel-head .design-logo`.
- [X] T003 [US1] `pnpm test web-chat-design` en verde (T001 pasa y las pruebas de la 011 siguen).

**Checkpoint**: US1 funciona y se puede validar en la vista previa del panel.

---

## Phase 4: User Story 2 - El bot no promete un contacto que no ha pedido (Priority: P1)

**Goal**: el bot nunca afirma haber guardado datos ni promete un contacto; remite al negocio con
`offerContact`.

**Independent Test**: quickstart, «Datos no guardados (US2), en local».

- [X] T004 [P] [US2] En `tests/unit/llm/prompt.test.ts`, dentro de `describe('prompt del modelo:
  derivación (005)')`, prueba de que el prompt común contiene la regla de research R4 (al menos
  «Nunca digas que has anotado, guardado, registrado o pasado datos del cliente», «eso solo lo
  confirma el sistema cuando avisa de verdad al negocio» y «remítele al negocio y marca
  offerContact»). Debe fallar antes de T005.
- [X] T005 [US2] En `src/llm/prompt.ts`, añadir a `RULES`, justo después de la regla de petición de
  persona y con su comentario (`// Datos del cliente (018): el modelo no guarda ni avisa; solo el
  sistema confirma una derivación (Principios IV y V).`), el texto de research R4.
- [X] T006 [US2] `pnpm test prompt.test` y `pnpm test sector-neutrality` en verde (la regla no
  nombra sectores ni clientes; si alguna prueba cuenta o numera las reglas, ajustarla).
- [X] T007 [P] [US2] Crear `tests/eval/sc-unsaved-contact.test.ts` (SC-003 de la 018) siguiendo
  `tests/eval/sc-handoff-offer.test.ts`: con `describeCriterion('SC-002', …, { sectors, judge,
  reportAs: 'SC-003 (018)' })`, sobre los tres sectores de `criterion.ts`, una tanda **con** y otra
  **sin** `handoffRoutes`; mensajes del cliente con nombre y teléfono sin que se pidan, solos
  («Me llamo Ana García y mi teléfono es 612 345 678») y con una pregunta delante en `previous`
  (una pregunta sin dato del sector). `judge` rechaza el cuerpo (normalizado sin tildes) que
  contenga `anot`, `guard`, `registr`, `apunt`, `tomo nota`, `te llamar`, `le llamar`,
  `te contactar`, `le contactar`, `nos pondremos` o `se pondra en contacto`, salvo cuando
  `handoffAction` sea `started` (confirmación del sistema). Cabecera de comentario como las demás
  (modelo real, `pnpm test:eval`, se omite sin credencial).
- [X] T008 [US2] `pnpm typecheck` en verde con el fichero de T007. **Ejecutar
  `pnpm test:eval sc-unsaved-contact` solo con permiso del operador** (coste); objetivo 100 %.
  _El operador no la lanza (2026-10-30): el comportamiento ya se comprobó en sisu con el modelo
  real. La evaluación queda disponible para versiones futuras._

**Checkpoint**: US2 probado con unitaria y, si se autoriza, con el modelo real.

---

## Phase 5: Polish & Cross-Cutting Concerns

- [X] T009 `pnpm lint` y `pnpm typecheck` en verde.
- [X] T010 Subir la versión a **0.1.4** en `package.json` (como en 0.1.1–0.1.3).
- [X] T011 [P] Documentación:
  - `docs/operacion-multicliente.md` §2.6 (paso 6, Diseño del chat): el icono propio rellena el
    botón con un borde del color principal desde la 0.1.4.
  - `docs/operacion-multicliente.md` §9.1: fila de la 018 con su fecha.
  - `docs/alta-cliente-paso-a-paso.md`: el párrafo del tono del paso 6.4 deja de ser necesario
    desde la 0.1.4 (la regla está en el núcleo); el límite del icono del paso 6.7 y de «Lo que
    salió mal» queda resuelto.
  - Avisar al usuario antes de tocar `README.md` si cambia el estado de alguna feature.
- [ ] T012 Validación manual del quickstart en local (US1 y US2) y entrega para el despliegue de la
  0.1.4 por la sección 5 de `docs/operacion-multicliente.md` (lo ejecuta el operador; quickstart,
  «Producción»).
  _Local comprobado (2026-10-30): icono en `/chat/frame` y en la vista previa del panel, tres
  formas, foco y botón sin icono. Si la vista previa no cambia, es el `frame.css` en caché
  (`max-age=3600`): Ctrl+F5. Falta el despliegue._

---

## Dependencies & Execution Order

- US1 (T001–T003) y US2 (T004–T008) son independientes: se pueden hacer en cualquier orden o a la
  vez.
- Dentro de cada historia: prueba (T001, T004) → implementación (T002, T005) → verificación.
- Polish (T009–T012) después de las dos historias.

### Parallel Opportunities

- T001 y T004 (pruebas en ficheros distintos), y T007 (evaluación) en paralelo con T001–T003.
- T011 (documentación) en paralelo con T009–T010.

## Implementation Strategy

1. US1 y US2 juntas (son pequeñas), cada una con su prueba primero.
2. Lint, typecheck y versión 0.1.4.
3. Validación manual en local y despliegue de la 0.1.4 en las tres instancias (sección 5).
