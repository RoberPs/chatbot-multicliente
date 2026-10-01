---

description: "Lista de tareas de la feature 009: versión visible y actualización escalonada"
---

# Tasks: Versión visible y actualización escalonada

**Input**: documentos de diseño en `/specs/009-version-health-rollout/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Ámbito**: Núcleo. Sin migraciones, sin dependencias nuevas, sin cambios en `src/knowledge`,
`src/conversation` ni `src/webchat` (FR-008). No sube `formatVersion` (008).

**Tests**: sí. El plan (Technical Context → Testing) y los contratos fijan pruebas unitarias, de
contrato (`fastify.inject`) e integración (Testcontainers). Se escriben antes de implementar y deben
fallar primero. Sin `eval`: la cadena de respuesta no cambia.

**Organización**: por historia de usuario (US1 = salud y versión de una instancia, US2 = versiones
del parque desde el inventario, US3 = procedimiento de publicación).

## Formato: `[ID] [P?] [Story] Descripción`

- **[P]**: se puede hacer en paralelo (ficheros distintos, sin dependencias pendientes)
- **[Story]**: historia a la que pertenece (US1, US2, US3)
- Textos, comentarios y mensajes, en español. Nada de sectores ni clientes en `src/`.

---

## Phase 1: Setup

**Purpose**: punto de partida verde y carpetas nuevas

- [ ] T001 Comprobar que la suite existente está en verde antes de empezar (`pnpm lint && pnpm typecheck && pnpm test`) y anotar cualquier fallo previo ajeno a la 009 en specs/009-version-health-rollout/tasks.md (sección Notes)
- [ ] T002 [P] Crear las carpetas src/health/, src/channels/health/, tests/unit/health/, tests/integration/health/ y tests/unit/scripts/ (vacías; los ficheros llegan en sus tareas)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: la variable `HEALTH_SECRET` en el núcleo y la versión del núcleo, que usan US1 (endpoint, panel) y US2 (alta, comprobación, orden)

**⚠️ CRITICAL**: ninguna historia empieza hasta terminar esta fase

- [ ] T003 [P] Añadir casos a tests/unit/env.test.ts: `HEALTH_SECRET` opcional (ausente ⇒ arranca), válida (64 hex aleatorios, normalizada a minúsculas), rechazada si no es hex de 64, si no parece aleatoria, si es igual a `SESSION_SECRET` (regla `health_secret_equals_session`) o igual a `BACKUP_KEY` (regla `health_secret_equals_backup_key`); comprobar que la cobertura `.env.example` ↔ `loadEnv` exige la variable nueva
- [ ] T004 Añadir `HEALTH_SECRET` a src/config/env.ts: `optionalText.pipe(z.string().regex(HEX_KEY, …).refine(looksRandom, …).transform(toLowerCase).optional())` con comentario en español, y en el `superRefine` las dos reglas de T003 con `params: { rule, variables: ['HEALTH_SECRET'] }`, siguiendo el patrón de `backup_key_equals_session`; exponer el valor en el objeto `Env` devuelto (depende de T003)
- [ ] T005 [P] Documentar `HEALTH_SECRET` en .env.example (vacía, con comentario: secreto de salud propio de la instancia, `openssl rand -hex 32`, distinto de `SESSION_SECRET` y `BACKUP_KEY`, se envía como `Authorization: Bearer`, sin él `/health` solo responde el estado)
- [ ] T006 [P] Pruebas unitarias en tests/unit/health/version.test.ts: `isSemanticVersion` acepta `1.4.0` y `1.4.0-rc.1` y rechaza `1.4`, `v1.4.0`, `latest`, vacío; `readCoreVersion(startDir)` encuentra el primer `package.json` con `name: "chatbotasesor"` subiendo directorios (fixture temporal), y lanza un error claro si no existe o si `version` no es semántica (nunca inventa una versión)
- [ ] T007 Implementar src/health/version.ts: `SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/`, `isSemanticVersion(text)`, `extractSemanticVersion(text)` (primera versión semántica dentro de un texto, p. ej. `chatbot:1.4.0` → `1.4.0`; `null` si no hay) y `readCoreVersion(startDir = dirname(fileURLToPath(import.meta.url)))` que sube directorios hasta el `package.json` del núcleo, valida y devuelve la versión; módulo sin dependencias de HTTP (depende de T006)

**Checkpoint**: entorno y versión listos; las historias pueden empezar

---

## Phase 3: User Story 1 - Una instancia declara su versión y su estado (Priority: P1) 🎯 MVP

**Goal**: `GET /health` con dos niveles (público `{status}`; con `HEALTH_SECRET`, informe completo), estado `ok`/`degraded`/`not_ready` también en el código HTTP, y la versión visible en el pie del panel. La imagen no se puede construir con una etiqueta distinta de `package.json`.

**Independent Test**: arrancar la instancia, `curl` a `/health` sin y con secreto y abrir `/admin`: núcleo = `package.json`, esquema aplicado = esperado; parar la BD ⇒ `503 degraded` sin causa (quickstart §1 y §2).

### Tests for User Story 1 ⚠️

> Escribir primero y comprobar que fallan.

- [ ] T008 [P] [US1] Pruebas unitarias en tests/unit/health/secret.test.ts: `verifyHealthSecret` acepta el secreto exacto (también en mayúsculas, pues el entorno se normaliza a minúsculas), rechaza otro valor, uno de distinta longitud y vacío; la comparación usa SHA-256 de ambos y `timingSafeEqual` (no lanza con longitudes distintas); `parseBearer` extrae el valor de `Authorization: Bearer x`, devuelve `absent` sin cabecera y `malformed` con otro esquema o vacío
- [ ] T009 [P] [US1] Pruebas unitarias en tests/unit/health/lifecycle.test.ts: el ciclo empieza en `starting`, pasa a `ready` con `markReady()` y a `stopping` con `markStopping()`; `stopping` no vuelve a `ready`
- [ ] T010 [P] [US1] Pruebas unitarias en tests/unit/health/report.test.ts con dependencias falsas (`probe`, `expected`, `lifecycle`): `not_ready` sin consultar la BD (y `schema.applied: null`); `ok` si aplicado = esperado en índice, etiqueta y hash; `degraded` si la BD no responde o supera 2 s, si el índice/etiqueta/hash difiere, si la BD está vacía, y si hay una migración desconocida (`applied = { index: filas − 1, tag: null }`); `coreVersion` siempre presente; ningún mensaje de error de la BD en el informe ni en el registro; `publicView(report)` devuelve solo `{status}` y `fullView(report, instanceId)` solo los campos del contrato
- [ ] T011 [P] [US1] Prueba de contrato en tests/contract/health.test.ts con `fastify.inject` y dependencias de informe inyectadas: todas las filas de contracts/health-endpoint.md — sin credencial (`200 {"status":"ok"}`, `503 degraded`, `503 not_ready`), credencial correcta (informe completo, 200/503 según estado), credencial incorrecta y `Bearer` mal formado (`401 {"error":"unauthorized"}` + `WWW-Authenticate: Bearer`), credencial enviada a una instancia sin `HEALTH_SECRET` (nivel público, nunca 401), error inesperado del informe (`503 {"status":"degraded"}` sin detalle), `Cache-Control: no-store` y JSON siempre; 31 peticiones en un minuto ⇒ `429` sin datos de la instancia; no exige sesión ni CSRF; secreto en query string ignorado; recorrido de claves de todas las respuestas (solo las del contrato, SC-003) y búsqueda en cuerpos y registros capturados de los valores prohibidos de un estado sembrado (teléfono, nombre de negocio, mensaje de conversación, `HEALTH_SECRET`, `SESSION_SECRET`, `DATABASE_URL`, rutas)
- [ ] T012 [P] [US1] Prueba de contrato en tests/contract/admin/version-header.test.ts: con sesión, cualquier página del panel (p. ej. el inicio y una sección) contiene en el pie «Núcleo <versión de package.json> · Esquema <tag>»; con esquema distinto muestra el distintivo «Esquema distinto del esperado»; si el informe falla, la página se sirve con «Versión no disponible»; sin sesión (login) no aparece la versión
- [ ] T013 [P] [US1] Pruebas de integración en tests/integration/health/health.test.ts con Testcontainers (helpers de tests/helpers/db.ts y tests/helpers/app.ts): esquema real aplicado ⇒ `200 ok` con `schema.applied` = `installedSchema()`; BD parada ⇒ `503 degraded` en ≤ 3 s con `applied: null` (SC-004); migración extra desconocida insertada en `drizzle.__drizzle_migrations` ⇒ `degraded` con `tag: null` e índice adelantado; esquema atrasado (última fila borrada) ⇒ `degraded`; arranque con `startInstance` y `listen` retardado ⇒ `not_ready` antes de terminar y `stopping` ⇒ `not_ready` durante `stop()`; `/health` no escribe (conteo de filas y `pg_stat_user_tables` sin cambios tras 20 consultas) y una respuesta del bot sigue sirviéndose mientras el sondeo está bloqueado en la BD (pool propio, FR-006)
- [ ] T014 [P] [US1] Pruebas unitarias en tests/unit/scripts/check-version.test.ts: `scripts/check-version.mjs` (ejecutado con `node` y `execFile`) sale con 0 si el argumento es igual a `version` de package.json, y con código ≠ 0 y mensaje en español si está vacío, no es semántico o es distinto

### Implementation for User Story 1

- [ ] T015 [P] [US1] Implementar src/health/secret.ts: `parseBearer(header)` → `{ kind: 'absent' } | { kind: 'malformed' } | { kind: 'bearer', value }` y `verifyHealthSecret(expected, received)` con SHA-256 de ambos (minúsculas, recortados) + `crypto.timingSafeEqual` (depende de T008)
- [ ] T016 [P] [US1] Implementar src/health/lifecycle.ts: tipo `LifecycleState = 'starting' | 'ready' | 'stopping'` y `createLifecycle()` con `state`, `markReady()` y `markStopping()` (sin vuelta de `stopping` a `ready`) (depende de T009)
- [ ] T017 [US1] Implementar src/health/report.ts: tipos `HealthStatus`, `SchemaRef`, `HealthReport` (data-model §2–§3); `createSchemaProbe(databaseUrl)` con un `pg.Pool` propio `max: 1`, `connectionTimeoutMillis: 2000`, `statement_timeout` de 2 s y transacción `BEGIN READ ONLY`, que lee el esquema con `databaseSchema` de src/backup/schema-version.ts y, si este lanza por migración desconocida, cuenta las filas de `drizzle.__drizzle_migrations` para devolver `{ index: filas − 1, tag: null }`; `buildHealthReport({ lifecycle, probe, expected = installedSchema(), coreVersion })` con las reglas de R3 en orden (`not_ready` → `degraded` → `ok`, comparando índice, etiqueta y hash), tope total de 2 s, sin propagar mensajes de error; `publicView` y `fullView(report, instanceId)` (depende de T007, T010, T016)
- [ ] T018 [US1] Implementar src/channels/health/routes.ts: plugin `healthRoutes` con `GET /health` (`HEAD` implícito), `logLevel: 'warn'`, `config: { rateLimit: { max: 30, timeWindow: '1 minute' } }`, `Cache-Control: no-store`; decide el nivel con `parseBearer` + `verifyHealthSecret` (sin `HEALTH_SECRET` configurado ⇒ siempre público; `malformed` o distinto ⇒ `401 {"error":"unauthorized"}` + `WWW-Authenticate: Bearer`); código 200 solo con `ok`, si no 503; cualquier excepción ⇒ `503 {"status":"degraded"}` sin detalle; sin acceso a `src/knowledge` ni al pool del bot (depende de T015, T017)
- [ ] T019 [US1] Integrar en src/app.ts: opción `health?: { lifecycle, report: () => Promise<HealthReport> }` en las opciones de `buildApp` (con valor por defecto que crea el ciclo de vida y el sondeo con `env.DATABASE_URL` y `readCoreVersion()`), decorar `app.lifecycle`, registrar `healthRoutes` fuera de `/admin` tras `rateLimit`, cerrar el pool del sondeo en `app.addHook('onClose')`, y comprobar que `Authorization` sigue en `redact` del logger; tipos en src/admin/fastify-types.ts si hace falta (depende de T018)
- [ ] T020 [US1] Integrar el ciclo de vida en src/startup.ts: leer la versión con `readCoreVersion()` antes de construir la app (si falla, el arranque termina con mensaje claro: nunca versión desconocida), `app.lifecycle.markReady()` tras `listen`, bot y tareas, y `markStopping()` al inicio de `stop()` (depende de T019)
- [ ] T021 [US1] Versión en el panel: en src/admin/render.ts, `renderPage` añade `layout.version` con `{ coreVersion, schemaTag, matches }` a partir del mismo informe (`app`/deps del informe, sin credencial), o `null` si falla; en src/admin/views/layout.eta, línea fija al pie «Núcleo x.y.z · Esquema 000N_…» con el distintivo «Esquema distinto del esperado» si `matches` es falso y «Versión no disponible» si es `null`; estilo mínimo en src/admin/views/app.css (depende de T017, T019)
- [ ] T022 [P] [US1] Crear scripts/check-version.mjs: recibe `CORE_VERSION` como argumento, lee package.json y sale con error en español si está vacío, no es semántica o no coincide (depende de T014)
- [ ] T023 [US1] Actualizar Dockerfile: `ARG CORE_VERSION` en la etapa `build` y `RUN node scripts/check-version.mjs "$CORE_VERSION"` antes de `pnpm build`; en la etapa final `ARG CORE_VERSION` + `LABEL org.opencontainers.image.version=$CORE_VERSION`; comentario con `docker build --build-arg CORE_VERSION=X.Y.Z -t chatbot:X.Y.Z .` y «nunca latest» (depende de T022)
- [ ] T024 [US1] Ejecutar `pnpm test health` y `pnpm test version-header` hasta verde; comprobar con `pnpm test` que el resto de contrato e integración (auth, web-chat, whatsapp, backup/startup) sigue en verde tras los cambios en src/app.ts y src/startup.ts

**Checkpoint**: US1 completa y comprobable sola (quickstart §1–§2)

---

## Phase 4: User Story 2 - El operador ve de un vistazo qué versión corre cada instancia (Priority: P2)

**Goal**: `pnpm instance:versions` recorre el inventario, consulta `/health` de cada instancia activa con su `HEALTH_SECRET` (solo en memoria), clasifica cada fila y pinta tabla o `--json` con código de salida; `--annotate` escribe la versión observada bajo confirmación. El alta genera el secreto, `instance:check` lo exige y detecta repeticiones, e `instance:health-secret` lo añade a instancias anteriores.

**Independent Test**: inventario temporal con tres servidores locales (versión nueva, anterior, apagado) ⇒ tabla correcta, la caída no impide ver las demás y código 1 (quickstart §3–§4).

### Tests for User Story 2 ⚠️

- [ ] T025 [P] [US2] Ampliar tests/unit/provisioning/secrets.test.ts: `secretQuality('HEALTH_SECRET', …)` exige 64 hex con más de 8 símbolos distintos (`weak_secret` si no) y detecta marcadores de posición; `generateHexSecret('HEALTH_SECRET')` devuelve 64 hex
- [ ] T026 [P] [US2] Ampliar tests/unit/provisioning/fingerprint.test.ts: `HEALTH_SECRET` está en `SECRET_VARIABLES`, se normaliza a minúsculas (hex) y `envFingerprints` produce su huella `class: "secret"`, nunca el valor
- [ ] T027 [P] [US2] Ampliar tests/unit/provisioning/check.test.ts: falta `HEALTH_SECRET` ⇒ error `missing` (en `production` y `testing`); débil ⇒ `weak_secret`; igual a `SESSION_SECRET` o `BACKUP_KEY` ⇒ un único error traducido de la regla del núcleo (sin duplicar `secret_reused_within`); igual al de otra instancia del inventario ⇒ el mismo código de secreto repetido entre instancias que ya usa la 007
- [ ] T028 [P] [US2] Ampliar tests/unit/provisioning/generate.test.ts: el entorno generado por `instance:new` incluye `HEALTH_SECRET` válido, distinto de `SESSION_SECRET` y `BACKUP_KEY`, y no aparece en la salida impresa
- [ ] T029 [P] [US2] Pruebas unitarias en tests/unit/provisioning/versions.test.ts: `annotatedVersion` (`chatbot:1.4.0` → `1.4.0`, sin anotación ⇒ `null`, sin semántica ⇒ discrepancia); `classify` con todas las filas y la prioridad de contracts/instance-versions-command.md (`not_queried` con `no_url`/`not_https`, `unreachable` por error/tiempo, `no_health` 404, `auth_failed` 401, `rate_limited` 429, `invalid_response` por no-JSON, > 4 KiB, esquema incumplido o redirección 3xx, `status_only` con `no_secret`/`instance_without_secret`, `identity_mismatch` sin versión atribuida ni id recibido, `ok`/`degraded`/`not_ready`); `matches` y `review`; `allowedUrl` (`https` sí, `http` solo con `allowInsecure` y `localhost`/`127.0.0.1`/`[::1]`, credenciales en URL rechazadas); `renderTable` (columnas y textos del contrato, recuento «N de M instancias requieren revisión», «No hay instancias activas en el inventario.»); `renderJson` (forma exacta, `ok` global); `exitCode` 0/1; `annotationPlan` solo con filas `ok` de identidad correcta y versión distinta; ningún secreto en tabla ni JSON
- [ ] T030 [P] [US2] Pruebas de integración en tests/integration/provisioning/cli-versions.test.ts: servidores Fastify reales en puertos locales que sirven el contrato de `/health` (con `healthRoutes` y un informe fijo) e inventario temporal creado con tests/helpers/provisioning.ts y entornos en `<inventario>/envs/<id>.env`; ejecutar `main(['versions', '--allow-insecure', …])` y comprobar: correcto, versión distinta (`NO`), apagado (`No responde`), URL cruzada (`Identidad distinta`, sin versión), servidor sin `/health` (`Sin información de versión`), entorno sin `HEALTH_SECRET` (`Solo estado`), secreto cambiado (`Secreto rechazado`), redirección a otro puerto que no recibe la cabecera, instancia `retired` no consultada, `http` sin `--allow-insecure` ⇒ `No consultada`; `--only`; `--json`; códigos 0/1/2 (clave incorrecta ⇒ 2); el fichero del inventario no cambia sin `--annotate` (contenido y fecha); `--annotate --yes` escribe `imageVersion` solo en filas `ok`; `--annotate` sin terminal y sin `--yes` ⇒ 2 sin escribir; anotación cambiada entre consulta y escritura no se pisa; 10 instancias con 3 que no responden (servidor que no contesta) terminan en < 60 s (SC-002); ningún `HEALTH_SECRET` en stdout/stderr
- [ ] T031 [P] [US2] Pruebas de integración en tests/integration/provisioning/cli-health-secret.test.ts: `instance:health-secret <id>` añade `HEALTH_SECRET` a un entorno sin él sin tocar el resto de líneas y sin imprimirlo; con secreto existente no cambia nada (código 0, «Ya tiene secreto de salud»); `--rotate` lo cambia; `--env <ruta>`; instancia desconocida o entorno ilegible ⇒ 2; entorno dentro del repositorio sin ignorar ⇒ 2 (`output_in_repo`); tras `instance:sync` el inventario guarda la huella y no el valor
- [ ] T032 [P] [US2] Ampliar tests/integration/provisioning/cli-check.test.ts y tests/integration/provisioning/cli-new.test.ts: `instance:new` genera `HEALTH_SECRET`; `instance:check` de un entorno sin él no es apto; copiar el `HEALTH_SECRET` de una instancia sincronizada a otra ⇒ secreto repetido; y tests/integration/provisioning/privacy.test.ts recorre también la salida de `versions` y `health-secret` buscando secretos

### Implementation for User Story 2

- [ ] T033 [P] [US2] Actualizar src/provisioning/secrets.ts: `generateHexSecret` acepta `'HEALTH_SECRET'` en su tipo de variable y `secretQuality` aplica a `HEALTH_SECRET` la regla hex de 64 con más de 8 símbolos distintos (depende de T025)
- [ ] T034 [P] [US2] Actualizar src/provisioning/fingerprint.ts: añadir `HEALTH_SECRET` a `HEX_VARIABLES` y a `SECRET_VARIABLES` (huella `class: "secret"`), sin cambiar el formato del inventario (depende de T026)
- [ ] T035 [US2] Actualizar src/provisioning/check.ts y src/provisioning/messages.ts: `HEALTH_SECRET` en `REQUIRED` y en `secretEntries`; `translateCoreIssue` traduce `health_secret_equals_session` y `health_secret_equals_backup_key` a códigos nuevos con mensaje y acción en español («Genera un HEALTH_SECRET nuevo con openssl rand -hex 32»); `reusedWithin` omite esos pares ya detectados por el núcleo; la repetición entre instancias usa el código existente; mensaje de variable para `HEALTH_SECRET` en el mapa de variables de messages.ts (depende de T027, T033, T034)
- [ ] T036 [US2] Actualizar src/provisioning/generate.ts: generar `HEALTH_SECRET` con `generateHexSecret` junto a `SESSION_SECRET` y `BACKUP_KEY`, repitiendo si coincide con alguno de los dos, y escribirlo en el entorno sin imprimirlo; añadir la línea en la plantilla de entorno si la plantilla la lista explícitamente (depende de T028, T033)
- [ ] T037 [US2] Implementar en src/provisioning/versions.ts la parte pura: tipos `VersionRow`, `RowResult`, `RowReason` y `VersionsReport` (data-model §6); esquemas Zod de las dos formas de respuesta de `/health` (`{status}` y completa); `annotatedVersion` (con `extractSemanticVersion` de src/health/version.ts); `allowedUrl`; `classify(instance, outcome)` con la prioridad del contrato; `computeMatch`/`review`; `renderTable` (textos en español del contrato, sin id recibido en identidad cruzada); `renderJson` (`checkedAt`, `ok`, `instances`); `exitCode`; `annotationPlan(report, inventory)` (depende de T007, T029)
- [ ] T038 [US2] Implementar en src/provisioning/versions.ts la consulta: `readHealthSecret(envsDir, id)` (lee solo `HEALTH_SECRET` con `parseEnvFile`; ausencia ⇒ `null`, nunca lanza al exterior el contenido), `queryInstance(url, secret, { fetch, timeoutMs })` con `redirect: 'manual'`, `AbortSignal.timeout`, cuerpo leído hasta 4 KiB y `Authorization: Bearer` solo si hay secreto; `collectVersions(inventory, options)` con selección de no retiradas y `--only`, concurrencia máxima 8 y `fetch` inyectable (depende de T037)
- [ ] T039 [US2] Añadir la suborden `versions` a src/cli/instance.ts: argumentos `--json`, `--only`, `--envs-dir` (por defecto `<carpeta del inventario>/envs`), `--timeout` (1–30, por defecto 5), `--allow-insecure`, `--annotate`, `--yes`; carga con `loadInventoryForUse`/`requireAccess` sin bloqueo (código 2 si falla); imprime tabla o JSON y devuelve `exitCode` (depende de T038)
- [ ] T040 [US2] Implementar `--annotate` en src/cli/instance.ts (con ayuda de src/provisioning/versions.ts): mostrar «instancia: anotada → observada», preguntar «¿Anotar estas versiones? (s/N)» (sin terminal y sin `--yes` ⇒ código 2), y escribir solo `imageVersion` con `mutateInventory`/`withInventoryLock` releyendo y validando, sin pisar una instancia cuya anotación cambió desde la consulta (se informa) (depende de T039)
- [ ] T041 [US2] Añadir la suborden `health-secret <id> [--rotate] [--env <ruta>]` a src/cli/instance.ts: localiza el entorno (`<carpeta del inventario>/envs/<id>.env`), aplica la regla `output_in_repo`, no cambia nada si ya existe sin `--rotate`, genera con `generateHexSecret('HEALTH_SECRET')` distinto de `SESSION_SECRET`/`BACKUP_KEY`, escribe con `setVariable` de src/provisioning/env-file.ts, no imprime el secreto e indica desplegar el entorno y ejecutar `pnpm instance:sync <id> <entorno>` (depende de T033)
- [ ] T042 [US2] Añadir a package.json los scripts `instance:versions` (`tsx src/cli/instance.ts versions`) e `instance:health-secret` (`tsx src/cli/instance.ts health-secret`) y la ayuda de ambas subórdenes en el texto de uso de src/cli/instance.ts (depende de T039, T041)
- [ ] T043 [US2] Ejecutar `pnpm test provisioning` hasta verde (unitarias e integración de la 007 incluidas) y comprobar a mano quickstart §3 con dos instancias locales

**Checkpoint**: US1 y US2 funcionan; el operador ve las versiones del parque

---

## Phase 5: User Story 3 - Procedimiento de publicación escalonada con vuelta atrás (Priority: P3)

**Goal**: la sección 5 de la guía de operación es un procedimiento con etapas, comprobación, resultado esperado y criterio de continuar/parar, apoyado en `instance:versions` y el pie del panel.

**Independent Test**: un operador ajeno sigue solo la guía con una instancia de pruebas y una de ensayo, publica, detecta un fallo simulado y vuelve atrás (quickstart §5, SC-006).

### Implementation for User Story 3

- [ ] T044 [US3] Reescribir la sección 5 («Actualizar el núcleo») de docs/operacion-multicliente.md con todas las filas de contracts/release-procedure.md: 0 antes de la primera vez (`instance:health-secret`, `instance:sync`, `instance:check`, `instance:versions`), 1 comprobaciones previas (versión en package.json, lint/typecheck/test, `test:eval` en ambos canales, migraciones solo añadir, etiqueta Git y `docker build --build-arg CORE_VERSION`, nunca `latest`), 2 instancia de pruebas, 3 tandas con la tabla de resultados y criterio, 4 vuelta atrás (migración no aplicada / aplicada compatible / aplicada incompatible con restauración de la `premigration` con la imagen anterior), 5 cierre (`--annotate`, validación de copias de la sección 8, registro de la publicación); incluir la limitación de R3 (durante la migración la instancia no responde: mirar `migration_blocked`/`migration_failed`)
- [ ] T045 [US3] Actualizar las secciones 2.2 y 2.4 de docs/operacion-multicliente.md: `HEALTH_SECRET` en el entorno generado por `instance:new`, exigido por `instance:check` (missing, débil, repetido), su huella en el inventario y la tabla de variables; añadir en la sección 8 («Cuándo repetirla») la referencia al cierre de una publicación con migraciones
- [ ] T046 [US3] Revisar la guía contra contracts/release-procedure.md fila a fila (ninguna perdida) y contra quickstart.md §5, y comprobar que todas las órdenes citadas existen en package.json con esos nombres y opciones

**Checkpoint**: las tres historias completas

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T047 Avisar al usuario de que se va a cambiar el estado de la feature 009 en README.md y, tras el aviso, actualizar README.md: estado de la 009, endpoint `/health` (dos niveles), versión en el pie del panel, órdenes `pnpm instance:versions` e `instance:health-secret`, y `HEALTH_SECRET` entre las variables
- [ ] T048 Actualizar docs/operacion-multicliente.md al cierre de la spec: fila de la 009 con fecha en 9.1, P6 marcada como **Hecha** y orden renumerado en 9.2, propuesta P6 marcada como hecha, y resumen de reglas (sección 10) si cambia
- [ ] T049 [P] Añadir `pnpm instance:versions` y `pnpm instance:health-secret` a la lista de órdenes de CLAUDE.md (bloque «Alta de instancias»)
- [ ] T050 [P] Comprobar que tests/unit/sector-neutrality.test.ts y tests/integration/sector-neutrality.test.ts siguen en verde con src/health, src/channels/health y src/provisioning/versions.ts (ningún nombre de sector o cliente en `src/`)
- [ ] T051 Ejecutar `pnpm lint && pnpm typecheck && pnpm test` completo y corregir lo que falle (sin `test:eval`: la cadena de respuesta no cambia)
- [ ] T052 Validar quickstart.md §1–§4 a mano (curl sin/con/incorrecto secreto, BD parada, pie del panel, `instance:versions` con los casos de la tabla, alta con secreto) y construir la imagen con `docker build --build-arg CORE_VERSION=<versión de package.json>` comprobando que con otra versión la construcción falla
- [ ] T053 Marcar las tareas completadas en specs/009-version-health-rollout/tasks.md y dejar anotado en Notes que el ensayo con operador externo (quickstart §5, SC-006) queda pendiente de realizar por una persona

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias
- **Foundational (Phase 2)**: tras Setup; bloquea todas las historias (T004 `HEALTH_SECRET` en `loadEnv`, T007 versión del núcleo)
- **US1 (Phase 3)**: tras Foundational
- **US2 (Phase 4)**: tras Foundational; la clasificación no depende del código de US1 (prueba con servidores que sirven el contrato), pero T030 reutiliza `healthRoutes` (T018) para los servidores de prueba ⇒ en la práctica, después de T018
- **US3 (Phase 5)**: documentación que cita órdenes de US1 y US2; escribirla tras ambas
- **Polish (Phase 6)**: tras las historias deseadas

### User Story Dependencies

- **US1 (P1)**: independiente; es el MVP
- **US2 (P2)**: consume el contrato de `/health` de US1; la parte de alta (T033–T036, T041) es independiente de US1
- **US3 (P3)**: depende de US1 y US2 (cita sus órdenes y pantallas)

### Within Each User Story

- Pruebas primero (deben fallar), luego implementación
- US1: secret / lifecycle → report → routes → app → startup → panel; Dockerfile en paralelo
- US2: secrets/fingerprint → check/generate; versions puro → consulta → CLI → `--annotate`; health-secret en paralelo
- Cerrar cada historia con su ejecución de pruebas (T024, T043)

### Parallel Opportunities

- Phase 2: T003, T005, T006 en paralelo
- US1: T008–T014 en paralelo; T015, T016 y T022 en paralelo
- US2: T025–T032 en paralelo; T033 y T034 en paralelo; T041 en paralelo con T037–T040
- Polish: T049 y T050 en paralelo

---

## Parallel Example: User Story 1

```bash
# Pruebas de US1 a la vez:
Task: "Pruebas unitarias de secret en tests/unit/health/secret.test.ts"
Task: "Pruebas unitarias de lifecycle en tests/unit/health/lifecycle.test.ts"
Task: "Pruebas unitarias de report en tests/unit/health/report.test.ts"
Task: "Contrato de /health en tests/contract/health.test.ts"
Task: "Contrato del pie del panel en tests/contract/admin/version-header.test.ts"
Task: "Integración de salud en tests/integration/health/health.test.ts"
Task: "Prueba de scripts/check-version.mjs en tests/unit/scripts/check-version.test.ts"

# Implementación sin dependencias entre sí:
Task: "src/health/secret.ts"
Task: "src/health/lifecycle.ts"
Task: "scripts/check-version.mjs"
```

## Parallel Example: User Story 2

```bash
Task: "tests/unit/provisioning/versions.test.ts"
Task: "tests/integration/provisioning/cli-versions.test.ts"
Task: "tests/integration/provisioning/cli-health-secret.test.ts"
Task: "src/provisioning/secrets.ts (HEALTH_SECRET)"
Task: "src/provisioning/fingerprint.ts (HEALTH_SECRET)"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 + Phase 2
2. Phase 3 (US1): `/health` y versión en el panel
3. **Parar y validar**: quickstart §1–§2; cada instancia ya declara su versión
4. Desplegable: un monitor externo puede usar el nivel público desde ya

### Incremental Delivery

1. Setup + Foundational
2. US1 → validar → MVP
3. US2 → validar con varias instancias locales → informe del parque
4. US3 → guía de publicación → ensayo con operador externo (SC-006)
5. Polish: README (con aviso previo), guía 9.1/9.2/P6, CLAUDE.md, suite completa

---

## Notes

- [P] = ficheros distintos, sin dependencias pendientes
- Nada de sectores ni clientes en `src/`; los datos de prueba sembrados (teléfono, nombre de negocio) solo en `tests/fixtures/`
- Ninguna salida (respuestas, registros, tabla, JSON) contiene secretos ni datos de clientes finales
- Sin migraciones: `formatVersion` (008) no cambia
- Commit tras cada tarea o grupo lógico
