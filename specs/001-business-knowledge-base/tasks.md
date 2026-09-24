---

description: "Lista de tareas para implementar la base de conocimiento del negocio"
---

# Tasks: Base de conocimiento del negocio

**Input**: Documentos de diseño en `/specs/001-business-knowledge-base/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (admin-panel.md, knowledge-reader.md, warnings.md), quickstart.md

**Tests**: SÍ se incluyen. La estrategia de pruebas está definida en research.md (R11) y
quickstart.md (un test por código de aviso, SC-004; test de neutralidad sectorial, SC-005), y la
constitución exige probar las garantías de datos en que se apoyan los Principios IV y V. Los
tests de cada historia se escriben primero y deben fallar antes de implementar.

**Organization**: tareas agrupadas por historia de usuario para poder implementarlas y probarlas
de forma independiente.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede ejecutar en paralelo (ficheros distintos, sin dependencias pendientes)
- **[Story]**: historia a la que pertenece (US1 … US5)
- Cada tarea indica la ruta exacta del fichero

## Path Conventions

Proyecto único en la raíz del repositorio: `src/` y `tests/` (ver plan.md → Project Structure).

---

## Phase 1: Setup (infraestructura compartida)

**Purpose**: inicializar el proyecto TypeScript/Node.js con las herramientas elegidas en research.md.

- [ ] T001 Crear `package.json` (pnpm, `"type": "module"`, `engines.node >= 22`) con dependencias `fastify@5`, `@fastify/view`, `eta`, `htmx.org`, `@fastify/formbody`, `@fastify/secure-session`, `@fastify/csrf-protection`, `@fastify/rate-limit`, `drizzle-orm`, `pg`, `zod`, `libphonenumber-js`, `argon2` y devDependencies `typescript`, `tsx`, `drizzle-kit`, `vitest`, `@testcontainers/postgresql`, `@types/pg`, `eslint`, `typescript-eslint`, `prettier`; scripts `dev`, `build`, `start`, `test`, `test:unit`, `test:contract`, `test:integration`, `lint`, `typecheck`, `db:generate`, `db:migrate`, `kb:snapshot`, `operator:hash-password` en package.json
- [ ] T002 [P] Crear `tsconfig.json` con `strict: true`, `module`/`moduleResolution: NodeNext`, `target: ES2023`, `outDir: dist`, incluyendo `src/` y `tests/` en tsconfig.json
- [ ] T003 [P] Configurar ESLint (flat config con `typescript-eslint`, reglas estrictas) y Prettier en eslint.config.js y .prettierrc
- [ ] T004 [P] Configurar Vitest con tres proyectos (`unit` → `tests/unit/**`, `contract` → `tests/contract/**`, `integration` → `tests/integration/**` con `globalSetup: tests/helpers/global-setup.ts`) en vitest.config.ts
- [ ] T005 [P] Crear docker-compose.yml con el servicio `db` (postgres:16, volumen, puerto 5432) y .env.example con `DATABASE_URL`, `OPERATOR_USER`, `OPERATOR_PASSWORD_HASH`, `SESSION_SECRET`, `DEFAULT_PHONE_REGION=ES`, `DEFAULT_TIMEZONE=Europe/Madrid`, `DEFAULT_CURRENCY=EUR`, `PORT=3000`
- [ ] T006 [P] Crear drizzle.config.ts (dialect `postgresql`, schema `src/db/schema.ts`, out `src/db/migrations`, credenciales desde `DATABASE_URL`)
- [ ] T007 [P] Crear .gitignore y .dockerignore (node_modules, dist, .env, coverage) y la estructura de carpetas del plan (`src/config`, `src/db`, `src/knowledge/{schemas,time,repositories,services}`, `src/admin/{auth,routes,views}`, `src/cli`, `tests/{unit,contract,integration,fixtures,helpers}`)

---

## Phase 2: Foundational (prerrequisitos bloqueantes)

**Purpose**: base de datos, sesión del operador, esqueleto del panel, carga del estado, avisos
críticos, guardado protegido (FR-032), activación (FR-029 – FR-031) y puerto de lectura del bot.

**⚠️ CRITICAL**: ninguna historia puede empezar hasta completar esta fase.

### Configuración y base de datos

- [ ] T008 Implementar la validación de variables de entorno con Zod (`DATABASE_URL`, `OPERATOR_USER`, `OPERATOR_PASSWORD_HASH`, `SESSION_SECRET` ≥ 32 bytes, `DEFAULT_PHONE_REGION`, `DEFAULT_TIMEZONE` IANA válida, `DEFAULT_CURRENCY` ISO 4217, `PORT`, `NODE_ENV`) exportando `loadEnv()` en src/config/env.ts
- [ ] T009 Definir todas las tablas de data-model.md con Drizzle en src/db/schema.ts: `business` (singleton `id smallint = 1` con CHECK, enum `business_status` draft/active), `business_hours`, `closure`, `service` (enum `price_type` fixed/from/on_request, CHECK `price_cents >= 0`, `duration_minutes` entre 1 y 1440), índice único `lower(name)` en `service` y `resource`, `resource`, `resource_service` (PK compuesta, FK `ON DELETE CASCADE`, sin precio ni duración), `resource_hours`, `resource_absence`, `faq`, `policies` (singleton, `payment_methods text[]`), `tone` (singleton, enum `address_form`), `handoff_contact` (singleton), `handoff_channel` (enum phone/whatsapp/email, único `(type, value)`), `handoff_hours`; CHECK `end_time > start_time`, `weekday` 1..7, `end_date >= start_date`, "ambas horas o ninguna"; `updated_at timestamptz default now()` en todas
- [ ] T010 Generar la migración inicial con `pnpm db:generate` en src/db/migrations/ y crear el script de migración src/db/migrate.ts que aplica las migraciones y después inserta la fila singleton de `business` (`status = 'draft'`, `name = ''`, `timezone = DEFAULT_TIMEZONE`, `currency = DEFAULT_CURRENCY`) con `ON CONFLICT DO NOTHING`
- [ ] T011 Implementar src/db/client.ts: `createDb(databaseUrl)` (pool `pg` + instancia Drizzle), `withTransaction(db, fn)`, `lockBusiness(tx)` (`SELECT … FROM business WHERE id = 1 FOR UPDATE`) y `withReadSnapshot(db, fn)` (transacción `REPEATABLE READ READ ONLY`)
- [ ] T012 [P] Crear los helpers de test: tests/helpers/global-setup.ts (arranca PostgreSQL 16 con Testcontainers, aplica src/db/migrate.ts, exporta la URL), tests/helpers/db.ts (`resetDb()`: TRUNCATE de todas las tablas y reinserción del negocio en draft) y tests/helpers/app.ts (`buildTestApp()`, `login(app)` que devuelve cookie de sesión y token CSRF, `postForm(app, url, fields)`)

### Esquemas de validación compartidos

- [ ] T013 [P] Implementar esquemas Zod comunes en src/knowledge/schemas/common.ts: `trimmedText(min, max)`, `optionalText(max)` (vacío → `null`), `localTime` (`HH:MM`), `isoDate`, `phone` (libphonenumber-js con `DEFAULT_PHONE_REGION`, normaliza a E.164, error "Teléfono no válido"), `email` (minúsculas), `timezone` (presente en `Intl.supportedValuesOf('timeZone')`), `currency` (3 letras mayúsculas)
- [ ] T014 [P] Implementar `weeklySlotsSchema` en src/knowledge/schemas/weekly-slots.ts: lista de `{ weekday: 1..7, start, end }`; error en `slots[i].end` si `end <= start` (FR-006) y en `slots[i]` si solapa con otra franja del mismo día (research R8); se reutiliza para negocio, recursos y derivación
- [ ] T015 [P] Implementar `dateRangeBlockSchema` en src/knowledge/schemas/date-range-block.ts: `start_date`, `end_date` (error en `end_date` si es anterior), `start_time`/`end_time` opcionales (error si solo hay una; error en `end_time` si `end_time <= start_time`); reutilizable por cierres y ausencias
- [ ] T016 [P] Tests unitarios de T013–T015 en tests/unit/schemas/common.test.ts, tests/unit/schemas/weekly-slots.test.ts y tests/unit/schemas/date-range-block.test.ts (teléfono `600 123 456` → `+34600123456`, email `foo@` rechazado, zona `Mars/Base` rechazada, franja 14:00–09:00 → error en `slots[0].end`, solape en el mismo día, cierre con fecha fin anterior, cierre con una sola hora)

### Estado, avisos críticos y guardado protegido

- [ ] T017 Definir los tipos del dominio en src/knowledge/types.ts: `KnowledgeState` (filas de todas las tablas + `maxUpdatedAt`), `KnowledgeSnapshot`, `WeeklySlot`, `DateRangeBlock` (exactamente como contracts/knowledge-reader.md) y `Warning`, `WarningCode`, `WarningSeverity` (como contracts/warnings.md)
- [ ] T018 Implementar `loadKnowledgeState(tx)` en src/knowledge/state.ts: carga todas las tablas en una transacción recibida (ordenadas por `sort_order`/`weekday`/`start_time`/`start_date`) y calcula `maxUpdatedAt` como el máximo `updated_at` de todas ellas
- [ ] T019 Implementar `effectiveHandoff(state)` en src/knowledge/handoff.ts según data-model.md: `configured` si hay contacto con ≥ 1 medio (medios por `sort_order` + `handoff_hours`), `business_phone` si solo hay `business.phone`, `none` en otro caso (FR-018, FR-019)
- [ ] T020 Implementar `computeWarnings(state)` en src/knowledge/warnings.ts con la ordenación del contrato (críticos primero, luego `target.kind` y `target.label`), mensajes en español y los códigos `HANDOFF_CONTACT_MISSING` (normal) y `HANDOFF_UNREACHABLE` (critical), mutuamente excluyentes, basados en `effectiveHandoff`; dejar el resto del catálogo para US5
- [ ] T021 [P] Tests unitarios de `effectiveHandoff` y de los avisos de derivación en tests/unit/warnings/handoff.test.ts (instancia vacía → `HANDOFF_UNREACHABLE`; con teléfono → `HANDOFF_CONTACT_MISSING`; con medio configurado → ninguno)
- [ ] T022 Implementar `runGuardedWrite(db, fn)` en src/knowledge/services/guarded-write.ts (research R6): abre transacción, `lockBusiness`, ejecuta `fn(tx)`, recarga el estado con `loadKnowledgeState(tx)`, calcula avisos y, si `status = 'active'` y hay algún aviso `critical`, revierte y lanza `CriticalWarningError` con esos avisos (FR-032); traduce violaciones de unicidad de Postgres a `FieldConflictError(field)`
- [ ] T023 Implementar `activateBusiness(db)` y `deactivateBusiness(db)` en src/knowledge/services/business-status.ts: activar bloquea el negocio, recalcula avisos y lanza `ActivationBlockedError` con los críticos si los hay (FR-031); desactivar siempre se permite; ambas actualizan `updated_at`
- [ ] T024 [P] Test de integración del guardado protegido y la activación en tests/integration/guarded-write.test.ts (instancia nueva: activar → `ActivationBlockedError` con `HANDOFF_UNREACHABLE` y estado `draft`; negocio activo con teléfono y sin derivación: una escritura que vacía `business.phone` se revierte; desactivar siempre funciona)

### Puerto de lectura del bot

- [ ] T025 Implementar src/knowledge/snapshot.ts: `buildSnapshot(state): KnowledgeSnapshot` (función pura) con `status`, `business` (campos vacíos → `null`), `handoff` (desde `effectiveHandoff`) y `updatedAt`; el resto de secciones con valores vacíos del contrato (listas vacías, `scheduling: { mode: "single_agenda" }`, políticas y tono a `null`); y `createKnowledgeReader(db)` cuyo `getSnapshot()` usa `withReadSnapshot` + `loadKnowledgeState` en cada llamada, sin ninguna caché ni memoización (FR-021)
- [ ] T026 [P] Implementar el CLI `pnpm kb:snapshot` que imprime `getSnapshot()` en JSON indentado en src/cli/snapshot.ts
- [ ] T027 [P] Implementar el CLI `pnpm operator:hash-password` (lee la contraseña por stdin sin eco, imprime hash Argon2id) en src/cli/hash-password.ts

### Panel: aplicación, sesión y estructura

- [ ] T028 Implementar src/admin/form-errors.ts: `zodErrorToFieldErrors(error)` → `Record<string, string>` con rutas tipo `slots[0].end`, `channels[1].value`; y `formErrorResponse(err)` que mapea `ZodError`/`FieldConflictError` → 422 y `CriticalWarningError` → 409 con mensaje general ("El negocio está activo y se quedaría sin salida a una persona") y el aviso que lo provocaría
- [ ] T029 Implementar la autenticación en src/admin/auth/plugin.ts (registro de `@fastify/secure-session` con cookie `HttpOnly`, `SameSite=Strict`, `Secure` en producción; `@fastify/csrf-protection`; hook `requireOperator` que responde `302 → /admin/login` o `401` con `HX-Redirect` para peticiones htmx) y src/admin/auth/routes.ts (`GET/POST /admin/login` con verificación Argon2 de `OPERATOR_USER`/`OPERATOR_PASSWORD_HASH`, error genérico, `@fastify/rate-limit` por IP en el POST; `POST /admin/logout`)
- [ ] T030 [P] Crear las plantillas base en src/admin/views/: layout.eta (cabecera con estado del negocio, contador de avisos, navegación a todas las secciones, carga de htmx, token CSRF en `hx-headers`), login.eta, partials/flash.eta, partials/field-error.eta, partials/csrf.eta, partials/warnings-count.eta y not-found.eta
- [ ] T031 Implementar src/admin/render.ts: `renderPage(reply, view, data)` (inyecta estado del negocio y número de avisos calculados en cada petición), `renderForm(reply, view, { values, errors, status })` para 422/409 y `savedResponse(request, reply, redirectTo, fragment)` que devuelve `303` con flash "Guardado" o, si es htmx, `200` con el fragmento y el contador de avisos (`hx-swap-oob`)
- [ ] T032 Implementar src/app.ts `buildApp({ env, db })`: registra `@fastify/formbody`, `@fastify/view` con Eta y `src/admin/views`, la ruta estática de `htmx.min.js` desde el paquete `htmx.org`, el plugin de autenticación, `src/admin/routes/index.ts` bajo `/admin` y un manejador de errores que usa `formErrorResponse`; y src/server.ts que carga el entorno, ejecuta las migraciones (research R12) y arranca en `PORT`
- [ ] T033 Implementar la portada y el estado en src/admin/routes/dashboard.ts (`GET /admin`, `POST /admin/status/activate` → `409` con la lista de avisos que bloquean, `POST /admin/status/deactivate`) con la vista src/admin/views/dashboard.eta (estado "En preparación"/"Activo", lista de avisos, botones de activar/desactivar, accesos a cada sección) y registrar la ruta en src/admin/routes/index.ts
- [ ] T034 [P] Tests de contrato de sesión y estado en tests/contract/auth.test.ts (toda ruta `/admin/*` sin sesión → `302 → /admin/login`; htmx sin sesión → `401` + `HX-Redirect`; `POST` sin token CSRF → `403`; contraseña incorrecta → error genérico; límite de intentos de login) y tests/contract/status.test.ts (activar con `HANDOFF_UNREACHABLE` → `409` y estado `draft`)

**Checkpoint**: el operador puede iniciar sesión, ver la portada con estado y avisos críticos, y
`pnpm kb:snapshot` devuelve el snapshot del negocio vacío. Las historias pueden empezar.

---

## Phase 3: User Story 1 - Registrar datos, horario y servicios de un negocio (Priority: P1) 🎯 MVP

**Goal**: el operador registra datos del negocio, horario semanal, cierres puntuales y
servicios, con validación al guardar, y el bot los recibe en el snapshot sin tocar código.

**Independent Test**: registrar un negocio con datos, horario (L–V 09:00–14:00 y 16:00–20:00, S
10:00–14:00) y tres servicios (fijo, "desde", "a consultar"); `pnpm kb:snapshot` muestra toda la
información, y los datos inválidos (franja 14:00–09:00, precio −5, email `foo@`) se rechazan con
error en el campo (quickstart §2).

### Tests for User Story 1 ⚠️

> Escribir primero y comprobar que fallan.

- [ ] T035 [P] [US1] Tests unitarios del esquema de negocio en tests/unit/schemas/business.test.ts (nombre obligatorio 1–200, dirección ≤ 500, indicaciones ≤ 2000, normalización de teléfono y email, zona horaria y moneda válidas)
- [ ] T036 [P] [US1] Tests unitarios de servicio e importes en tests/unit/schemas/service.test.ts (`price` decimal `"20"`, `"20,50"`, `"20.50"` → céntimos; `-5` → error en `price`; `on_request` fuerza `price_cents = null`; fijo/"desde" sin importe se acepta; `duration` > 0 y ≤ 1440; `bookable` y `active` desde checkbox)
- [ ] T037 [P] [US1] Tests unitarios de reglas temporales en tests/unit/time/intervals.test.ts (día con dos franjas, día cerrado, cierre de día completo el 25/12, cierre parcial 24/12 14:00–20:00 → `isOpenAt(24/12, 17:00) = false` e `isOpenAt(24/12, 10:00) = true`, cierres solapados → unión, cierre de varios días)
- [ ] T038 [P] [US1] Tests unitarios del snapshot de US1 en tests/unit/snapshot/business-services.test.ts (datos del negocio con `null` en campos vacíos, `openingHours`, `closures`, `price` → `fixed`/`from`/`on_request`/`missing`, `bookable` efectivo sin recursos = activo + reservable + con duración, servicios inactivos excluidos, orden por `sort_order`)
- [ ] T039 [P] [US1] Tests de contrato en tests/contract/admin/business.test.ts (`POST /admin/business` válido → `303`; email `foo@` → `422` con error en `email` y nada guardado; teléfono inválido → `422` en `phone`)
- [ ] T040 [P] [US1] Tests de contrato en tests/contract/admin/hours.test.ts (`POST /admin/hours` reemplaza la semana; franja 14:00–09:00 → `422` en `slots[i].end`; franjas solapadas → `422`; `POST /admin/closures` alta, `POST /admin/closures/:id` edición, `POST /admin/closures/:id/delete`; fecha fin anterior → `422` en `end_date`)
- [ ] T041 [P] [US1] Tests de contrato en tests/contract/admin/services.test.ts (alta de los tres tipos de precio → `303`; precio `-5` → `422` en `price`; nombre duplicado sin distinguir mayúsculas → `422` en `name`; `POST /admin/services/reorder`)
- [ ] T042 [P] [US1] Test de integración del flujo completo en tests/integration/us1-register.test.ts: registra datos, horario, cierres y servicios A (fijo 20 €, 30 min, reservable), B ("desde" 40 €, 60 min, reservable) y C (a consultar, no reservable) por el panel y verifica `getSnapshot()` (teléfono `+34600123456`, `handoff.source = "business_phone"`, C sin importe, A y B `bookable = true`)

### Implementation for User Story 1

- [ ] T043 [P] [US1] Implementar `businessSchema` (name, address, directions, phone, email, timezone, currency) en src/knowledge/schemas/business.ts usando src/knowledge/schemas/common.ts
- [ ] T044 [P] [US1] Implementar src/knowledge/money.ts: `parseAmountToCents(input)` (acepta coma o punto, máximo 2 decimales, rechaza negativos) y `formatCents(cents, currency)` para mostrar en formularios y listas
- [ ] T045 [US1] Implementar `serviceSchema` (name 1–200, description ≤ 4000, `price_type`, `price` → `price_cents` con `parseAmountToCents`, `duration` → `duration_minutes`, `bookable`, `active`) en src/knowledge/schemas/service.ts (depende de T044)
- [ ] T046 [P] [US1] Implementar `closureSchema` (extiende `dateRangeBlockSchema` con `reason` ≤ 200) en src/knowledge/schemas/closure.ts
- [ ] T047 [P] [US1] Implementar `effectiveIntervals(slots, blocks, date)` e `isOpenAt(slots, blocks, date, time)` (franjas del día ISO de la fecha menos la unión de bloques que cubren la fecha) en src/knowledge/time/intervals.ts, exportando también `subtractIntervals` y `mergeIntervals`
- [ ] T048 [P] [US1] Implementar el repositorio del negocio (`getBusiness`, `updateBusiness` actualizando `updated_at`) en src/knowledge/repositories/business.ts
- [ ] T049 [P] [US1] Implementar el repositorio de horario (`replaceBusinessHours(tx, slots)`: borra e inserta toda la semana) en src/knowledge/repositories/business-hours.ts
- [ ] T050 [P] [US1] Implementar el repositorio de cierres (`listClosures`, `getClosure`, `createClosure`, `updateClosure`, `deleteClosure`) en src/knowledge/repositories/closures.ts
- [ ] T051 [P] [US1] Implementar el repositorio de servicios (`listServices`, `getService`, `createService` con `sort_order` al final, `updateService`, `deleteService`, `reorderServices(ids)`) en src/knowledge/repositories/services.ts
- [ ] T052 [US1] Implementar los casos de uso `saveBusiness`, `saveBusinessHours`, `createClosure`, `updateClosure`, `deleteClosure` (validan con Zod y escriben dentro de `runGuardedWrite`) en src/knowledge/services/business-info.ts
- [ ] T053 [US1] Implementar los casos de uso `createService`, `updateService`, `deleteService`, `reorderServices` (validación Zod + `runGuardedWrite`; `NotFoundError` si el id no existe) en src/knowledge/services/catalog.ts
- [ ] T054 [US1] Completar `buildSnapshot` en src/knowledge/snapshot.ts con `openingHours`, `closures` y `services` (unión `price` incluido `missing`, `durationMinutes`, `bookable` efectivo según data-model.md para el caso sin recursos, `resourceIds: []`, solo servicios activos)
- [ ] T055 [US1] Crear los parciales reutilizables src/admin/views/partials/weekly-slots.eta (editor de franjas por día con añadir/quitar fila vía htmx y errores por `slots[i]`) y src/admin/views/partials/date-range-form.eta (fechas, horas opcionales y motivo opcional)
- [ ] T056 [US1] Implementar `GET/POST /admin/business` en src/admin/routes/business.ts con la vista src/admin/views/business.eta (errores junto a cada campo, valores introducidos conservados en 422/409)
- [ ] T057 [US1] Implementar `GET /admin/hours`, `POST /admin/hours`, `POST /admin/closures`, `POST /admin/closures/:id` y `POST /admin/closures/:id/delete` en src/admin/routes/hours.ts con la vista src/admin/views/hours.eta (usa los parciales de T055)
- [ ] T058 [US1] Implementar `GET /admin/services`, `GET /admin/services/new`, `GET /admin/services/:id`, `POST /admin/services`, `POST /admin/services/:id`, `POST /admin/services/:id/delete` y `POST /admin/services/reorder` en src/admin/routes/services.ts con las vistas src/admin/views/services/list.eta (estado, precio formateado, duración, reservable) y src/admin/views/services/form.eta (el importe se oculta para "a consultar")
- [ ] T059 [US1] Registrar las rutas de negocio, horario y servicios en src/admin/routes/index.ts y enlazarlas en la navegación de src/admin/views/layout.eta

**Checkpoint**: US1 completa y verificable con quickstart §1 y §2 (MVP).

---

## Phase 4: User Story 2 - Modificar cualquier dato registrado (Priority: P1)

**Goal**: cualquier modificación o eliminación se aplica a la siguiente lectura del bot, sin
reinicio, sin caché y sin despliegue (FR-020, FR-021, SC-003).

**Independent Test**: con el negocio de US1, cambiar el precio de A de 20 € a 25 € y el horario
del lunes; la siguiente llamada a `getSnapshot()` (con un lector creado antes del cambio)
devuelve 2500 céntimos y el horario nuevo; eliminar B lo hace desaparecer (quickstart §3).

### Tests for User Story 2 ⚠️

- [ ] T060 [P] [US2] Test de integración de frescura en tests/integration/freshness.test.ts: crea un `KnowledgeReader` antes de los cambios (simula una conversación abierta), modifica precio y horario de un día por el panel, y comprueba que la siguiente `getSnapshot()` devuelve los valores nuevos; elimina un servicio y comprueba que desaparece
- [ ] T061 [P] [US2] Test de integración de `updated_at` en tests/integration/updated-at.test.ts: cada escritura (negocio, horario, cierre, servicio) actualiza `updated_at` de lo modificado y `snapshot.updatedAt` avanza tras cada guardado
- [ ] T062 [P] [US2] Tests de contrato de edición en tests/contract/admin/edit.test.ts (`GET /admin/services/:id` y el formulario de cierre muestran los valores guardados con el importe formateado; id inexistente → `404`; eliminación solo por `POST …/delete`; un `422` en edición no modifica el dato guardado)

### Implementation for User Story 2

- [ ] T063 [US2] Crear el helper `touch()` (`updated_at = now()`) en src/db/timestamps.ts y aplicarlo a todas las escrituras de src/knowledge/repositories/business.ts, business-hours.ts, closures.ts y services.ts (y en `reorderServices`)
- [ ] T064 [US2] Exponer `updatedAt` en `buildSnapshot` a partir de `state.maxUpdatedAt` en ISO 8601 y añadir en src/knowledge/snapshot.ts un comentario de contrato que prohíbe cachear el snapshot (FR-021)
- [ ] T065 [US2] Precargar los formularios de edición con los valores guardados (importe con `formatCents`, horas `HH:MM`) y devolver src/admin/views/not-found.eta con `404` para ids inexistentes en src/admin/routes/services.ts y src/admin/routes/hours.ts
- [ ] T066 [US2] Crear el parcial src/admin/views/partials/delete-button.eta (formulario `POST …/delete` con `hx-confirm` y CSRF) y usarlo en src/admin/views/services/list.eta y src/admin/views/hours.eta
- [ ] T067 [US2] Mostrar la fecha de última modificación de cada elemento en src/admin/views/business.eta, src/admin/views/services/form.eta y src/admin/views/hours.eta

**Checkpoint**: US1 y US2 funcionan juntas; los cambios se ven en la siguiente lectura.

---

## Phase 5: User Story 3 - Registrar recursos con sus servicios y horarios (Priority: P2)

**Goal**: el operador registra recursos con los servicios que prestan, su horario, sus
ausencias y su estado activo/inactivo; sin recursos, el negocio es agenda única (FR-010 – FR-013).

**Independent Test**: registrar dos recursos con servicios y horarios distintos; el snapshot
pasa a `scheduling.mode = "resources"` y cada recurso lista solo sus servicios; desactivar uno lo
oculta sin perder sus datos (quickstart §4).

### Tests for User Story 3 ⚠️

- [ ] T068 [P] [US3] Tests unitarios en tests/unit/schemas/resource.test.ts (nombre obligatorio 1–200, `service_ids[]` como uuids sin duplicados, ausencia = bloque de fechas sin `reason`)
- [ ] T069 [P] [US3] Tests unitarios del snapshot de recursos en tests/unit/snapshot/scheduling.test.ts (sin recursos → `single_agenda`; con recursos → `resources` y `serviceIds` solo de servicios activos; recurso inactivo excluido; todos inactivos → `resources` con lista vacía y servicios reservables con `bookable = false`; `services[].resourceIds` solo recursos activos)
- [ ] T070 [P] [US3] Tests de contrato en tests/contract/admin/resources.test.ts (alta con servicios → `303`; `service_ids` inexistente → `422` en `service_ids`; `POST /admin/resources/:id/hours` con franja inválida → `422`; alta, edición y borrado de ausencias; `POST /admin/resources/:id/delete`)
- [ ] T071 [P] [US3] Test de integración en tests/integration/resources.test.ts (SC-006: un recurso con A y B no figura para C; borrar un servicio borra sus asociaciones; borrar un recurso borra asociaciones, horario y ausencias; desactivar y reactivar conserva servicios, horario y ausencias)

### Implementation for User Story 3

- [ ] T072 [P] [US3] Implementar `resourceSchema` (name, `service_ids`, active) y `absenceSchema` (reutiliza `dateRangeBlockSchema`) en src/knowledge/schemas/resource.ts
- [ ] T073 [US3] Implementar el repositorio de recursos (`listResources` con servicios asignados, `getResource`, `createResource`, `updateResource`, `setResourceServices` (reemplazo), `replaceResourceHours`, `createAbsence`, `updateAbsence`, `deleteAbsence`, `deleteResource`, comprobación de que todos los `service_ids` existen), usando `touch()`, en src/knowledge/repositories/resources.ts
- [ ] T074 [US3] Implementar los casos de uso de recursos (alta/edición con servicios, horario, ausencias, borrado; validación Zod + `runGuardedWrite`; `FieldConflictError('service_ids')` si un servicio no existe) en src/knowledge/services/resources.ts
- [ ] T075 [US3] Completar `buildSnapshot` en src/knowledge/snapshot.ts: `scheduling` (`single_agenda` solo si no hay ningún recurso registrado, activo o inactivo), recursos activos con `serviceIds`, `hours` y `absences`, `services[].resourceIds` y regla completa de `bookable` efectivo (requiere un recurso activo que lo preste cuando hay recursos)
- [ ] T076 [US3] Implementar las rutas de contracts/admin-panel.md § Recursos en src/admin/routes/resources.ts con las vistas src/admin/views/resources/list.eta (estado y servicios asignados) y src/admin/views/resources/form.eta (checkboxes de servicios activos, interruptor activo, parcial weekly-slots para el horario, lista y formulario de ausencias con date-range-form y delete-button)
- [ ] T077 [US3] Registrar las rutas de recursos en src/admin/routes/index.ts y en la navegación de src/admin/views/layout.eta

**Checkpoint**: US1–US3 funcionan de forma independiente; el snapshot distingue agenda única y recursos.

---

## Phase 6: User Story 4 - Registrar FAQ, políticas, tono y contacto de derivación (Priority: P2)

**Goal**: el operador registra FAQ, políticas (cancelación, antelaciones, formas de pago), tono y
contacto de derivación; el bot los recibe y la salida a una persona queda protegida (FR-014 – FR-019, FR-032).

**Independent Test**: registrar dos FAQ, las políticas (24 h de aviso, antelación 2 h – 30 días,
"Efectivo" y "Tarjeta"), el tono "usted" y un WhatsApp de derivación con horario; el snapshot los
contiene y `handoff.source = "configured"`; una antelación mínima de 31 días se rechaza (quickstart §5 y §6).

### Tests for User Story 4 ⚠️

- [ ] T078 [P] [US4] Tests unitarios en tests/unit/schemas/policies.test.ts (conversión `minutes`/`hours`/`days` a minutos; mínima 31 días y máxima 30 días → error en `min_advance`; valores negativos rechazados; `payment_methods` recortadas, sin vacías ni duplicadas)
- [ ] T079 [P] [US4] Tests unitarios en tests/unit/schemas/faq-tone-handoff.test.ts (FAQ: pregunta 1–500 y respuesta 1–4000; tono: `address_form` obligatorio, estilo ≤ 2000; derivación: `phone`/`whatsapp` en E.164, `email` válido, `(type, value)` duplicado → error en `channels[i].value`, franjas con `weeklySlotsSchema`)
- [ ] T080 [P] [US4] Tests unitarios del snapshot en tests/unit/snapshot/faq-policies-handoff.test.ts (FAQ en orden; políticas y tono `null` si no se han guardado; derivación `configured` con canales ordenados y horario; `business_phone`; `none`)
- [ ] T081 [P] [US4] Tests de contrato en tests/contract/admin/faqs.test.ts y tests/contract/admin/settings.test.ts (`/admin/faqs` alta, edición, borrado y reorden; `/admin/policies` con antelación mínima 3 días y máxima 2 días → `422` en `min_advance`; `/admin/tone`; `/admin/handoff` sin medios elimina el contacto)
- [ ] T082 [P] [US4] Test de integración de protección de la salida a una persona en tests/integration/handoff-protection.test.ts (quickstart §6: negocio activo, borrar el último medio de derivación con teléfono presente → `303` y `HANDOFF_CONTACT_MISSING`; borrar el teléfono del negocio → `409` y teléfono intacto; tras desactivar, el mismo cambio se guarda y aparece `HANDOFF_UNREACHABLE`; el snapshot de un negocio activo nunca tiene `handoff.source = "none"`)

### Implementation for User Story 4

- [ ] T083 [P] [US4] Implementar `faqSchema` en src/knowledge/schemas/faq.ts
- [ ] T084 [P] [US4] Implementar `policiesSchema` (texto de cancelación ≤ 4000, `cancellation_notice`/`min_advance`/`max_advance` + `_unit` convertidos a minutos, regla FR-016 con error en `min_advance`, `payment_methods[]`) en src/knowledge/schemas/policies.ts
- [ ] T085 [P] [US4] Implementar `toneSchema` (`address_form` informal/formal, `style_description`) en src/knowledge/schemas/tone.ts
- [ ] T086 [P] [US4] Implementar `handoffSchema` (`channels[i].type`/`value` con validación según tipo, unicidad `(type, value)`, `slots` con `weeklySlotsSchema`) en src/knowledge/schemas/handoff.ts
- [ ] T087 [P] [US4] Implementar el repositorio de FAQ (`list`, `get`, `create` con `sort_order` al final, `update`, `delete`, `reorder`) con `touch()` en src/knowledge/repositories/faqs.ts
- [ ] T088 [P] [US4] Implementar los repositorios singleton `upsertPolicies`/`getPolicies` en src/knowledge/repositories/policies.ts y `upsertTone`/`getTone` en src/knowledge/repositories/tone.ts
- [ ] T089 [P] [US4] Implementar el repositorio de derivación (`saveHandoff(tx, channels, slots)`: reemplaza medios y horario y crea/actualiza `handoff_contact`; sin medios borra contacto, medios y horario) en src/knowledge/repositories/handoff.ts
- [ ] T090 [US4] Implementar los casos de uso `createFaq`, `updateFaq`, `deleteFaq`, `reorderFaqs` en src/knowledge/services/faqs.ts y `savePolicies`, `saveTone`, `saveHandoff` en src/knowledge/services/settings.ts (validación Zod + `runGuardedWrite`)
- [ ] T091 [US4] Completar `buildSnapshot` en src/knowledge/snapshot.ts con `faqs`, `policies`, `tone` y `handoff` configurado (canales por `sort_order` y `handoff_hours`)
- [ ] T092 [US4] Implementar `GET /admin/faqs`, `POST /admin/faqs`, `POST /admin/faqs/:id`, `POST /admin/faqs/:id/delete` y `POST /admin/faqs/reorder` en src/admin/routes/faqs.ts con la vista src/admin/views/faqs.eta
- [ ] T093 [US4] Implementar `GET/POST /admin/policies` en src/admin/routes/policies.ts con la vista src/admin/views/policies.eta (selector de unidad; al mostrar, usar la mayor unidad exacta: días, horas o minutos; lista editable de formas de pago)
- [ ] T094 [US4] Implementar `GET/POST /admin/tone` en src/admin/routes/tone.ts con la vista src/admin/views/tone.eta
- [ ] T095 [US4] Implementar `GET/POST /admin/handoff` en src/admin/routes/handoff.ts con la vista src/admin/views/handoff.eta (filas de medios con tipo y valor, parcial weekly-slots para el horario, nota de que sin medios se usa el teléfono del negocio, error general `409` visible)
- [ ] T096 [US4] Registrar las rutas de FAQ, políticas, tono y derivación en src/admin/routes/index.ts y en la navegación de src/admin/views/layout.eta

**Checkpoint**: US1–US4 completas; el snapshot tiene todas sus secciones.

---

## Phase 7: User Story 5 - Aviso de datos incompletos (Priority: P3)

**Goal**: el sistema calcula el catálogo completo de avisos de contracts/warnings.md, los muestra
al operador identificando elemento y dato, y desaparecen al corregirlos (FR-025 – FR-027, SC-004).

**Independent Test**: registrar un servicio reservable sin duración y dejar el negocio sin
horario; la portada muestra `SERVICE_DURATION_MISSING` y `BUSINESS_HOURS_MISSING`; completar los
datos los hace desaparecer; el guardado nunca se bloquea por avisos normales.

### Tests for User Story 5 ⚠️

- [ ] T097 [P] [US5] Tests unitarios del catálogo completo en tests/unit/warnings/catalog.test.ts: al menos un caso por código (SC-004), todas las filas de la tabla de ejemplos de contracts/warnings.md, ordenación, exclusión de servicios y recursos inactivos, `RESOURCE_HOURS_OUTSIDE_BUSINESS` no evaluado sin horario del negocio y `details.slots` con la parte fuera de horario (sábado 16:00–18:00)
- [ ] T098 [P] [US5] Tests de contrato en tests/contract/admin/warnings.test.ts (servicio reservable sin duración → `303`, guardado, y `SERVICE_DURATION_MISSING` en `GET /admin`; al añadir la duración desaparece; el contador de la cabecera coincide con la lista; activar con solo avisos normales → estado `active`)

### Implementation for User Story 5

- [ ] T099 [US5] Añadir a `computeWarnings` en src/knowledge/warnings.ts los avisos de servicio `SERVICE_DURATION_MISSING` (target `service`, field `duration`) y `SERVICE_PRICE_MISSING` (field `price`), solo para servicios activos
- [ ] T100 [US5] Añadir a src/knowledge/warnings.ts `BUSINESS_HOURS_MISSING` (target `business`, field `hours`) y `SERVICE_WITHOUT_RESOURCE` (existe algún recurso registrado y un servicio activo reservable no lo presta ningún recurso activo; field `resources`)
- [ ] T101 [US5] Añadir a src/knowledge/warnings.ts `RESOURCE_HOURS_OUTSIDE_BUSINESS` usando `subtractIntervals` de src/knowledge/time/intervals.ts para calcular, por día, las partes de cada franja del recurso fuera de las franjas del negocio (`details.slots`), omitiéndolo si falta el horario del negocio
- [ ] T102 [US5] Crear el parcial src/admin/views/partials/warnings-list.eta (gravedad, elemento, dato y mensaje, con enlace a la pantalla del elemento según `target.kind`/`target.id`) y usarlo en src/admin/views/dashboard.eta y en la respuesta `409` de activación
- [ ] T103 [US5] Mostrar los avisos de cada elemento en su lista y formulario: src/admin/views/services/list.eta, src/admin/views/services/form.eta, src/admin/views/resources/list.eta, src/admin/views/resources/form.eta y src/admin/views/handoff.eta (filtrando `computeWarnings` por `target`)
- [ ] T104 [US5] Asegurar en src/admin/render.ts que toda respuesta htmx de guardado refresca el contador de avisos y, si está presente, la lista (`hx-swap-oob` de partials/warnings-count.eta y partials/warnings-list.eta)

**Checkpoint**: todas las historias funcionan de forma independiente.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: neutralidad sectorial, rendimiento, forma del contrato, despliegue y validación final.

- [ ] T105 [P] Crear fixtures de tres sectores (clínica, peluquería y taller: datos, horario, servicios, recursos, FAQ, políticas, tono, derivación) en tests/fixtures/clinic.ts, tests/fixtures/hair-salon.ts y tests/fixtures/workshop.ts, con un cargador que usa los casos de uso del dominio en tests/fixtures/load.ts
- [ ] T106 Test de neutralidad sectorial (SC-005, FR-024, Principio I) en tests/integration/sector-neutrality.test.ts (los tres fixtures se cargan con el mismo modelo y producen snapshots válidos) y tests/unit/sector-neutrality.test.ts (recorre `src/` y falla si encuentra nombres de sector o cliente como `clínica`, `clinic`, `peluquer`, `taller`, `inmobiliaria`, `dentist`, `salon`)
- [ ] T107 [P] Test de forma del contrato en tests/contract/snapshot-shape.test.ts: esquema Zod estricto de `KnowledgeSnapshot` (en el propio test) que valida la salida de `getSnapshot()` con la instancia vacía y con cada fixture, sin campos extra ni `undefined`
- [ ] T108 [P] Test de rendimiento en tests/integration/performance.test.ts: con 100 servicios, 20 recursos y 100 FAQ, `getSnapshot()` p95 < 50 ms y `POST /admin/services/:id` p95 < 300 ms
- [ ] T109 [P] Crear el Dockerfile multi-etapa (build con pnpm, imagen final Node 22 slim sin devDependencies, ejecuta migraciones y arranca `dist/server.js`) en Dockerfile
- [ ] T110 [P] Documentar puesta en marcha, variables de entorno y comandos (enlazando specs/001-business-knowledge-base/quickstart.md) en README.md
- [ ] T111 Revisión de seguridad del panel en src/app.ts y src/admin/auth/plugin.ts: cabeceras `X-Frame-Options: DENY`, `Content-Security-Policy` restrictiva (htmx servido localmente), `Referrer-Policy`, `Cache-Control: no-store` en `/admin`, logs sin contraseñas ni cookies; ejecutar el agente `security-auditor` sobre `src/admin` y corregir hallazgos
- [ ] T112 Ejecutar `pnpm lint`, `pnpm typecheck` y `pnpm test` y corregir hasta tener todo en verde
- [ ] T113 Ejecutar los escenarios manuales 1–8 de specs/001-business-knowledge-base/quickstart.md contra `pnpm dev` y anotar el resultado de cada uno

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias.
- **Foundational (Phase 2)**: depende de Setup; BLOQUEA todas las historias.
- **US1 (Phase 3)**: depende de Foundational.
- **US2 (Phase 4)**: depende de US1 (modifica y elimina lo que US1 crea).
- **US3 (Phase 5)**: depende de Foundational; usa servicios de US1 para las asociaciones (los tests crean servicios mediante los casos de uso de US1).
- **US4 (Phase 6)**: depende solo de Foundational (la protección de T082 usa `saveBusiness` de US1 para borrar el teléfono).
- **US5 (Phase 7)**: depende de Foundational; los avisos de servicio y recurso se prueban con estados en memoria, y la integración en pantallas (T103) necesita las vistas de US1, US3 y US4.
- **Polish (Phase 8)**: depende de todas las historias.

### User Story Dependencies

```text
Setup → Foundational ─┬─ US1 (P1) ─┬─ US2 (P1)
                      │            └─ US3 (P2) ─┐
                      ├─ US4 (P2) ──────────────┼─ US5 (P3) → Polish
                      └─────────────────────────┘
```

### Within Each User Story

- Tests primero (deben fallar), después esquemas → repositorios → casos de uso → snapshot → rutas y vistas → registro en navegación.
- `src/knowledge/snapshot.ts`, `src/knowledge/warnings.ts`, `src/admin/routes/index.ts` y `src/admin/views/layout.eta` se amplían en varias historias: esas tareas no son paralelas entre historias.

### Parallel Opportunities

- Setup: T002–T007 en paralelo tras T001.
- Foundational: T012–T016 en paralelo; T021, T024, T026, T027, T030 y T034 en paralelo cuando existen sus dependencias.
- US1: tests T035–T042 en paralelo; T043, T044, T046–T051 en paralelo.
- US3 y US4 pueden desarrollarse en paralelo por personas distintas tras US1 (salvo los ficheros compartidos citados arriba).
- US4: tests T078–T082 en paralelo; T083–T089 en paralelo.
- Polish: T105, T107–T110 en paralelo.

---

## Parallel Example: User Story 1

```bash
# Tests de US1 a la vez:
Task: "Tests unitarios del esquema de negocio en tests/unit/schemas/business.test.ts"
Task: "Tests unitarios de servicio e importes en tests/unit/schemas/service.test.ts"
Task: "Tests unitarios de reglas temporales en tests/unit/time/intervals.test.ts"
Task: "Tests de contrato en tests/contract/admin/hours.test.ts"

# Esquemas, reglas temporales y repositorios a la vez:
Task: "businessSchema en src/knowledge/schemas/business.ts"
Task: "effectiveIntervals e isOpenAt en src/knowledge/time/intervals.ts"
Task: "Repositorio de cierres en src/knowledge/repositories/closures.ts"
Task: "Repositorio de servicios en src/knowledge/repositories/services.ts"
```

## Parallel Example: User Story 4

```bash
Task: "policiesSchema en src/knowledge/schemas/policies.ts"
Task: "handoffSchema en src/knowledge/schemas/handoff.ts"
Task: "Repositorio de FAQ en src/knowledge/repositories/faqs.ts"
Task: "Repositorio de derivación en src/knowledge/repositories/handoff.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1: Setup.
2. Phase 2: Foundational (sesión, BD, guardado protegido, activación, snapshot).
3. Phase 3: US1.
4. **STOP and VALIDATE**: quickstart §1 y §2 y `pnpm test`.
5. Demo: el operador registra un negocio real y `pnpm kb:snapshot` muestra lo que verá el bot.

### Incremental Delivery

1. Setup + Foundational → base lista.
2. US1 → MVP (datos, horario, cierres, servicios).
3. US2 → cambios y eliminaciones con frescura garantizada.
4. US3 → negocios con varias agendas.
5. US4 → FAQ, políticas, tono y derivación configurada (el negocio ya puede activarse con salida propia).
6. US5 → catálogo completo de avisos.
7. Polish → neutralidad sectorial, rendimiento, despliegue.

### Parallel Team Strategy

1. Todo el equipo: Setup + Foundational.
2. Después: desarrollador A → US1 y luego US2; desarrollador B → US4; tras US1, desarrollador C → US3.
3. US5 al final, cuando existen las vistas donde mostrar los avisos.

---

## Notes

- [P] = ficheros distintos y sin dependencias pendientes.
- Toda escritura del panel pasa por `runGuardedWrite` (FR-032); ningún caso de uso escribe fuera de él.
- El bot solo lee mediante `KnowledgeReader.getSnapshot()`; ningún módulo cachea el snapshot.
- Ningún fichero de `src/` puede contener nombres de sectores o clientes (T106 lo comprueba).
- Hacer commit tras cada tarea o grupo lógico y parar en cada checkpoint para validar la historia.
