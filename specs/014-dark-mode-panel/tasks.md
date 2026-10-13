---

description: "Task list template for feature implementation"
---

# Tasks: Modo oscuro del panel del operador

**Input**: Documentos de diseño en `/specs/014-dark-mode-panel/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: sí. El proyecto exige Vitest (unitarios, de contrato e integración) en CLAUDE.md, y el
plan concreta qué cubre cada nivel. Aquí no hay tests de integración: la feature no toca la base de
datos.

**Organization**: las tareas van agrupadas por historia de usuario, para poder implementar y
validar cada una por separado.

**Momento**: esta feature se implementa **después del despliegue en producción** (spec, Status).
No empieces la fase 1 antes de que la instancia real esté desplegada y estable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede hacer en paralelo (ficheros distintos, sin dependencias pendientes)
- **[Story]**: a qué historia pertenece (US1, US2, US3)
- Cada tarea lleva la ruta exacta del fichero

## Path Conventions

Monolito modular: `src/` y `tests/` en la raíz del repositorio. Todos los cambios de producción
caen en `src/admin/`, más una línea en `src/app.ts`.

---

## Phase 1: Setup

**Purpose**: partir de un punto conocido y dejar anotado lo que se va a tocar

- [x] T001 Comprobar el punto de partida con `pnpm lint && pnpm typecheck && pnpm test` en verde, y
      anotar en el seguimiento de la rama los 13 colores literales de
      `src/admin/views/app.css` que se van a tokenizar (líneas 123, 124, 131, 132, 199, 235, 239,
      243, 370, 434, 438, 581 y 597), para poder comprobar al final que no queda ninguno.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: que todo el color del panel pase por tokens, **sin que el modo claro cambie nada**.
Es la base de las tres historias.

**⚠️ CRITICAL**: ninguna historia puede empezar hasta terminar esta fase.

- [x] T002 Añadir al bloque `:root` de `src/admin/views/app.css` las dos paletas completas
      (`--c-light-*` y `--c-dark-*`, 16 colores cada una) y los tres colores fijos
      (`--fixed-sample`, `--fixed-canvas-a`, `--fixed-canvas-b`), con los valores exactos de
      [data-model.md §2.2 y §2.3](data-model.md). Solo declaraciones: todavía no las usa nadie.
- [x] T003 Convertir el bloque `:root` de `src/admin/views/app.css` en el primer mapeo:
      `color-scheme: light` y los 16 tokens de trabajo apuntando a `var(--c-light-*)`, sustituyendo
      los nueve valores literales que hoy tienen `--bg`, `--fg`, `--muted`, `--line`, `--card`,
      `--accent`, `--ok`, `--warn` y `--danger`.
- [x] T004 Sustituir en `src/admin/views/app.css` los 13 literales por los tokens nuevos, según la
      tabla de [contracts/panel-theme-css.md §3](contracts/panel-theme-css.md): campos y botones
      secundarios a `var(--field)`, borde de campos a `var(--control-line)`, texto sobre el color
      primario a `var(--on-accent)`, `.flash` a `var(--flash-bg)`/`var(--flash-line)`,
      `.general-error` a `var(--error-bg)`/`var(--error-line)`, el cuadriculado de la vista previa a
      `var(--fixed-canvas-a)`/`var(--fixed-canvas-b)` y las miniaturas de imágenes y el
      `input[type='color']` a `var(--fixed-sample)`.
- [x] T005 Comprobar que el modo claro quedó idéntico (FR-005): `pnpm test` en verde y un recorrido
      rápido del panel en claro comparando con el estado anterior, especialmente banda de
      «Guardado», banda de error, botones secundarios y de borrar, y la vista previa de
      **Diseño del chat**.
      **Nota**: los 13 literales de partida eran `#e8f5ec` y `#b7dcc4` (banda de «Guardado»),
      `#fdecea` y `#f1b7b2` (banda de error), seis `#fff` de campos y botones secundarios y de
      borrar, dos `#fff` de texto sobre el color primario (`button`/`a.button` y la burbuja del
      operador) y el par `#f6f7f9`/`#eef0f3` del cuadriculado de la vista previa. Ya no queda
      ninguno fuera de las paletas: lo comprueba `theme-css.test.ts` (T006). El modo claro sale
      idéntico por construcción —cada literal se sustituyó por un token cuyo valor claro es el
      mismo color (`--control-line` y `--line` comparten `#d9dde4`, y `--field`,
      `--on-accent` y `--fixed-sample` valen `#ffffff`)—; el repaso a ojo va con el recorrido
      manual del quickstart.

**Checkpoint**: el panel se ve exactamente como antes y todo su color pasa por tokens.

---

## Phase 3: User Story 1 - El panel acompaña al sistema (Priority: P1) 🎯 MVP

**Goal**: el panel y la pantalla de acceso se presentan en oscuro cuando el sistema lo pide, desde
la primera pintura, y vuelven a claro cuando el sistema vuelve a claro.

**Independent Test**: cambiar la preferencia de color del sistema operativo (o simularla en el
navegador) y recorrer el panel: cambia de tema, sin destello y sin perder lo escrito. No hace falta
ni cookie, ni ruta, ni control: esta historia es solo CSS.

### Tests for User Story 1

> Escríbelos primero y comprueba que fallan antes de tocar el CSS.

- [x] T006 [P] [US1] Crear `tests/unit/admin/theme-css.test.ts` con la primera mitad del contrato de
      [contracts/panel-theme-css.md §2](contracts/panel-theme-css.md): lee
      `src/admin/views/app.css`, extrae los bloques de mapeo y comprueba que (1) todos declaran el
      mismo conjunto de 16 tokens de trabajo, (2) ningún bloque de mapeo contiene un color literal,
      (3) `color-scheme` está en todos con el valor que le toca y (4) fuera de la paleta y de los
      tres tokens fijos no queda ningún color literal en el fichero.

### Implementation for User Story 1

- [x] T007 [US1] Añadir a `src/admin/views/app.css` el bloque
      `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { … } }` con
      `color-scheme: dark` y los 16 tokens apuntando a `var(--c-dark-*)`.
- [x] T008 [US1] Validar a mano la historia con [quickstart.md §2](quickstart.md): sistema en
      oscuro sin destello, pantalla de acceso incluida, cambio en caliente sin perder un formulario
      a medio escribir, y modo claro igual que antes.
      **Resultado (2026-10-13)**: recorrido completo del §2. El punto que quedaba era el §2.3
      (tema del sistema en caliente): el panel sigue la preferencia del sistema sin recargar y el
      campo a medio escribir se conserva (FR-004). Sin destello claro al abrir (FR-003), acceso
      oscuro incluido (FR-002) y el modo claro igual que antes de la feature (FR-005).

**Checkpoint**: con solo esta fase, el modo oscuro ya funciona para quien tiene el sistema en
oscuro. Es un incremento entregable por sí solo.

---

## Phase 4: User Story 2 - Elegir el tema y que se recuerde (Priority: P2)

**Goal**: un control de tres opciones en la barra superior y en la pantalla de acceso, que se aplica
al momento y se recuerda en el navegador.

**Independent Test**: elegir cada opción, recargar, cerrar sesión, reiniciar la instancia y volver;
y repetirlo con JavaScript desactivado.

### Tests for User Story 2

> Escríbelos primero y comprueba que fallan.

- [x] T009 [P] [US2] Crear `tests/unit/admin/theme.test.ts`: cookie ausente, `light`, `dark`, valor
      desconocido, rodeada de otras cookies, con espacios y repetida; atributos de la cabecera
      `Set-Cookie` dentro y fuera de producción; borrado con `Max-Age=0` para `auto`; y validación
      del destino (`/admin/hours` válido; `//evil.com`, `http://x`, `/chat` y vacío → `/admin`).
- [x] T010 [P] [US2] Crear `tests/contract/admin/theme.test.ts` con el contrato de
      [contracts/admin-theme.md §1 y §3](contracts/admin-theme.md): `data-theme` en una página del
      panel y en `/admin/login` según la cookie, ausencia de atributo sin cookie, presencia del
      control con su token CSRF en las dos pantallas, y `POST /admin/theme` con los tres valores,
      con y sin `HX-Request` (`204` / `303`), valor inválido (`422`), sin CSRF (`403`) y atributos
      y `Max-Age` de la cookie.

### Implementation for User Story 2

- [x] T011 [US2] Crear `src/admin/theme.ts` (puro, sin Fastify): tipos `ThemeChoice` y
      `StoredTheme`, `themeFromCookieHeader(header)`, `themeAttribute(theme)`,
      `themeCookieHeader(choice, { production })` y `safeNext(next)`, según
      [data-model.md §1](data-model.md) y [contracts/admin-theme.md §3](contracts/admin-theme.md).
- [x] T012 [US2] Crear `src/admin/routes/theme.ts` con `POST /theme`: valida `theme` con Zod sobre
      la lista cerrada, pone la cabecera `Set-Cookie` y responde `204` a htmx o `303` al destino
      validado. No consulta la base de datos ni la sesión.
- [x] T013 [US2] Registrar la ruta en `src/app.ts` dentro del ámbito `/admin` y **fuera** del
      ámbito del operador, con `csrfOnPost` aplicado, para que también funcione en la pantalla de
      acceso (R5).
- [x] T014 [US2] Añadir `theme` al objeto `layout` en `renderPage` de `src/admin/render.ts`,
      leyéndolo de la cabecera de cookie de la petición.
- [x] T015 [US2] Pasar el tema a la pantalla de acceso en `src/admin/auth/routes.ts`, en las dos
      llamadas que renderizan `login` (la del `GET` y la del intento fallido).
- [x] T016 [US2] Pintar el atributo en `<html>` en `src/admin/views/layout.eta` y en
      `src/admin/views/login.eta`.
- [x] T017 [US2] Crear `src/admin/views/partials/theme-switch.eta` con el formulario de
      [contracts/admin-theme.md §2](contracts/admin-theme.md) (tres opciones, `fieldset`/`legend`,
      `_csrf`, `next` y botón de respaldo) e incluirlo en la barra superior de `layout.eta` y en
      `login.eta`.
- [x] T018 [US2] Añadir los estilos de `.theme-switch` a `src/admin/views/app.css` (solo tokens, sin
      literales) y el bloque de mapeo `:root[data-theme='dark']` con `color-scheme: dark` y los 16
      tokens oscuros.
- [x] T019 [US2] Añadir a `src/admin/views/app.js` el código que aplica el tema al instante: al
      cambiar la opción, poner `document.documentElement.dataset.theme` o borrarlo si es
      automático, sin recargar (R6).
      **Notas de US2**, por si alguien las «limpia»:
      1. El formulario lleva `hx-trigger="change, submit"`. Sin él htmx solo manda el POST al
         enviar el formulario, así que el tema cambiaría a la vista pero no se recordaría hasta
         pulsar «Aplicar»: la elección se perdería en la recarga siguiente (FR-009).
      2. No hace falta `themeAttribute`: el atributo se pinta en la plantilla con `<%= %>`, que
         escapa el valor como cualquier otro dato, tal y como pide contracts/admin-theme.md §1.
         El módulo expone `themeFromCookieHeader`, `themeCookieHeader` y `safeNext`.
      3. `safeNext` rechaza además los destinos con espacios o saltos de línea: ese valor acaba
         en una cabecera `Location`.
      4. `GET /admin/theme` da 404 **con sesión** (la ruta no existe para el panel) y 302 a la
         pantalla de acceso sin ella, como cualquier otra ruta del panel.
- [x] T020 [US2] Validar a mano la historia con [quickstart.md §3](quickstart.md), incluidos el
      recorrido sin JavaScript y la cookie con un valor inventado.
      **Resultado (2026-10-13)**: recorrido completo del §3. Los dos puntos que quedaban:
      §3.6 sin JavaScript (desactivado desde las herramientas del navegador, «Aplicar» manda el
      POST y el 303 devuelve a la misma sección ya en oscuro, FR-012) y §3.7 con la cookie
      `kb_theme` puesta a `morado` a mano: el panel se comporta como automático, sin error ni
      página en blanco (FR-011).

**Checkpoint**: US1 y US2 funcionan por separado; el panel se puede forzar a claro u oscuro y lo
recuerda.

---

## Phase 5: User Story 3 - Nada se vuelve ilegible ni engañoso en oscuro (Priority: P3)

**Goal**: el modo oscuro es utilizable de verdad: contraste comprobado, foco visible, avisos que
destacan, impresión legible y los colores del negocio intactos.

**Independent Test**: el test de CSS comprueba los contrastes de forma repetible y el recorrido
manual de las quince secciones no encuentra ninguna zona del tema contrario.

### Tests for User Story 3

- [x] T021 [P] [US3] Completar `tests/unit/admin/theme-css.test.ts` con la segunda mitad del
      contrato: todas las parejas de [data-model.md §2.4](data-model.md) cumplen su mínimo usando
      `contrastRatio`, `MIN_TEXT_CONTRAST` y `MIN_UI_CONTRAST` de
      `src/webchat/design/contrast.ts`; la paleta `--c-light-*` es idéntica a los valores de hoy
      (FR-005); y existe la regla `:focus-visible` con `outline` de 2 px.
- [x] T022 [P] [US3] Ampliar `tests/contract/admin/chat-design.test.ts`: la vista previa del chat
      **no** recibe `data-theme` del panel y su HTML es idéntico con la cookie en `dark` y sin
      cookie (FR-019), y el aviso de contraste del diseño da el mismo resultado en los dos casos
      (FR-020).

### Implementation for User Story 3

- [x] T023 [US3] Añadir a `src/admin/views/app.css` la regla
      `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }` (FR-015).
- [x] T024 [US3] Añadir a `src/admin/views/app.css` el bloque `@media print` que mapea siempre la
      paleta clara y `color-scheme: light` (FR-021).
- [x] T025 [US3] Repasar en las plantillas de `src/admin/views/` que ningún estado se distinga solo
      por color: avisos críticos, badges de activo y borrador, errores de campo, diferencias de la
      importación y resultado bloqueado conservan su texto o su etiqueta (FR-016); corregir lo que
      falte.
      **Resultado del repaso: no hubo nada que corregir.** Cada estado ya llevaba su texto o su
      etiqueta: «Activo»/«En preparación» en la barra superior, «Crítico»/«Aviso» al principio de
      cada aviso, «Activo»/«Inactivo» en la columna Estado de servicios y recursos, el verbo
      («Se añade», «Se quita», «Orden cambiado») en cada línea de las diferencias de la
      importación, «Se aplicará»/«Se rechazará: …» en el resultado previsto, el mensaje junto al
      campo con error y el propio texto del aviso en las bandas de protección y de gasto.
- [x] T026 [US3] Recorrer a mano las quince secciones en oscuro con la tabla de
      [quickstart.md §4](quickstart.md), incluidos banda de guardado, error de formulario, recorrido
      con tabulador, aviso de contraste del chat e impresión; anotar y corregir lo que aparezca.
      **Resultado (2026-10-13)**: recorrido completo del §4, las quince secciones en oscuro. El
      punto que quedaba era el §4.5 (impresión): legible en papel. No hizo falta corregir nada.

**Checkpoint**: las tres historias funcionan y el modo oscuro está listo para el uso diario.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T027 Ejecutar `pnpm lint && pnpm typecheck && pnpm test` y comprobar, además, que la rama no
      ha tocado `src/db`, `src/config-transfer` ni `src/webchat` en producción, y que
      `formatVersion` sigue igual (`git diff main --stat`), como exige FR-010.
      **Resultado (2026-10-10)**: `pnpm lint` y `pnpm typecheck` limpios y `pnpm test` en verde,
      **276 ficheros y 3231 tests** (3 saltados: los del socket Unix de la 016, que no corren en
      Windows), 24 min 42 s. Antes de la feature eran 273 ficheros; los tres nuevos son
      `tests/unit/admin/theme.test.ts`, `tests/unit/admin/theme-css.test.ts` y
      `tests/contract/admin/theme.test.ts`.
      La comprobación de FR-010 se hizo contra la punta de la 016, que es la base de esta rama
      (`git diff 515f277..HEAD -- src/`): solo `src/admin/**` y tres líneas de `src/app.ts`.
      Nada en `src/db`, `src/config-transfer`, `src/webchat` ni `drizzle/`, y
      `CURRENT_FORMAT_VERSION` sigue en 2.
- [x] T028 Avisar al usuario y actualizar `README.md` con el estado de la feature 014 y una línea
      sobre el modo oscuro del panel (convención de CLAUDE.md: avisar antes).
- [x] T029 Actualizar `docs/operacion-multicliente.md`: añadir la fila de la 014 a la tabla de specs
      realizadas (9.1) con su fecha y la nota de que no venía de ninguna propuesta de 9.2, y revisar
      el orden de las pendientes.
- [ ] T030 Validar en la instancia real con [quickstart.md §5](quickstart.md): desplegar por tandas
      (feature 009), confirmar la versión con `pnpm instance:versions`, trabajar una jornada con el
      tema elegido (SC-008) y comprobar que el chat web de los clientes finales no ha cambiado.
- [x] T031 Subir `version` en `package.json` a **0.1.2** (guía de operación, §5.1: un número
      nuevo por imagen, nunca uno ya desplegado). La 014 se despliega con su propia imagen,
      después de la `0.1.1` de la 016, que es la que cierra su T051. `CURRENT_FORMAT_VERSION`
      sigue en 2: no hay migración ni configuración nueva del negocio.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (fase 1)**: sin dependencias.
- **Foundational (fase 2)**: depende de la 1 y **bloquea las tres historias**. Sin los tokens, el
  modo oscuro dejaría zonas claras sueltas.
- **US1 (fase 3)**: depende de la 2. No depende de US2 ni de US3.
- **US2 (fase 4)**: depende de la 2. Puede hacerse sin US1, pero entregarla antes no tiene sentido:
  el control solo ofrecería «claro» y «claro».
- **US3 (fase 5)**: depende de la 2 y comprueba sobre todo lo entregado en US1; T022 necesita la
  cookie de US2.
- **Polish (fase 6)**: depende de las historias que se entreguen.

### Within Each User Story

- Los tests van primero y deben fallar antes de implementar.
- En US2: el módulo puro (T011) antes de la ruta (T012), la ruta antes del registro (T013), y el
  servidor (T014, T015) antes de las plantillas (T016, T017).
- La validación manual cierra cada historia.

### Parallel Opportunities

- T006 y T009/T010 son ficheros distintos y pueden escribirse a la vez si se trabajan US1 y US2 en
  paralelo tras la fase 2.
- T009 y T010 en paralelo entre sí.
- T021 y T022 en paralelo entre sí.
- Dentro de US2, T011 bloquea casi todo lo demás: no hay mucho paralelismo real.
- Las tareas de CSS (T003, T004, T007, T018, T023, T024) tocan todas `app.css`: **nunca en
  paralelo**, aunque pertenezcan a fases distintas.

---

## Parallel Example: tests tras la fase 2

```bash
# Con dos personas, una por historia, en cuanto la fase 2 está cerrada:
Task: "tests/unit/admin/theme-css.test.ts, primera mitad (T006)"
Task: "tests/unit/admin/theme.test.ts (T009)"
Task: "tests/contract/admin/theme.test.ts (T010)"
```

---

## Implementation Strategy

### MVP primero (solo US1)

1. Fase 1: setup.
2. Fase 2: tokens, con el modo claro intacto. **Es la parte que más código toca y la que menos se
   ve**: merece su propio repaso.
3. Fase 3: el bloque oscuro de la media query.
4. **Parar y validar**: quickstart §2.
5. Si solo se entregara esto, el operador con el sistema en oscuro ya tiene el panel en oscuro.

### Entrega incremental

1. Fases 1 y 2 → el panel sigue igual, pero preparado.
2. US1 → modo oscuro automático. Entregable.
3. US2 → control y memoria. Entregable.
4. US3 → contraste, foco, impresión y repaso completo. Cierra la feature.
5. Fase 6 → documentación y validación en producción.

---

## Notes

- `[P]` = ficheros distintos, sin dependencias pendientes.
- **Nada de esto toca la base de datos**: no hay migración, no sube `formatVersion`, no hay
  actualizador de `config-transfer` ni tests de integración nuevos.
- La CSP del panel no cambia: no se añade ningún script inline ni ningún recurso externo.
- Haz un commit por tarea o por grupo lógico; el modo claro debe quedar verde en cada uno.
- Si en el recorrido manual aparece una zona clara en oscuro, el fallo casi siempre es un token
  olvidado en un bloque de mapeo: T006 debería cazarlo, y si no lo caza, amplía el test antes de
  arreglar el CSS.

---

## Lo que queda (sesión siguiente)

Los tres recorridos a mano (T008, T020 y T026) quedaron cerrados el **2026-10-13**. Queda el
despliegue y una corrección que se destapó al volver a pasar la puerta de 5.1:

- **T030**: despliegue de la `0.1.2` por tandas (feature 009) y la jornada de trabajo real de
  [quickstart.md §5](quickstart.md).
- **Lint pendiente**: `tests/unit/admin/theme-css.test.ts:145` tiene una aserción `as Hex`
  innecesaria (`Hex` es un alias de `string`), y `pnpm lint` falla por ella. Viene de `70927d7`,
  no del rebase sobre la 016: el fichero es idéntico antes y después. Es decir, **el `pnpm lint`
  limpio que anota T027 no era exacto**; hay que corregir la línea y la anotación.

**En la pantalla de acceso el cambio llega recargando, y es a proposito.** login.eta no carga
htmx ni app.js —no se le anade codigo a una pagina previa a la sesion solo por comodidad—, asi que
alli el control se comporta como el caso sin JavaScript: el boton Aplicar manda el POST y el 303
devuelve a la misma pantalla ya con el tema. Dentro del panel si cambia al instante. No es un fallo
del recorrido de T020.

El orden en el VPS importa: primero la `0.1.1` con las dos casillas de la fase 9 que cierran la
T051 de la 016, y después la `0.1.2` con el modo oscuro. Son dos pasadas del procedimiento de la
[sección 5](../../docs/operacion-multicliente.md#5-actualizar-el-núcleo), no una.

La rama parte de la punta de `016-db-outage-resilience`, así que **contiene la 016**: lo que se
anote en `docs/plan-despliegue-produccion.md` al cerrar la T051 habrá que traerlo aquí (fusionar
la 016 en `main` y rebasar esta rama encima) antes de construir la imagen `0.1.2`.
