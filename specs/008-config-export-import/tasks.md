---

description: "Lista de tareas de la feature 008: exportar e importar la configuración del negocio"
---

# Tasks: Exportar e importar la configuración del negocio

**Input**: documentos de diseño de `/specs/008-config-export-import/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Ámbito**: Núcleo

**Tests**: se incluyen. El plan fija las suites `unit` (esquema v1 con cada regla y cada diferencia
◆, campos desconocidos, sobre y versiones, BOM, JSON ilegible, traducción de errores, serialización
canónica, diff, huella, cobertura de columnas, pendientes, catálogo del registro), `contract`
(`fastify.inject`: sesión, CSRF, exportación, 400/413/422/404/409, vista previa sin cambios,
confirmación, cancelación, resultado, configuración anterior, registros sin datos) e `integration`
(Testcontainers: SC-001 a SC-005, SC-007, FR-018, FR-019, UUID conservados, bot con lo importado).
No hay tests `eval`: la cadena de respuesta no cambia. Los tests de cada historia se escriben
primero y deben fallar antes de implementar.

**Organization**: por historia de usuario. La fase fundacional deja preparados la tabla
`config_pre_import`, los esquemas de campo extraídos del dominio, el formato (tipos, esquema
estricto, análisis del fichero, serialización canónica y huella), la lectura del estado a
documento, los errores, el catálogo del registro, los ficheros de ejemplo, los helpers de test y
la página `/admin/config` vacía con su entrada de navegación. Cada historia añade después su
servicio, sus rutas, sus vistas y sus pruebas.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede hacer en paralelo (ficheros distintos, sin dependencias pendientes)
- **[Story]**: historia a la que pertenece (US1…US3)
- Rutas desde la raíz del repositorio (proyecto único: `src/`, `tests/`)

## Reglas que aplican a todas las tareas

- `src/config-transfer` es un módulo de dominio **sin HTTP**: no importa Fastify ni nada de
  `src/admin` ni `src/channels`. Lee y escribe la BD con los repositorios y la escritura protegida
  de `src/knowledge` y con `readWebChatSettings`/`saveWebChatSettings` de `src/webchat/settings.ts`
  y `readHandoffAlerts`/`saveHandoffAlerts` de `src/handoff/settings.ts`.
- `schema.ts`, `parse.ts`, `canonical.ts` y `diff.ts` son **puras** (sin BD ni reloj implícito:
  la hora y el `INSTANCE_ID` se reciben como parámetros).
- La validación **reutiliza los primitivos del dominio** (R3): nada de reglas copiadas. Las únicas
  diferencias con el panel son las tres ◆ de
  [contracts/config-file-format.md](contracts/config-file-format.md).
- La importación **nunca** cambia `business.status` ni `web_chat_settings.enabled` (FR-017), y
  cambia `handoff_alerts` solo si el fichero trae `alertDestinations` **y** el operador lo eligió
  (FR-021).
- La vista previa nunca confirma una transacción (FR-014). La confirmación va entera en una sola
  transacción de `runTrackedWrite` (FR-015, FR-032): huella → chat web → configuración anterior →
  reemplazo.
- Los registros `config_*` solo llevan números, booleanos, códigos del catálogo y el
  `INSTANCE_ID` validado con `INSTANCE_ID_PATTERN` (FR-024,
  [contracts/transfer-log.md](contracts/transfer-log.md)). Ningún nombre, pregunta, texto,
  teléfono, correo, web ni contenido del fichero en registros, mensajes de error técnicos ni
  excepciones propagadas.
- Todas las rutas nuevas cuelgan del contexto del operador de `src/app.ts` (`requireOperator` +
  `csrfOnPost`); `@fastify/multipart` se registra **solo** en el contexto encapsulado de
  `POST /admin/config/import` (R5). El resto del panel sigue con urlencoded de 256 KiB.
- En `src/` no puede haber nombres ni lógica de sector o cliente (FR-025). Ejemplos genéricos
  ("Negocio de ejemplo", "Servicio A") y ficheros de ejemplo solo en `tests/fixtures/`.
- Migración `0005_config_transfer` de **solo añadir**; las publicadas no se tocan.
- Textos, comentarios y mensajes en español.

---

## Phase 1: Setup (infraestructura compartida)

**Purpose**: dependencia nueva y cobertura de los tests transversales.

- [ ] T001 Añadir la dependencia `@fastify/multipart` (versión compatible con Fastify 5) a `package.json` con `pnpm add @fastify/multipart` y comprobar que `pnpm typecheck` sigue pasando (R5)
- [ ] T002 [P] Ampliar `tests/unit/sector-neutrality.test.ts` con una aserción de que el recorrido incluye `src/config-transfer/` y `src/admin/views/config/` cuando existen (FR-025)
- [ ] T003 [P] Ampliar `tests/unit/isolation.test.ts` con la regla de que ningún fichero de `src/config-transfer/` importa `fastify`, `@fastify/*`, `src/admin` ni `src/channels`, y de que `@fastify/multipart` solo se importa desde `src/admin/routes/config.ts`

---

## Phase 2: Foundational (prerrequisitos bloqueantes)

**Purpose**: tabla nueva, esquemas de campo reutilizables, formato del fichero (tipos, esquema,
análisis, serialización canónica y huella), lectura del estado a documento, errores, registro,
ficheros de ejemplo, helpers de test y la página vacía del panel.

**⚠️ CRITICAL**: ninguna historia puede empezar hasta terminar esta fase.

### Datos de prueba (primero: los usan todos los tests)

- [ ] T004 [P] Crear los ficheros de ejemplo en `tests/fixtures/config/`, con nombres y valores genéricos: `valid-full.json` (todas las secciones del ejemplo de [contracts/config-file-format.md](contracts/config-file-format.md), con dos servicios, un recurso que presta uno, dos preguntas, cierres con y sin horas, derivación con canales y horario, chat web con una web y enlace de privacidad), `valid-full-with-alerts.json` (el mismo con `includesAlertDestinations: true` y `alertDestinations`), `valid-empty.json` (instancia recién migrada: `business.name: ""`, listas vacías, `policies`/`tone`/`handoff` a `null`, `webChat` por defecto) y `valid-bom.json` (igual que `valid-full.json` con BOM UTF-8)
- [ ] T005 [P] Crear `tests/helpers/config-transfer.ts` con: `seedFullBusiness(db, { status?, webChatEnabled?, alerts? })` que registra por los servicios del dominio el mismo negocio que `valid-full.json`; `seedCustomerData(db)` con clientes, conversaciones, mensajes, derivaciones, avisos enviados y uso del chat web de todos los canales, devolviendo la lista de valores sensibles (números, nombres, textos, identificadores); `configTablesFingerprint(db)` (hash de todas las filas de las tablas de configuración, `web_chat_settings`, `handoff_alerts` y `config_pre_import`, ordenadas); `buildLargeDocument({ services: 200, resources: 50, faqs: 200 })` (recursos con ~10 franjas y ~20 servicios); y `loadFixture(name)` que lee `tests/fixtures/config/<name>` como `Buffer`

### Tests fundacionales (escribir primero, deben fallar)

- [ ] T006 [P] Crear `tests/unit/config-transfer/canonical.test.ts`: `serializeConfigFile(envelope, doc)` produce JSON con sangría de 2, claves en el orden del contrato (sobre y cada sección, también en objetos anidados), `alertDestinations` al final solo con `includesAlertDestinations: true`, salto de línea final y sin BOM; dos llamadas con el mismo documento dan bytes idénticos salvo `exportedAt`; `configFileName(instanceId | null, date)` → `configuracion-<id|instancia>-<AAAAMMDD-HHMM>.json` en UTC; `preImportFileName(date)` → `configuracion-anterior-<AAAAMMDD-HHMM>.json`; `configFingerprint({ document, businessStatus, webChatEnabled })` es SHA-256 hex determinista, no depende de `exportedAt` ni `source`, y cambia al cambiar un campo cualquiera, al quitar un elemento de una lista, al cambiar `businessStatus`, `webChatEnabled` o `alertDestinations`, y al reordenar una lista (R9)
- [ ] T007 [P] Crear `tests/unit/config-transfer/schema.test.ts` (base): `valid-full.json`, `valid-full-with-alerts.json` y `valid-empty.json` se aceptan y devuelven un `ConfigDocument` con los valores del dominio (email en minúsculas, orígenes normalizados); una clave desconocida en el sobre, en `source`, en `info`, en cada sección y en un elemento de lista es error con su ruta (FR-010); `includesAlertDestinations: true` sin `alertDestinations` y al revés son error; `info.businessStatus` fuera de `draft`/`active` es error
- [ ] T008 [P] Crear `tests/unit/config-transfer/parse.test.ts`: `parseConfigFile(bytes, { currentVersion, updaters })` acepta y descarta el BOM (`valid-bom.json`); bytes que no son JSON → un único `ImportIssue` `section: 'file'` con código `unreadable`; JSON sin sobre o con `format` distinto → `not_export`; `formatVersion: 99` → `future_version` con `source.schema` en el mensaje ("actualiza esta instancia a un núcleo con la migración … o posterior"); `formatVersion: 0` o no entero → `unsupported_version`; con una cadena de actualizadores de prueba `v0 → v1` inyectada, un fichero v0 se actualiza y se valida con el esquema actual; con errores de validación devuelve **todos** los `ImportIssue` a la vez, cada uno con `section`, `sectionLabel`, `item` (nombre o pregunta del elemento entre « », o `n.º N` si no lo tiene, o `null` en filas únicas), `field` y `message` en español, en el orden del fichero
- [ ] T009 [P] Crear `tests/unit/config-transfer/column-coverage.test.ts` (R4): recorre las columnas de las tablas de configuración de `src/db/schema.ts` (`business`, `business_hours`, `closure`, `service`, `resource`, `resource_service`, `resource_hours`, `resource_absence`, `faq`, `policies`, `tone`, `handoff_contact`, `handoff_channel`, `handoff_hours`, `web_chat_settings`, `handoff_alerts`) y comprueba que cada una está en el mapa de cobertura exportado por `src/config-transfer/format.ts` o en su lista explícita de excluidas (`id`, `updated_at`, `sort_order`, `status`, `enabled`, claves ajenas…); una columna sin tratar hace fallar el test con un mensaje que recuerda subir `formatVersion` y añadir el actualizador
- [ ] T010 [P] Crear `tests/unit/config-transfer/log.test.ts`: cada función del catálogo de `src/config-transfer/log.ts` (`configExported`, `configImportPreviewed`, `configImportApplied`, `configImportRejected`, `configImportCancelled`) produce exactamente los campos de [contracts/transfer-log.md](contracts/transfer-log.md) con `channel: 'config'` y el nivel indicado; `sourceInstance` que no cumple `INSTANCE_ID_PATTERN` sale como `null`; `reason` y `stage` fuera del catálogo no compilan (test de tipos con `// @ts-expect-error`); `countsOf(doc)` y `changesOf(diff)` devuelven solo números
- [ ] T011 [P] Crear `tests/integration/config-transfer/read.test.ts` (Testcontainers): con `seedFullBusiness`, `readConfigDocument(tx, { includeAlerts: false })` devuelve un documento que, serializado, es igual a `valid-full.json` salvo el sobre; conserva el orden de servicios, recursos y preguntas por `sort_order` y el de las franjas día → inicio; `resources[].services` son nombres en el orden de los servicios; `policies`/`tone`/`handoff` a `null` sin fila; `includeAlerts: true` añade `alertDestinations`; `readConfigInfo(tx)` devuelve `businessStatus` y `webChatEnabled`; en una BD recién migrada devuelve el equivalente de `valid-empty.json`
- [ ] T012 [P] Crear `tests/contract/admin/config.test.ts` (base): `GET /admin/config` sin sesión → 302 al login y con htmx 401 + `HX-Redirect`; con sesión → 200 con `Cache-Control: no-store`; la navegación del layout de cualquier página del panel contiene "Exportar e importar" → `/admin/config`

### Implementation for Foundational

- [ ] T013 Añadir la tabla `configPreImport` a `src/db/schema.ts` (`id smallint` PK default 1 con `check (id = 1)`, `content text not null`, `imported_at timestamptz not null`, `source_instance text` null) **sin** incluirla en `allTableNames` ni en `conversationTableNames`, y generar con drizzle-kit la migración `src/db/migrations/0005_config_transfer.sql` con su `meta/0005_snapshot.json` y la entrada en `meta/_journal.json`; revisar que el SQL solo añade (data-model §3)
- [ ] T014 [P] Extraer como esquemas de campo exportados, sin cambiar el comportamiento del panel, las reglas hoy embebidas en los esquemas de formulario que necesita el fichero (R3): duración 1–1440 y límites de nombre/descripción de servicio en `src/knowledge/schemas/service.ts`; límites de pregunta/respuesta en `src/knowledge/schemas/faq.ts`; minutos y forma de pago en `src/knowledge/schemas/policies.ts`; `addressForm` y descripción en `src/knowledge/schemas/tone.ts`; tipos de medio y valor en `src/knowledge/schemas/handoff.ts`; nombre del recurso en `src/knowledge/schemas/resource.ts`; origen normalizado, enlace de privacidad y topes en `src/webchat/schemas.ts`; destinos en `src/handoff/schemas.ts`. Los tests existentes de `tests/unit/schemas/` y de contrato del panel deben pasar sin cambios
- [ ] T015 [P] Crear `src/config-transfer/format.ts`: `CURRENT_FORMAT_VERSION = 1`, `FORMAT_ID = 'business-config'`, tipos `ConfigDocument`, `ConfigFileEnvelope`, `ConfigInfo`, `ImportIssue`, `SectionKey` y `SECTION_LABELS` en español; `SUPPORTED_VERSIONS` y el tipo de actualizador `(raw: unknown) => unknown` con la cadena `UPDATERS` vacía; el mapa de cobertura de columnas y la lista de excluidas que usa T009; `normalizeKey(text)` (`trim`, espacios colapsados, `toLocaleLowerCase('es')`) para nombres, preguntas y referencias (data-model §1, §2, §4)
- [ ] T016 Crear `src/config-transfer/canonical.ts`: `serializeConfigFile`, `configFileName`, `preImportFileName` y `configFingerprint` con `node:crypto`, construyendo cada objeto en el orden de claves del contrato (T006, R1, R9)
- [ ] T017 Crear `src/config-transfer/schema.ts`: esquema Zod estricto de la versión 1 con `z.strictObject` en todos los niveles, construido con los primitivos de `src/knowledge/schemas/common.ts`, `weekly-slots.ts`, `date-range-block.ts` y los esquemas extraídos en T014 (región de teléfono de la configuración del núcleo como parámetro), las tres diferencias ◆ y las reglas entre elementos: nombres de servicio y recurso únicos por `normalizeKey`, `resources[].services[]` resueltos contra los servicios del fichero y sin repetir, medios de derivación y formas de pago sin repetir, `monthlyCap ≥ dailyCap`, `minAdvance ≤ maxAdvance`, `priceCents` `null` con `on_request`, `includesAlertDestinations` ⇔ `alertDestinations` (T007)
- [ ] T018 Crear `src/config-transfer/parse.ts`: `parseConfigFile(bytes, options)` → `{ ok: true, envelope, document } | { ok: false, issues }` con el orden BOM → `JSON.parse` → sobre → versión → actualizadores → esquema, y la traducción de los errores de Zod a `ImportIssue` (sección, elemento por nombre/pregunta o posición, campo, mensaje del panel cuando la regla es la misma) (T008, R3, R4)
- [ ] T019 [P] Crear `src/config-transfer/errors.ts`: `ConfigChangedError`, `WebChatWouldBreakError` (con `missing: 'origins' | 'privacyUrl'`) e `ImportRejected` (con `reason` del catálogo de rechazos y `issues?`), sin textos de la configuración en sus mensajes
- [ ] T020 Crear `src/config-transfer/read.ts`: `readConfigDocument(tx, { includeAlerts })` sobre `loadKnowledgeState(tx)` más `readWebChatSettings` y `readHandoffAlerts`, y `readConfigInfo(tx)`, mapeando filas a la forma del dominio del contrato (T011, data-model §1)
- [ ] T021 [P] Crear `src/config-transfer/log.ts` con el catálogo cerrado de [contracts/transfer-log.md](contracts/transfer-log.md): funciones tipadas que reciben un `FastifyBaseLogger`-compatible (interfaz mínima `{ info, warn }` definida en el módulo, sin importar Fastify), `countsOf(doc)` y `changesOf(diff)` (T010, R12)
- [ ] T022 Crear `src/admin/routes/config.ts` con `configRoutes` y `GET /admin/config` que renderiza `src/admin/views/config/index.eta` (título, bloques vacíos de exportar, importar y configuración anterior); registrar `configRoutes` en `src/admin/routes/index.ts` y añadir la entrada "Exportar e importar" → `/admin/config` en `src/admin/views/layout.eta` (T012, contracts/admin-config-transfer.md)

**Checkpoint**: formato, validación, lectura y página vacía listos; `pnpm test:unit config-transfer` y los tests base pasan.

---

## Phase 3: User Story 1 - El operador exporta la configuración del negocio (Priority: P1) 🎯 MVP

**Goal**: desde `/admin/config`, el operador descarga un fichero JSON con toda la configuración del
negocio, con o sin destinos de avisos, sin ningún dato de clientes finales, uso ni secretos.

**Independent Test**: en una instancia con un negocio completo y conversaciones de todos los
canales, exportar con y sin la casilla y comprobar que el fichero contiene toda la configuración,
que `alertDestinations` solo aparece con la casilla y que no aparece ningún dato de clientes.

### Tests for User Story 1 ⚠️

- [ ] T023 [P] [US1] Ampliar `tests/contract/admin/config.test.ts` con la exportación: `GET /admin/config` muestra el formulario con la casilla `include_alerts` desmarcada y el texto "El fichero no incluye conversaciones, clientes ni secretos de la instancia"; `POST /admin/config/export` sin CSRF → rechazo como el resto del panel; con CSRF → 200, `application/json; charset=utf-8`, `Content-Disposition: attachment; filename="configuracion-<id>-<AAAAMMDD-HHMM>.json"` (y `instancia` sin `INSTANCE_ID`), cuerpo que `parseConfigFile` acepta, `includesAlertDestinations: false` y sin `alertDestinations`; con `include_alerts=on` → los contiene; con el negocio en preparación y con avisos críticos también responde 200 (US1-4); se emite `config_exported` con `includesAlerts` y `counts`
- [ ] T024 [P] [US1] Crear `tests/integration/config-transfer/privacy.test.ts` (SC-003): con `seedFullBusiness` + `seedCustomerData`, la exportación sin casilla no contiene ninguno de los valores sensibles devueltos por el helper, ni los destinos de avisos, ni recuentos de uso, ni el valor de ninguna variable de entorno de la instancia de prueba (`SESSION_SECRET`, `BACKUP_KEY`, credenciales…); con casilla, solo añade los destinos; `info` refleja `businessStatus` y `webChatEnabled`

### Implementation for User Story 1

- [ ] T025 [US1] Crear `src/config-transfer/service.ts` con `exportConfig(db, { includeAlerts, instanceId, now, schemaLabel })` → `{ fileName, content, counts }`: lee documento e información en una transacción de solo lectura, construye el sobre (`source.schema` = última migración de `installedSchema()` de `src/backup/schema-version.ts`) y serializa con `canonical.ts` (FR-001–FR-006)
- [ ] T026 [US1] Añadir `POST /admin/config/export` a `src/admin/routes/config.ts` (lee `include_alerts` con el helper de casillas de `src/admin/form-parse.ts`, responde el fichero con las cabeceras del contrato y `Cache-Control: no-store`, registra `configExported`) y completar el bloque **Exportar** de `src/admin/views/config/index.eta` (T023)

**Checkpoint**: el operador descarga una copia legible de la configuración; SC-003 verificado.

---

## Phase 4: User Story 2 - El operador importa un fichero con vista previa y confirmación (Priority: P1)

**Goal**: el operador sube un fichero válido, ve por sección lo que se añade, cambia y elimina,
los avisos resultantes y si se aplicará; al confirmar se reemplaza todo en una transacción, sin
tocar el estado del negocio ni del chat web, guardando antes la configuración anterior para poder
deshacer.

**Independent Test**: exportar la configuración de una instancia de pruebas, importarla en otra
con una configuración distinta, revisar la vista previa, confirmar y comprobar que la
configuración del destino es igual a la exportada salvo el estado del negocio, el del chat web y
los destinos de avisos no elegidos; y que la configuración anterior se puede descargar.

### Tests for User Story 2 ⚠️

- [ ] T027 [P] [US2] Crear `tests/unit/config-transfer/diff.test.ts` (R8): documentos iguales → sin secciones ("igual a la actual"); servicios y recursos emparejados por `normalizeKey(name)` (cambio solo de mayúsculas o espacios = modificado, no borrado + alta); preguntas por pregunta normalizada y, entre repetidas, por orden; cierres y ausencias por fechas y horas con `reason` como campo; medios de derivación por tipo+valor; franjas comparadas por día ("lun 09:00–14:00 → lun 09:00–13:30"); filas únicas campo a campo con `before`/`after` formateados (importes con la moneda, minutos en la mayor unidad exacta como en el panel); `null` ↔ objeto en `policies`/`tone`/`handoff`; `reordered` sin otros cambios; destacados `timezoneChanged`, `currencyChanged`, `sameInstance` (`true`/`false`/`null`), `alertDestinationsIncluded` y, con el chat web del destino activado, `webChat.removedOrigins`, `addedOrigins` y `capsChanged`
- [ ] T028 [P] [US2] Crear `tests/unit/config-transfer/pending.test.ts` (R10): `PendingImports` con reloj inyectable crea identificadores de 128 bits en base64url; `get(id, epoch)` devuelve `undefined` con otra época o a los 30 min; la sexta entrada desplaza a la más antigua y avisa por el callback `onExpire` con `reason: 'expired'`; `remove(id)` la elimina; `markApplied(id, result)` guarda el resultado y la entrada ya no admite otra confirmación (`canApply` falso) pero sí `getResult`; `markPreviewed(id)` devuelve `true` solo la primera vez
- [ ] T029 [P] [US2] Crear `tests/integration/config-transfer/preview-write.test.ts` (R6): `previewWrite(db, fn)` ejecuta `fn`, devuelve estado antes, después, avisos y `blocked` (negocio activo con crítico) y **nunca** confirma: `configTablesFingerprint` y `max(updated_at)` idénticos antes y después, también si `fn` lanza; toma el bloqueo del negocio (un `runGuardedWrite` simultáneo espera a que termine)
- [ ] T030 [P] [US2] Crear `tests/integration/config-transfer/replace.test.ts` (R7): `replaceConfig(tx, doc, { importAlerts })` sobre `seedFullBusiness` conserva el UUID de servicios, recursos y preguntas emparejados, borra los ausentes e inserta los nuevos; `sort_order` = posición en el fichero; sustituye enlaces recurso–servicio, franjas, ausencias, horario, cierres y medios de derivación; `null` en `policies`/`tone`/`handoff` borra su fila; no cambia `business.status` ni `web_chat_settings.enabled`; `handoff_alerts` solo cambia con `importAlerts: true` y `alertDestinations` en el documento; un segundo `replaceConfig` con el mismo documento no cambia ningún `updated_at`; renombrar A→B y B→A en el mismo fichero no choca con los índices únicos
- [ ] T031 [P] [US2] Crear `tests/integration/config-transfer/round-trip.test.ts`: SC-001 (exportar `seedFullBusiness` de una BD e importar en otra recién migrada → `getSnapshot()` de las dos igual salvo identificadores y marcas de tiempo, con el helper de `tests/helpers/snapshot.ts`); SC-002 (exportar e importar en la misma BD → vista previa sin cambios, `sameInstance: true` con el mismo `INSTANCE_ID`, y tras aplicar `configTablesFingerprint` de las tablas de configuración igual salvo `config_pre_import`); importar `valid-empty.json` elimina todo lo del destino (US1-4, lista vacía)
- [ ] T032 [P] [US2] Crear `tests/integration/config-transfer/status.test.ts` (SC-004, FR-017): en preparación ← fichero de activo y activo ← fichero de preparación, chat web desactivado ← fichero con chat activado y al revés: estado del negocio y `enabled` idénticos antes y después; conversaciones, derivaciones en curso y uso del chat web intactos (`seedCustomerData`)
- [ ] T033 [P] [US2] Crear `tests/integration/config-transfer/critical.test.ts` (FR-018): negocio activo + fichero sin teléfono ni derivación → la vista previa da `blocked_critical` con el aviso, y `applyImport` rechaza con `CriticalWarningError` sin cambiar nada (`configTablesFingerprint` igual, `config_pre_import` sin cambiar); el mismo fichero en preparación se aplica; chat web activado + fichero con `allowedOrigins: []` o `privacyUrl: null` → `blocked_web_chat` y `WebChatWouldBreakError` sin cambios
- [ ] T034 [P] [US2] Crear `tests/integration/config-transfer/concurrent.test.ts` (FR-019): vista previa → cambio de una pregunta (o del estado del negocio, o de `web_chat_settings`, o de `handoff_alerts`) por los servicios del panel → `applyImport` con la huella de la vista previa rechaza con `ConfigChangedError` sin cambiar nada; borrar una pregunta también se detecta
- [ ] T035 [P] [US2] Crear `tests/integration/config-transfer/apply.test.ts` (FR-015, FR-020–FR-022, SC-005): aplicar guarda en `config_pre_import` la exportación anterior **con** destinos de avisos, la hora y el origen, y la siguiente importación la sustituye; con un fallo inyectado a mitad de `replaceConfig` (dependencia de prueba que lanza tras los servicios) no queda nada aplicado y `config_pre_import` sigue como estaba; importar el fichero de `config_pre_import` con destinos elegidos deja la configuración como antes de la primera importación (US2-9); el resultado devuelve el diff aplicado y los avisos vigentes
- [ ] T036 [P] [US2] Crear `tests/integration/config-transfer/bot.test.ts` (FR-020, Principio IV): tras aplicar, la siguiente respuesta del bot con el modelo de prueba de `tests/helpers/bot.ts` recibe en su contexto los servicios, precios y preguntas importados y ninguno de los eliminados
- [ ] T037 [P] [US2] Crear `tests/contract/admin/config-import.test.ts`: `POST /admin/config/import` multipart con `valid-full.json` y `_csrf` → 303 a `/admin/config/import/<id>`, sin CSRF → rechazo; la vista previa (`GET`) muestra metadatos, cambios por sección, avisos y "Se aplicará", no cambia la BD (`configTablesFingerprint`), responde 404 con "La importación ha caducado; vuelve a subir el fichero" para un id inexistente, caducado o de otra sesión (época distinta); con `valid-full-with-alerts.json` muestra el aviso de destinos y la casilla desmarcada salvo `?alerts=1`, con `hx-get` + `hx-trigger="change"` y el botón "Actualizar vista previa"; el botón de confirmar está deshabilitado con resultado previsto de rechazo; `POST …/apply` → 303 al resultado, 409 con vista previa nueva y "La configuración ha cambiado desde la vista previa…" tras un cambio concurrente, 409 con el motivo en crítico/chat web, 404 si ya se aplicó; `GET …/result` muestra cambios, avisos y enlace a la configuración anterior, 404 sin resultado; `POST …/cancel` → 303 a `/admin/config` con "Importación cancelada; no se ha cambiado nada" y la vista previa pasa a 404; `GET /admin/config/pre-import` → 404 sin copia y 200 con `Content-Disposition` `configuracion-anterior-<AAAAMMDD-HHMM>.json` y el contenido guardado tal cual; `GET /admin/config` muestra la fecha y el origen de la configuración anterior o "Todavía no se ha aplicado ninguna importación"; eventos `config_import_previewed` (una vez por pendiente), `config_import_applied`, `config_import_rejected` (stage `confirm`) y `config_import_cancelled` con sus campos

### Implementation for User Story 2

- [ ] T038 [US2] Añadir `previewWrite(db, fn, opts)` a `src/knowledge/services/guarded-write.ts`: misma secuencia que `guardedTransaction` (bloqueo → estado antes → `fn` → estado después → `computeWarnings`) y `ROLLBACK` siempre (lanzando un error centinela interno que se captura), devolviendo `{ result, before, after, warnings, blocked }` (T029, R6)
- [ ] T039 [US2] Crear `src/config-transfer/replace.ts` con `replaceConfig(tx, doc, { importAlerts })`: emparejamiento por `normalizeKey`, actualización conservando UUID, borrado `WHERE id NOT IN (…)`, inserciones en lote, renombrados sin choque de índices únicos (p. ej. nombres temporales dentro de la transacción o borrado previo de los no emparejados), filas únicas por `UPDATE` o borrado con `null`, sin tocar `status` ni `enabled`, `handoff_alerts` solo con `importAlerts` (T030, R7, R13)
- [ ] T040 [P] [US2] Crear `src/config-transfer/diff.ts` con `diffConfig(before, after, { destinationWebChatEnabled, currency, sameInstance })` → `{ sections: SectionDiff[], highlights }` y los formateadores de valores para la vista, reutilizando `WEEKDAY_SHORT` de `src/knowledge/warnings.ts` y el formato de importes de `src/knowledge/money.ts` (T027, R8)
- [ ] T041 [P] [US2] Crear `src/config-transfer/pending.ts` con la clase `PendingImports` (máximo 5, caducidad 30 min, época de sesión, reloj y generador de identificadores inyectables, callback `onExpire`) (T028, R10)
- [ ] T042 [US2] Añadir a `src/config-transfer/service.ts` `previewImport(db, pending, { includeAlerts, instanceId })` → `ImportPreview` (data-model §5): dentro de `previewWrite`, lee documento actual con destinos e información, calcula `baseFingerprint`, evalúa la condición del chat web, ejecuta `replaceConfig`, lee el documento resultante y calcula el diff; `outcome` `will_apply` \| `blocked_critical` \| `blocked_web_chat` (depende de T038–T040)
- [ ] T043 [US2] Añadir a `src/config-transfer/service.ts` `applyImport(db, pending, { includeAlerts, baseFingerprint, instanceId, now })` con `runTrackedWrite` y el orden huella (`ConfigChangedError`) → chat web (`WebChatWouldBreakError`) → `INSERT … ON CONFLICT (id) DO UPDATE` en `config_pre_import` con la exportación anterior con destinos → `replaceConfig`; devuelve diff aplicado y avisos vigentes; y `readPreImport(db)` → `{ content, importedAt, sourceInstance } | null` (T031–T036, R7, R11)
- [ ] T044 [US2] Añadir a `src/admin/routes/config.ts` el contexto encapsulado de `POST /admin/config/import` con `@fastify/multipart` (`attachFieldsToBody: 'keyValues'`, `files: 1`, `fileSize: 5 MiB`, `fields: 2`, `fieldSize: 1 KiB`, `parts: 3`, `bodyLimit` de ruta 6 MiB), el `_csrf` del cuerpo comprobado por el `csrfOnPost` heredado, `parseConfigFile` y, si es válido, alta en una instancia única de `PendingImports` (decorada en el plugin de rutas, con `onExpire` → `configImportCancelled`) y 303 a la vista previa; el bloque **Importar** de `src/admin/views/config/index.eta` con `enctype="multipart/form-data"`, `accept=".json,application/json"` y el tamaño máximo (R5)
- [ ] T045 [US2] Añadir `GET /admin/config/import/:id` a `src/admin/routes/config.ts` y crear `src/admin/views/config/preview.eta` y `src/admin/views/partials/config-diff.eta`: metadatos (instancia y esquema de origen, fecha, "exportado de esta misma instancia"), destacados, aviso y casilla de destinos con htmx y alternativa sin JS, cambios por sección o "La configuración del fichero es igual a la actual", avisos con los críticos destacados (reutilizando `partials/warnings-list.eta`), resultado previsto, formulario de confirmación con `base`, `include_alerts` y `_csrf` (deshabilitado si hay rechazo) y formulario de cancelar; 404 con enlace a `/admin/config`; `configImportPreviewed` la primera vez (T037)
- [ ] T046 [US2] Añadir `POST /admin/config/import/:id/apply` a `src/admin/routes/config.ts`: 303 al resultado y `markApplied`; `ConfigChangedError` → 409 con vista previa nueva y el mensaje del contrato; `CriticalWarningError`/`WebChatWouldBreakError` → 409 con la vista previa y el motivo; cualquier otro fallo → rechazo `failed` sin cambios; 404 si no existe o ya se aplicó; `configImportApplied` o `configImportRejected` (stage `confirm`) (T037)
- [ ] T047 [US2] Añadir `POST /admin/config/import/:id/cancel`, `GET /admin/config/import/:id/result` y `GET /admin/config/pre-import` a `src/admin/routes/config.ts`; crear `src/admin/views/config/result.eta` (cambios aplicados con `partials/config-diff.eta`, avisos vigentes y enlace a la configuración anterior con la fecha) y completar el bloque **Configuración anterior a la última importación** de `src/admin/views/config/index.eta` con `readPreImport`, incluido el aviso flash de cancelación (T037, FR-022)

**Checkpoint**: exportar en una instancia e importar en otra funciona de extremo a extremo con vista previa, confirmación, cancelación y deshacer; SC-001, SC-002, SC-004 y FR-018/FR-019 verificados.

---

## Phase 5: User Story 3 - El operador ve rechazado un fichero inválido sin que cambie nada (Priority: P2)

**Goal**: un fichero dañado, ajeno, de una versión futura, demasiado grande o con elementos que no
cumplen las reglas se rechaza antes de la vista previa con la lista completa de errores por
sección, elemento y motivo, sin cambiar nada.

**Independent Test**: subir ficheros manipulados (ilegible, sin sobre, versión futura, clave
inventada, precio negativo, referencia rota, > 5 MB, sin fichero) y comprobar el código, el
mensaje y que `configTablesFingerprint` no cambia.

### Tests for User Story 3 ⚠️

- [ ] T048 [P] [US3] Ampliar `tests/unit/config-transfer/schema.test.ts` con **una prueba por regla** de la tabla de [contracts/config-file-format.md](contracts/config-file-format.md): límites de longitud de cada texto, enlaces no `https`, teléfono y email inválidos, zona y moneda inválidas, `weekday` fuera de 1–7, fin ≤ inicio y solapes el mismo día, fechas imposibles y fin < inicio, una sola hora en un cierre, nombres de servicio y recurso repetidos sin distinguir mayúsculas, `resources[].services[]` inexistente o repetido, pregunta o respuesta vacías, `priceCents` negativo, decimal o no `null` con `on_request`, `durationMinutes` 0 y 1441, minutos negativos, máxima 0, mínima > máxima, forma de pago repetida (◆), medio de derivación repetido, más de 10 orígenes, origen con ruta o `http` que no es `localhost`/`127.0.0.1`, origen repetido, topes < 1 y mensual < diario, destinos inválidos; y que `business.name: ""` se acepta (◆); cada caso con el `message` esperado, igual al del panel cuando la regla es la misma
- [ ] T049 [P] [US3] Ampliar `tests/unit/config-transfer/parse.test.ts` con un fichero con varios errores en secciones distintas (p. ej. `priceCents: -1` en «Servicio A» y un recurso que cita un servicio inexistente): devuelve todos, con `item` `«Servicio A»` y `«Recurso 1»`, `field` y `sectionLabel` correctos, y la posición `n.º N` para un elemento sin nombre
- [ ] T050 [P] [US3] Ampliar `tests/contract/admin/config-import.test.ts` con los rechazos de subida: sin fichero → 400 "Elige un fichero exportado desde el panel"; un fichero de 5 MiB + 1 byte → 413 con "El fichero supera el tamaño máximo de 5 MB" sin analizarlo (espía sobre `parseConfigFile`); un `.txt`, un JSON sin sobre, `formatVersion: 99` y un fichero con errores de validación → 422 en la página `/admin/config` con la lista completa agrupada por sección (sección, elemento, campo, motivo); ninguno crea un pendiente ni cambia la BD; cada uno emite `config_import_rejected` con `stage: 'upload'`, el `reason` del catálogo, `issues` con `invalid` y `sourceInstance` cuando se pudo leer; el resto del panel sigue rechazando `multipart/form-data` y cuerpos urlencoded de más de 256 KiB
- [ ] T051 [P] [US3] Crear `tests/integration/config-transfer/rejections.test.ts` (SC-005, US3-4): tras cada rechazo de subida (ilegible, versión futura, inválido, demasiado grande) la configuración, los avisos (`computeWarnings`) y `config_pre_import` del destino son idénticos a los de antes

### Implementation for User Story 3

- [ ] T052 [US3] Ajustar `src/config-transfer/schema.ts` y `src/config-transfer/parse.ts` hasta que pasen T048 y T049 (mensajes del panel, posición `n.º N`, orden de los errores)
- [ ] T053 [US3] Crear `src/admin/views/partials/import-issues.eta` (errores agrupados por `sectionLabel`, con elemento, campo y motivo) e incluirlo en `src/admin/views/config/index.eta`
- [ ] T054 [US3] Completar el manejo de rechazos en `POST /admin/config/import` de `src/admin/routes/config.ts`: fichero ausente → 400; límite de tamaño de `@fastify/multipart` (`RequestFileTooLargeError` o `file.truncated`) → 413 sin analizar; `parseConfigFile` con errores → 422 con la página y la lista; `configImportRejected` (stage `upload`) en todos (T050, T051, FR-008, FR-010)

**Checkpoint**: las tres historias funcionan; ningún fichero inválido cambia nada.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: rendimiento, privacidad de los registros, copias, documentación y validación final.

- [ ] T055 [P] Crear `tests/integration/config-transfer/performance.test.ts` (SC-007): con `buildLargeDocument({ services: 200, resources: 50, faqs: 200 })`, la vista previa y la aplicación tardan cada una < 5 s (y se anota el tiempo; objetivo interno < 1 s) y la exportación del mismo tamaño < 1 s (R13)
- [ ] T056 [P] Crear `tests/contract/admin/config-logs.test.ts` (FR-024): captura los registros de exportar, subir válido e inválido, previsualizar, aplicar, rechazar y cancelar con `seedFullBusiness` + destinos, y comprueba que ningún evento `config_*` contiene nombres, preguntas, respuestas, textos, teléfonos, correos, webs ni el nombre del fichero; solo los campos del catálogo
- [ ] T057 [P] Comprobar en los tests de copias (`tests/integration/backup/backup-restore.test.ts` o el equivalente que compara tablas) que `config_pre_import` entra en la copia y se restaura, y ajustar la lista esperada de tablas si la hay (R11)
- [ ] T058 [P] Actualizar `docs/operacion-multicliente.md`: §1 "Para qué sirve tu localhost" (preparar y probar la configuración y llevarla con el fichero), §2.6 configuración del negocio en producción (exportar en pruebas → importar en producción → revisar vista previa → confirmar; destinos de avisos con la casilla; deshacer con la configuración anterior), §9.1 con la 008 y fecha 2026-09-30, §9.2 reordenada y P2 marcada como hecha; y la regla de que toda spec que añada configuración sube `formatVersion` y añade su actualizador
- [ ] T059 [P] Añadir a "Convenciones" de `CLAUDE.md` la regla "Toda migración que añada o cambie configuración del negocio sube `formatVersion` en `src/config-transfer/format.ts` y añade su actualizador (lo vigila el test de cobertura de columnas)"
- [ ] T060 Avisar al usuario y después actualizar `README.md` con el estado de la 008 y la página **Exportar e importar** del panel (regla de `CLAUDE.md`)
- [ ] T061 Ejecutar `pnpm lint && pnpm typecheck && pnpm test` (unit, contract e integration) y corregir lo que falle; confirmar que los tests existentes del panel y de los esquemas siguen pasando sin cambios en sus expectativas (T014)
- [ ] T062 Recorrer los escenarios 1–10 de [quickstart.md](quickstart.md) con dos instancias locales y anotar cualquier desviación en la guía o en los contratos

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias.
- **Foundational (Phase 2)**: depende de Setup; **bloquea todas las historias**.
- **US1 (Phase 3)**: depende de Foundational.
- **US2 (Phase 4)**: depende de Foundational. Sus tests usan ficheros exportados: con los
  ficheros de `tests/fixtures/config/` no necesita US1, pero la prueba independiente de extremo a
  extremo (exportar → importar) y el deshacer (T035, T047) usan `exportConfig` → conviene terminar
  US1 antes.
- **US3 (Phase 5)**: depende de Foundational y de la ruta de subida de US2 (T044), sobre la que
  añade los rechazos.
- **Polish (Phase 6)**: depende de las tres historias.

### Within Each User Story

- Tests primero; deben fallar antes de implementar.
- Fundacional: T013 (tabla) antes de T020 y de US2; T014 → T017 → T018; T015 antes de T016–T021.
- US2: T038 → T042; T039 → T042/T043; T040 → T042; T041 → T044; T042/T043 → T044 → T045 → T046 → T047.
- US3: T052 → T054; T053 → T054.
- Rutas y vistas del mismo fichero (`src/admin/routes/config.ts`, `index.eta`) en secuencia.

### Parallel Opportunities

- Setup: T002 y T003.
- Fundacional: T004 y T005; todos los tests T006–T012; T014, T015, T019 y T021.
- US1: T023 y T024.
- US2: todos los tests T027–T037; T040 y T041 en paralelo con T038/T039.
- US3: T048–T051.
- Polish: T055–T059.

---

## Parallel Example: User Story 2

```bash
# Tests de US2 a la vez (ficheros distintos):
Task: "diff por secciones en tests/unit/config-transfer/diff.test.ts"
Task: "pendientes en tests/unit/config-transfer/pending.test.ts"
Task: "ensayo con reversión en tests/integration/config-transfer/preview-write.test.ts"
Task: "reemplazo conservando UUID en tests/integration/config-transfer/replace.test.ts"
Task: "SC-001/SC-002 en tests/integration/config-transfer/round-trip.test.ts"
Task: "rutas de importación en tests/contract/admin/config-import.test.ts"

# Piezas puras en paralelo con el ensayo y el reemplazo:
Task: "diffConfig en src/config-transfer/diff.ts"
Task: "PendingImports en src/config-transfer/pending.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1: Setup.
2. Phase 2: Foundational (formato, validación, lectura, página vacía).
3. Phase 3: US1 → el operador ya descarga una copia legible de la configuración.
4. **STOP and VALIDATE**: escenario 1 de [quickstart.md](quickstart.md) y SC-003.

### Incremental Delivery

1. Setup + Foundational → base lista.
2. US1 → exportación (MVP).
3. US2 → importación con vista previa, confirmación y deshacer: cumple el objetivo de la feature
   (P2 de la guía).
4. US3 → rechazos completos y comprensibles.
5. Polish → rendimiento, registros, documentación, README (avisando antes) y quickstart.

---

## Notes

- [P] = ficheros distintos y sin dependencias pendientes.
- `src/admin/routes/config.ts` e `index.eta` los tocan varias tareas: hacerlas en orden.
- Commit después de cada tarea o grupo lógico.
- Antes de cambiar `README.md` (T060), avisar al usuario.
