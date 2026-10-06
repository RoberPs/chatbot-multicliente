---

description: "Lista de tareas de la feature 013: requisitos de despliegue seguro"
---

# Tasks: Requisitos de despliegue seguro

**Input**: documentos de diseño de `/specs/013-secure-deployment/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md) (R1–R10),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Ámbito**: núcleo (operación y documentación; propuesta P9).

**Tests**: sí. El plan (Technical Context → Testing) pide pruebas `unit` e `integration`
(Testcontainers); no hay pruebas de contrato HTTP nuevas (`/health` no cambia) ni `eval` (la
conversación no cambia). Dentro de cada historia, los tests se escriben primero y deben fallar
antes de implementar.

**Organización**: por historia de usuario (spec.md), en orden de prioridad: US1 (P1); US2 y US3
(P2); US4 (P3). FR-008 (TLS en todas las conexiones y mensajes sin datos) va en US1, porque sin él
la regla `database_tls_required` exigiría algo que la instancia no sabe usar.

## Formato: `[ID] [P?] [Story] Descripción`

- **[P]**: se puede hacer en paralelo (ficheros distintos, sin dependencias pendientes)
- **[Story]**: historia a la que pertenece (US1…US4)
- Cada tarea indica la ruta exacta del fichero

## Convenciones del proyecto que afectan a todas las tareas

- Specs, comentarios, mensajes y textos, en español.
- **Sin migración ni cambios de esquema**; no sube `formatVersion` (nada de esto es configuración
  del negocio).
- `src/config/database-url.ts` y `src/backup/verify-names.ts` son puros y no importan Fastify ni
  `pg`.
- Ningún mensaje, informe, registro ni salida de prueba muestra una URL ni parte de ella (usuario,
  contraseña, host, base), una ruta de `sslrootcert` ni los nombres del certificado (FR-006,
  SC-002). Los errores de `pg`/Node se clasifican por `code`, nunca por su texto.
- La regla de TLS **no** se aplica al arrancar (Assumptions): el arranque solo comprueba que el
  fichero de autoridad se puede leer y traduce los errores.
- Las marcas de las bases temporales van en UTC (instante técnico, research R5); las duraciones,
  en horas o segundos donde las mide la máquina.
- En `src/` no puede haber nombres de proveedor de hosting, cliente ni sector (FR-021, Principio I).

---

## Phase 1: Setup (infraestructura compartida)

**Purpose**: ayudas de prueba que usan varias historias.

- [X] T001 [P] Crear `tests/helpers/tls-postgres.ts`: arranca con Testcontainers un `postgres:16` cuyo comando de entrada genera con `openssl` dentro del contenedor una autoridad propia y un certificado de servidor con SAN `DNS:localhost` (clave con modo 0600 y dueño `postgres`), arranca PostgreSQL con `ssl=on`, `ssl_cert_file` y `ssl_key_file`, y copia el certificado de la autoridad a un directorio temporal del equipo (`copyFileFromContainer`). Exporta `startTlsPostgres()` → `{ caPath, urlFor(db, { host?: 'localhost' | '127.0.0.1', sslrootcert?: string }), adminUrl, stop() }`, con `sslmode=verify-full&sslrootcert=<caPath>` por defecto (research R9)
- [X] T002 [P] Añadir a `tests/helpers/provisioning.ts` la función `expectNoUrlParts(output: string, url: string, extra: string[] = [])`, que falla si `output` contiene la URL completa, su usuario, su contraseña, su host, el nombre de su base o el valor de `sslrootcert`, o cualquiera de `extra` (SC-002); reutilizar la comprobación equivalente de `tests/integration/provisioning/privacy.test.ts` si ya existe en vez de duplicarla

---

## Phase 2: Foundational (prerrequisitos bloqueantes)

**Purpose**: clasificación de URL de base de datos y errores de conexión sin datos, compartidos
por `instance:check`, `instance:db`, el arranque y las órdenes de copias (research R1, R4).

**⚠️ CRITICAL**: US1 depende de esta fase. US2 y US3 no, pero conviene terminarla antes.

- [X] T003 [P] Escribir `tests/unit/config/database-url.test.ts` (debe fallar): tabla de `classifyDatabaseUrl` con locales (`localhost`, `127.0.0.1`, `127.0.0.5`, `127.255.255.254`, `::1`, `[::1]`, `[0:0:0:0:0:0:0:1]`, socket por `?host=/var/run/postgresql` con host vacío, host `%2Fvar%2Frun%2Fpostgresql`) y remotas (`10.0.0.5`, `192.168.1.10`, `128.0.0.1`, `db.interna`, `[fd00::1]`); `verifiedTls` solo con un único `sslmode=verify-full` (falso con `require`, `verify-ca`, `prefer`, `allow`, `disable`, `ssl=true`, `sslmode` repetido, `VERIFY-FULL`, sin `sslmode`); `caFile` = valor de `sslrootcert` o `null`; `invalid` con `mysql://…`, texto sin esquema y `postgres://` sin host ni socket. `assertCaReadable(url, variable)`: no hace nada sin `sslrootcert`; con fichero legible pasa; con ruta inexistente lanza `DatabaseConfigError` `reason: 'ca_unreadable'` cuyo `message` nombra la variable y no contiene la ruta. `describeDatabaseError(error, variable)`: cada código de la tabla de [contracts/database-tls.md](contracts/database-tls.md) → `tls_untrusted`; el error de `pg` cuando el servidor no acepta SSL → `tls_unsupported`; `ECONNREFUSED`, `ENOTFOUND` y un error sin `code` → `unreachable`; ningún mensaje contiene el texto del error original (crear errores cuyo `message` lleve un host y comprobar que no aparece)
- [X] T004 Crear `src/config/database-url.ts` (puro, sin `pg`; `node:net` para `isIP` y normalizar IPv6; `node:fs` solo en `assertCaReadable`) con `classifyDatabaseUrl(url)` → `{ kind: 'invalid' } | { kind: 'ok', local, verifiedTls, caFile }` (data-model §1), `requiresVerifiedTls(classification)` (`ok` ∧ ¬`local` ∧ ¬`verifiedTls`), `DatabaseConfigError` (`reason: 'ca_unreadable' | 'tls_untrusted' | 'tls_unsupported' | 'unreachable'`, `variable: 'DATABASE_URL' | 'BACKUP_VERIFY_URL'`, `message` y `action` fijos de [contracts/database-tls.md](contracts/database-tls.md)), `assertCaReadable(url, variable)` (`fs.accessSync(caFile, R_OK)`; sin `pg-connection-string`, research R1) y `describeDatabaseError(error, variable)` → `DatabaseConfigError` clasificado por `code` (incluido el `cause` anidado); hace pasar T003

**Checkpoint**: clasificación y mensajes listos; las historias pueden empezar.

---

## Phase 3: User Story 1 - El entorno de producción no pasa la comprobación si el despliegue no es seguro (Priority: P1) 🎯 MVP

**Goal**: `instance:check` da NO APTO en producción con `TRUST_PROXY` vacío y `PUBLIC_BASE_URL`
https, sin `PUBLIC_BASE_URL` o con una URL de base de datos remota sin `sslmode=verify-full`;
`instance:db` se niega a conectar sin TLS verificado; y todas las conexiones de la instancia
funcionan con `verify-full` y fallan con mensajes sin datos (FR-001–FR-008).

**Independent Test**: los entornos de la tabla del [quickstart §2](quickstart.md) dan el resultado
esperado en los dos perfiles, con paridad texto/JSON y sin valores en la salida; `instance:db`
con URL remota sin TLS sale con 1 sin conectar; una instancia arranca, migra, copia, restaura y
verifica contra un PostgreSQL con `verify-full`, y con un nombre fuera del certificado o una
autoridad ilegible falla con el mensaje del contrato.

### Tests for User Story 1 ⚠️

> Escribirlos primero y comprobar que fallan.

- [X] T005 [P] [US1] Ampliar `tests/unit/provisioning/check.test.ts` según [contracts/check-rules.md](contracts/check-rules.md): `trust_proxy_empty` es **error** en `production` y **advertencia** en `testing` cuando `PUBLIC_BASE_URL` es https y `TRUST_PROXY` falta, está vacío o vale `false` (y no aparece con `TRUST_PROXY=1`); `missing` en `PUBLIC_BASE_URL` sigue siendo error en producción (FR-002); `database_tls_required` por separado en `DATABASE_URL`, `BACKUP_VERIFY_URL` e `INSTANCE_DB_ADMIN_URL` con host remoto y `sslmode` ausente, `require` o `verify-ca` (error en producción, advertencia en pruebas), y no aparece con `verify-full`; con host local no hay error de TLS y `database_localhost` sigue siendo advertencia en producción (FR-004); sin `BACKUP_VERIFY_URL` no se repite el hallazgo de `DATABASE_URL`; `database_url_invalid` en `BACKUP_VERIFY_URL`/`INSTANCE_DB_ADMIN_URL` mal formadas en los dos perfiles; `DATABASE_URL` mal formada da el error del esquema y no `database_tls_required`; un entorno de producción correcto da APTO (SC-001) y en `testing` ninguna regla nueva cambia el resultado (SC-007); paridad de `code`/`variable` entre texto y `checkResultJson`; textos exactos del contrato; `expectNoUrlParts` (T002) sobre la salida de texto y la JSON
- [X] T006 [P] [US1] Ampliar `tests/unit/provisioning/database.test.ts`: `parseAdminUrl` devuelve `local` y `verifiedTls` coherentes con `classifyDatabaseUrl`; `buildDatabaseUrl` copia el `sslmode` de la URL de administración, añade `sslrootcert` solo si se pasa `--sslrootcert` (nunca el de la URL de administración), y con `--print-sql` y `--host` remoto sin `sslmode` pone `sslmode=verify-full` (con `--host localhost` no lo pone); la URL de la conexión de prueba (`probeUrl`) conserva `sslmode` **y** `sslrootcert` de la URL de administración (research R3)
- [X] T007 [P] [US1] Ampliar `tests/integration/provisioning/cli-db.test.ts`: con `INSTANCE_DB_ADMIN_URL=postgres://admin:x@10.0.0.5:5432/postgres` (y lo mismo con `?sslmode=require`), `instance:db cliente-x` sale con 1, imprime el texto de `admin_url_tls_required` del contrato, no llama a la función de conexión inyectada, no abre el inventario y no modifica el fichero de entorno, y `expectNoUrlParts` pasa; mismo resultado con perfil `testing` y con la URL pedida sin eco; `--print-sql --host db.interna --sslrootcert /etc/chatbot/db-ca.crt` imprime el SQL y escribe en el entorno una `DATABASE_URL` con `sslmode=verify-full` y `sslrootcert=/etc/chatbot/db-ca.crt`, sin mostrar la ruta en la salida; con una URL de administración local sin TLS sigue funcionando como hoy
- [X] T008 [P] [US1] Ampliar `tests/integration/provisioning/cli-check.test.ts` con la tabla del [quickstart §2](quickstart.md): partiendo de un `prod.env` APTO, cada cambio (`TRUST_PROXY=`, sin `PUBLIC_BASE_URL`, `DATABASE_URL` remota sin TLS, con `sslmode=require`, con `verify-full`, con `127.0.0.1`, `BACKUP_VERIFY_URL` y `INSTANCE_DB_ADMIN_URL` remotas sin TLS) da el código de salida y el `code`/`variable` esperados, en texto y con `--json`; los fallos de `TRUST_PROXY` y TLS con una instancia `--status testing` salen como advertencias con código de salida 0; ninguna salida contiene `db.interna`, `10.0.0.5` ni el usuario
- [X] T009 [P] [US1] Crear `tests/integration/db/tls.test.ts` con `startTlsPostgres()` (T001): con `sslmode=verify-full&sslrootcert=<ca>` y host `localhost` funcionan el pool principal y el público (`src/db/client.ts`), el sondeo de `/health`, `runMigrations` con su cerrojo, `startInstance` completo, la copia (`db:backup`), la restauración (`db:restore`) y la verificación (`db:verify`, con `BACKUP_VERIFY_URL` también en `verify-full`); con host `127.0.0.1` (fuera del SAN) `startInstance` falla y el mensaje mostrado es el de `tls_untrusted` sin `127.0.0.1` ni `localhost`; con `sslrootcert=/no/existe.crt`, `startInstance`, `migrateMain` y las órdenes de copias fallan con `ca_unreadable` sin la ruta y sin haber creado ningún cliente; `db:backup`/`db:restore`/`db:verify` devuelven `db_tls_untrusted` o `db_ca_unreadable` en `--json` con los códigos de salida de la tabla de [contracts/database-tls.md](contracts/database-tls.md) (`db_ca_unreadable`: 1 en `db:backup`, 2 en `db:restore` y `db:verify`, y `orphans.listed: false` en `db:verify`); contra un PostgreSQL **sin** TLS (el contenedor normal) con `sslmode=verify-full`, `db:backup --json` devuelve `db_tls_unsupported` y sale con 1
- [X] T010 [P] [US1] Crear `tests/unit/config/startup-error.test.ts` para `startupErrorMessage(error)` de `src/startup.ts`: devuelve el mensaje propio de `InstanceBusyError`, `DatabaseConfigError` y los errores de migración con copia previa; para un `Error` cualquiera (también uno con código TLS cuyo `message` lleva host y nombres del certificado) devuelve el texto fijo de `describeDatabaseError` para `DATABASE_URL`, nunca `error.message`

### Implementation for User Story 1

- [X] T011 [US1] En `src/provisioning/messages.ts`: añadir `database_tls_required` y `database_url_invalid` a la lista de `CheckCode` y a `CHECK_CATALOG` con `message`, `detail` y `action` exactos de [contracts/check-rules.md](contracts/check-rules.md) (el `message` usa la variable del contexto); sustituir `message`, `detail` y `action` de `trust_proxy_empty` por los del contrato; añadir `admin_url_tls_required` al catálogo de mensajes de órdenes con el texto y la acción del contrato (propone `--print-sql --host <servidor> --port <puerto>`)
- [X] T012 [US1] En `src/provisioning/check.ts`: quitar el `LOCAL_HOSTS` de base de datos y usar `classifyDatabaseUrl`/`requiresVerifiedTls` de `src/config/database-url.ts`; `trust_proxy_empty` como `error` en `production` y `warning` en `testing` (también ausente o `false`); `database_tls_required` para `DATABASE_URL` (solo si su esquema es válido), `BACKUP_VERIFY_URL` e `INSTANCE_DB_ADMIN_URL` (solo si están y no vacías), error en `production` y advertencia en `testing`; `database_url_invalid` como error en los dos perfiles para las dos últimas; mantener `database_localhost` con el host local de la clasificación; sin leer el fichero de `sslrootcert` (depende de T004, T011; hace pasar T005 y T008)
- [X] T013 [US1] En `src/provisioning/database.ts`: `parseAdminUrl` basado en `classifyDatabaseUrl` (devuelve también `local`, `verifiedTls` y `sslrootcert`); `buildDatabaseUrl` acepta `sslrootcert?: string | null` y, con `defaultVerifyFull: true` y host no local sin `sslmode`, pone `sslmode=verify-full`; la URL de la conexión de prueba copia `sslmode` y `sslrootcert` de la URL de administración; `translatePgError` no expone el texto original (depende de T004; hace pasar T006)
- [X] T014 [US1] En `src/cli/instance.ts` (`instance:db`): justo después de leer la URL de administración (variable o terminal) y **antes** de abrir el inventario o conectar, si `requiresVerifiedTls` → `ProvisioningError('admin_url_tls_required')`, salida 1, en cualquier perfil y sin opción de escape (FR-007); opción nueva `--sslrootcert <ruta>` en el analizador (`options`) que pasa a `buildDatabaseUrl` sin mostrarse; `verify-full` por defecto con `--print-sql` y `--host` remoto; actualizar los dos textos de uso (`db <id> … [--sslrootcert <ruta>]`) (depende de T011, T013; hace pasar T007)
- [X] T015 [US1] En `src/backup/errors.ts` añadir `db_ca_unreadable`, `db_tls_untrusted` y `db_tls_unsupported` a `BackupFailureCode` y a `RestoreFailureCode`; en `src/cli/backup-common.ts` añadir sus entradas a `backupFailureMessages`, `restoreFailureReasons` y a `restoreFailureMessage`, con los mensajes de [contracts/database-tls.md](contracts/database-tls.md) (nombrando `DATABASE_URL` o `BACKUP_VERIFY_URL` según la orden; `restoreFailureReasons.db_tls_unsupported` = `el servidor de la base de datos no acepta TLS` y mensaje largo `<VAR>: el servidor no acepta conexiones TLS.` → `Activa TLS en el servidor PostgreSQL.`); revisar `src/backup/log.ts` para que los eventos que llevan `failure` acepten los códigos nuevos
- [X] T016 [US1] En `src/backup/service.ts`: donde hoy un fallo de conexión se convierte en `db_error` (copia, restauración y conexiones de mantenimiento y de carga de `verifyBackup`), clasificar con `describeDatabaseError` y aplicar la asignación de [contracts/database-tls.md](contracts/database-tls.md): `tls_untrusted` → `db_tls_untrusted`, `tls_unsupported` → `db_tls_unsupported`, `unreachable` → `db_error`, o `verify_db_unavailable` en la conexión de mantenimiento de `verifyBackup` (como hoy); nunca propagar `error.message` (depende de T004, T015)
- [X] T017 [US1] Llamar a `assertCaReadable` antes de crear ningún cliente: en `src/startup.ts` (`startInstance`, sobre `env.DATABASE_URL` y antes de `tryAdvisoryLock`), en `src/db/migrate.ts` (`migrateMain`), y en `src/cli/backup.ts`, `src/cli/restore.ts` y `src/cli/verify.ts` sobre la URL que usa cada orden (`db:verify`: `BACKUP_VERIFY_URL` o, sin ella, `DATABASE_URL`); en las órdenes de copias un `DatabaseConfigError('ca_unreadable')` se informa como `db_ca_unreadable` con el mensaje de [contracts/database-tls.md](contracts/database-tls.md): `db:backup` sale con 1 y `{ ok: false, failure }` (como sus demás fallos); `db:restore` y `db:verify` salen con 2 (configuración), y `db:verify --json` imprime `{ restorable: false, failure: 'db_ca_unreadable', orphans: { listed: false, removed: 0, failed: 0 } }` (no ha llegado a listar) (depende de T004, T015)
- [X] T018 [US1] Exportar `startupErrorMessage(error: unknown): string` en `src/startup.ts` (mensaje propio de `InstanceBusyError`, `DatabaseConfigError` y los errores de migración con copia previa; para cualquier otro, el de `describeDatabaseError(error, 'DATABASE_URL')`) y usarlo en `src/server.ts` en lugar de `(error as Error).message`; el registro sigue usando `serializeError` (012) (depende de T004, T017; hace pasar T010 y la parte de arranque de T009)
- [X] T019 [US1] Ejecutar `pnpm test tests/unit/config tests/unit/provisioning tests/integration/provisioning tests/integration/db tests/integration/backup` y `pnpm typecheck`; corregir regresiones en pruebas existentes que esperaban `trust_proxy_empty` como advertencia en producción o `database_localhost` con la lista antigua (actualizar la expectativa solo cuando el contrato lo cambia)

**Checkpoint**: US1 completa y comprobable por sí sola (MVP).

---

## Phase 4: User Story 2 - La verificación de copias no deja bases temporales con datos accesibles (Priority: P2)

**Goal**: `db:verify` crea bases `verify_<yyyymmddhhmmss UTC>_<16 hex>` sin `CONNECT`/`TEMPORARY`
para `PUBLIC`, limpia antes las huérfanas (patrón exacto, sin conexiones, > 6 h o formato
anterior) con `DROP` sin `FORCE`, y lo informa sin nombres (FR-009–FR-012).

**Independent Test**: [quickstart §5](quickstart.md): con huérfanas simuladas, `db:verify` borra
exactamente las que debe, informa `orphans` en texto y JSON, respeta nombres ajenos, recientes y en
uso, y un usuario sin privilegios no puede conectarse a la temporal durante la verificación.

### Tests for User Story 2 ⚠️

- [X] T020 [P] [US2] Crear `tests/unit/backup/verify-names.test.ts` con reloj falso: `verifyDatabaseName(now, bytes)` da `verify_20261006093000_<16 hex>` con la marca en UTC; `parseVerifyName` reconoce el formato nuevo (con fecha y hora reales), el anterior (`verify_<16 hex>`) y rechaza `verify_abc`, `verify_otra_cosa`, `verify_<16 hex>_x`, `verify_20261340000000_<16 hex>`, `verify_20260230120000_<16 hex>`, mayúsculas en el hex, `chatbot_a` y `postgres`; `selectOrphans(rows, now)` elige solo filas con 0 conexiones y (marca < ahora − 6 h ∨ formato anterior), y descarta marcas en el futuro, de hace menos de 6 h y exactamente 6 h; `VERIFY_MAX_AGE_HOURS === 6`
- [X] T021 [P] [US2] Crear `tests/integration/backup/verify-cleanup.test.ts` (Testcontainers, con la BD de verificación como servidor de `BACKUP_VERIFY_URL`): huérfana de formato nuevo de hace 7 h → borrada; de hace 1 h → respetada; del formato anterior sin conexiones → borrada; del formato anterior con una conexión abierta → respetada y no contada; `verify_x`, `verify_otra_cosa`, `verify_<hex>_extra` y `chatbot_a` → intactas; huérfana antigua cuyo dueño es otro usuario → `failed: 1` y la verificación de la copia sigue siendo correcta; listado imposible (usuario de verificación sin acceso al catálogo simulado con un `query` inyectado que falla) → `listed: false` y verificación correcta; durante la carga (gancho de prueba de `verifyBackup`) un rol `LOGIN` sin privilegios recibe `permission denied for database` al conectarse a la temporal, y la temporal no existe al terminar; salida de `db:verify` en texto con la línea del contrato (`2 borradas.`, `1 borrada, 1 sin poder borrar (…)`, `no se ha podido comprobar el servidor…`), sin línea si no hay nada que contar, y en `--json` el objeto `orphans`; la línea sale también cuando la copia no es restaurable; ninguna salida contiene un nombre de base
- [X] T022 [P] [US2] Ampliar `tests/unit/backup/log.test.ts`: el evento `verify_completed` lleva `orphansListed`, `orphansRemoved` y `orphansFailed`, y ningún nombre de base

### Implementation for User Story 2

- [X] T023 [P] [US2] Crear `src/backup/verify-names.ts` (puro): `VERIFY_MAX_AGE_HOURS = 6`, `verifyDatabaseName(now: Date, random: Buffer)`, `parseVerifyName(name)` → `{ format: 'current', createdAt } | { format: 'legacy' } | null` con `^verify_(\d{14})_([0-9a-f]{16})$` validando la fecha real (reconstruir con `Date.UTC` y comparar campos) y `^verify_[0-9a-f]{16}$`, y `selectOrphans(rows: { name: string; connections: number }[], now: Date): string[]` (data-model §3); hace pasar T020
- [X] T024 [US2] En `src/backup/service.ts` (`verifyBackup`): nombre con `verifyDatabaseName(clock.now(), randomBytes(8))`; antes del `CREATE`, `cleanupOrphans(admin, now)` con la consulta de research R5 (`pg_database` + `pg_stat_activity`, `like 'verify\_%'`), `selectOrphans` y `DROP DATABASE <nombre>` **sin** `FORCE` una por una (`55006` → se respeta sin contar; `42501` u otro → `failed`; fallo del listado → `listed: false`), sin que ningún fallo detenga la verificación; justo después del `CREATE`, `REVOKE CONNECT, TEMPORARY ON DATABASE … FROM PUBLIC` en la misma conexión de mantenimiento y, si falla, borrar la base y terminar con `verify_db_unavailable`; añadir `orphans: { listed, removed, failed }` a `VerifyReport` (también cuando la copia no es restaurable) y un gancho opcional de prueba en las dependencias, llamado tras conectar a la temporal y antes de cargar; actualizar el comentario de la función (`verify_<yyyymmddhhmmss>_<16 hex>`) (depende de T023)
- [X] T025 [US2] En `src/backup/log.ts`: añadir `orphansListed`, `orphansRemoved` y `orphansFailed` al evento `verify_completed` y a su esquema, y rellenarlos en `src/backup/service.ts` desde `report.orphans` (hace pasar T022)
- [X] T026 [US2] En `src/cli/verify.ts`: imprimir la línea de huérfanas de [contracts/verify-cleanup.md](contracts/verify-cleanup.md) antes de la línea de la base temporal, solo si `!listed`, `removed > 0` o `failed > 0`, con singular/plural correcto (`1 borrada`, `2 borradas`), y añadir `orphans` a la salida `--json`; el código de salida sigue dependiendo solo de si la copia es restaurable (0/1/2) (depende de T024; hace pasar T021)

**Checkpoint**: US2 comprobable por sí sola; US1 sigue pasando.

---

## Phase 5: User Story 3 - La imagen es reproducible y dice si la instancia está sana (Priority: P2)

**Goal**: imagen con `HEALTHCHECK` sobre la vista pública de `/health`, base fijada por digest en
las dos etapas, pnpm con hash, versiones exactas, scripts de instalación solo para `argon2` y
`esbuild`, y claves privadas ignoradas por git (FR-013–FR-018).

**Independent Test**: las pruebas estáticas y de la sonda pasan; [quickstart §6](quickstart.md):
`docker image inspect` muestra el `Healthcheck`, el contenedor pasa a `healthy` con BD y a
`unhealthy` sin ella, dos construcciones parten de la misma base y `x.pem`/`x.key`/`x.p12` salen
como ignorados.

### Tests for User Story 3 ⚠️

- [X] T027 [P] [US3] Crear `tests/unit/cli/healthcheck.test.ts`: `probeHealth({ port, fetch?, timeoutMs? })` de `src/cli/healthcheck.ts` contra un `node:http` de prueba en un puerto libre: 200 con `{"status":"ok"}` → 0; 503 `not_ready`, 503 `degraded`, 429, 200 con otro cuerpo, 200 con JSON no válido, 500 → 1; servidor que no responde dentro del plazo (con `timeoutMs` corto) → 1; puerto cerrado → 1; la petición va a `127.0.0.1` y a `/health` sin cabecera `Authorization`; `PORT` ausente usa 3000; no escribe nada en `stdout` ni `stderr`
- [X] T028 [P] [US3] Crear `tests/unit/scripts/image-pinning.test.ts` (lee ficheros del repositorio): hay un `ARG NODE_IMAGE=node:22-slim@sha256:[0-9a-f]{64}` antes del primer `FROM`; toda línea `FROM` usa `${NODE_IMAGE}` o `nombre:etiqueta@sha256:[0-9a-f]{64}`; hay exactamente un `HEALTHCHECK`, con `--start-period=120s`, `--interval=30s`, `--timeout=5s`, `--retries=3` y `CMD ["node", "dist/src/cli/healthcheck.js"]`, sin `curl` ni `wget`; la etapa de construcción copia `.npmrc`; `package.json` tiene `packageManager` que cumple `^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$` y `pnpm.onlyBuiltDependencies` es exactamente `["argon2", "esbuild"]`; `.npmrc` contiene la línea `save-exact=true`
- [X] T029 [P] [US3] Crear `tests/unit/scripts/repo-hygiene.test.ts`: `git check-ignore -q x.pem`, `x.key` y `x.p12` (y en una subcarpeta, `certs/x.pem`) salen con 0, y `git ls-files '*.pem' '*.key' '*.p12'` está vacío (FR-018); se salta con un aviso claro si `git` no está disponible

### Implementation for User Story 3

- [X] T030 [P] [US3] Crear `src/cli/healthcheck.ts`: exporta `probeHealth({ port = Number(process.env.PORT ?? 3000), fetch = globalThis.fetch, timeoutMs = 4000 })` → `Promise<0 | 1>` (`GET http://127.0.0.1:<port>/health`, `AbortSignal.timeout`, 0 solo con 200 y `body.status === 'ok'`, cualquier excepción → 1, sin escribir nada) y, si se ejecuta como programa principal (`import.meta.url` frente a `process.argv[1]`), `process.exit(await probeHealth())`; comprobar que `tsconfig.build.json` lo compila a `dist/src/cli/healthcheck.js` (hace pasar T027)
- [X] T031 [P] [US3] Crear `.npmrc` con `save-exact=true` y un comentario (013, FR-017)
- [X] T032 [P] [US3] Añadir a `.gitignore` el bloque `# Certificados y claves privadas (013): nunca en el repositorio` con `*.pem`, `*.key` y `*.p12` (hace pasar T029)
- [X] T033 [US3] En `package.json`: ejecutar `corepack use pnpm@9.15.0` para que `packageManager` quede con `+sha512.<hash>` y añadir `"pnpm": { "onlyBuiltDependencies": ["argon2", "esbuild"] }` (research R8); ejecutar `pnpm install` y comprobar que `pnpm-lock.yaml` no cambia de versiones, que `argon2` funciona (`pnpm operator:hash-password` con una contraseña de prueba) y que `esbuild`/`tsx` funcionan (`pnpm test:unit`)
- [X] T034 [US3] En `Dockerfile`: obtener el digest del índice multiplataforma con `docker buildx imagetools inspect node:22-slim` y añadir antes del primer `FROM` `ARG NODE_IMAGE=node:22-slim@sha256:<digest>` con un comentario que explique cómo actualizarlo (§5 de la guía); cambiar los dos `FROM node:22-slim` por `FROM ${NODE_IMAGE}` (manteniendo `AS build`); copiar `.npmrc` junto a `package.json` y `pnpm-lock.yaml` en la etapa de construcción; añadir tras `EXPOSE 3000` el `HEALTHCHECK --start-period=120s --start-interval=5s --interval=30s --timeout=5s --retries=3 CMD ["node", "dist/src/cli/healthcheck.js"]` con un comentario (vista pública de `/health`, Docker ≥ 25 para `--start-interval`, Docker no reinicia solo) (depende de T030, T031, T033; hace pasar T028)
- [X] T035 [US3] Construir la imagen (`docker build --build-arg CORE_VERSION=$(node -p "require('./package.json').version") -t chatbot:prueba .`) y comprobar con `docker image inspect chatbot:prueba --format '{{json .Config.Healthcheck}}'` que el `Healthcheck` es el del contrato; arrancarla contra la BD local y comprobar `healthy` en menos de 2 min, y tras `docker compose stop db`, `unhealthy` en menos de 3 min (SC-004, [quickstart §6](quickstart.md)); anotar el resultado en el resumen de la implementación

**Checkpoint**: US3 comprobable por sí sola; US1 y US2 siguen pasando.

---

## Phase 6: User Story 4 - La guía de operación tiene la receta de producción (Priority: P3)

**Goal**: la §2.5 de `docs/operacion-multicliente.md` es la receta de producción, con cada paso,
su ejemplo y su comprobación, y las §2.3, §2.4, §5 y §8 reflejan las reglas nuevas
(FR-019–FR-023).

**Independent Test**: cada fila de [contracts/production-recipe.md](contracts/production-recipe.md)
está en la §2.5 con su comprobación; la receta no nombra proveedor de hosting, cliente ni sector; y
una persona ajena puede seguirla en una máquina limpia (SC-006, [quickstart §7](quickstart.md)).

### Implementation for User Story 4

> Todas las tareas tocan el mismo fichero: van en serie.

- [X] T036 [US4] Reescribir la §2.5 «Despliegue» de `docs/operacion-multicliente.md` como lista numerada con los 12 pasos de [contracts/production-recipe.md](contracts/production-recipe.md), cada uno con su ejemplo (nginx con `proxy_set_header X-Forwarded-For $remote_addr;`, `docker run --read-only --tmpfs /tmp --cap-drop=ALL --security-opt no-new-privileges -p 127.0.0.1:3000:3000 --env-file …`, montaje `:ro` del certificado de la autoridad, `install -d -o 1000 -g 1000 -m 700`, Trivy) y su **comprobación** (`stat`, `docker inspect`, `ss -ltn`, bucle de 31 peticiones con `X-Forwarded-For` falso que da 429, `psql` del verificador rechazado en `chatbot_<id>`, `docker inspect -f '{{.State.Health.Status}}'`); qué hacer con `unhealthy` (`docker inspect --format '{{json .State.Health}}'`, `pnpm instance:versions --only <id>`, Docker no reinicia solo, revisar antes la BD); integración continua con `pnpm install --frozen-lockfile`, `lint`, `typecheck`, `test`, `pnpm audit --prod`, `osv-scanner`, `gitleaks`, `semgrep`, `docker build` y Trivy, y la tabla de qué bloquea la publicación enlazada a la §11.4; nota sobre Docker < 25 y `--start-interval`; sin proveedor de hosting ni nombres de cliente o sector (FR-019–FR-021)
- [X] T037 [US4] Actualizar la §2.3 de `docs/operacion-multicliente.md` (`instance:db`): se niega a conectar con un servidor remoto sin `sslmode=verify-full` en cualquier perfil (texto de `admin_url_tls_required`) y la alternativa `--print-sql --host --port`; opción `--sslrootcert <ruta del contenedor>`; `verify-full` por defecto con `--print-sql` y `--host` remoto; la conexión de prueba usa el `sslrootcert` de la URL de administración
- [X] T038 [US4] Actualizar la tabla de variables de la §2.4 de `docs/operacion-multicliente.md`: `TRUST_PROXY` obligatorio con `PUBLIC_BASE_URL` https (error `trust_proxy_empty` en producción, advertencia en pruebas); `DATABASE_URL` e `INSTANCE_DB_ADMIN_URL` con `sslmode=verify-full` (y `sslrootcert` si la autoridad no es pública) cuando el host es remoto (`database_tls_required`); fila nueva de `BACKUP_VERIFY_URL` con la misma regla y `database_url_invalid`; recordar que las variables `PG*` no cuentan (FR-022)
- [X] T039 [US4] Actualizar la §5 de `docs/operacion-multicliente.md`: aviso de que desde la versión con la 013 entornos que daban APTO con advertencias pueden dar NO APTO (`trust_proxy_empty`, `database_tls_required`) y que hay que pasar cada entorno por `instance:check` y corregirlo antes de su tanda (en §5.1); cómo actualizar el digest de `NODE_IMAGE` (inspeccionar, cambiar el `ARG`, construir, pasar las pruebas, publicar como versión nueva) (FR-023)
- [X] T040 [US4] Actualizar la §8 de `docs/operacion-multicliente.md`: `db:verify` limpia las bases temporales huérfanas (patrón, 6 h, formato anterior, `DROP` sin `FORCE`), qué significa cada variante de la línea `Bases temporales huérfanas: …` y del objeto `orphans` del JSON, que las temporales ya no admiten conexiones de otros usuarios, y la recomendación de un único usuario de verificación por servidor

**Checkpoint**: las cuatro historias completas.

---

## Phase 6b: Ampliación - IP literal en la URL (aclaración posterior a la implementación)

**Purpose**: con una IP en la URL, `pg` no pasa la dirección a TLS y Node compara el certificado
con `localhost`, así que `verify-full` no comprueba el nombre (spec, Clarifications; FR-003).

- [X] T048 [US1] Ampliar `tests/unit/config/database-url.test.ts`, `tests/unit/provisioning/check.test.ts` y `tests/integration/provisioning/cli-db.test.ts` (deben fallar): `classifyDatabaseUrl` da `verifiedTls: false` e `ipHost: true` con un host remoto IPv4 o IPv6 y `verify-full`, y `ipHost: false` con un nombre; `instance:check` da `database_tls_ip_host` (error en producción, advertencia en pruebas) en las tres variables, sin `database_tls_required` y con los textos de [contracts/check-rules.md](contracts/check-rules.md); un host local IP (`127.0.0.1`, `::1`) no da nada; `instance:db` con `postgres://admin:x@10.0.0.5/postgres?sslmode=verify-full` sale con 1 con `admin_url_ip_host`, sin conectar ni abrir el inventario
- [X] T049 [US1] En `src/config/database-url.ts` añadir `ipHost` a la clasificación y no contar como `verifiedTls` un host remoto IP; en `src/provisioning/messages.ts` añadir `database_tls_ip_host` y `admin_url_ip_host`; en `src/provisioning/check.ts` y `src/cli/instance.ts` aplicar el código propio antes que `database_tls_required` / `admin_url_tls_required` (hace pasar T048)
- [X] T050 [US4] Actualizar `docs/operacion-multicliente.md` (§2.3, §2.4 y paso 4 de la §2.5) con la regla nueva

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: comprobaciones globales y cierre de la feature.

- [X] T041 [P] Revisar que ningún texto nuevo de `src/` lleva URL, host, ruta ni nombres de certificado: `grep` de `error.message`, `.message}` y `${url` en `src/config/database-url.ts`, `src/provisioning/`, `src/backup/service.ts`, `src/cli/` y `src/server.ts`, y corregir lo que aparezca (SC-002)
- [X] T042 [P] Ejecutar `tests/unit/sector-neutrality.test.ts` y `tests/unit/isolation.test.ts`, y comprobar que `src/config/database-url.ts` y `src/backup/verify-names.ts` no importan Fastify ni `pg`
- [X] T043 Ejecutar `pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:integration` y dejar todo en verde
- [X] T044 Recorrer a mano [quickstart.md](quickstart.md) §2–§6 (incluido el script `postinstall` no autorizado en una rama de prueba descartada después y la construcción doble con la misma base, SC-005) y anotar cualquier diferencia como fallo de la implementación o de la receta
- [X] T044b **Cerrada por decisión del usuario (2026-10-06)**: el proyecto lo lleva una sola persona, así que no hay nadie ajeno que pueda validar la receta; se valida en el primer despliegue en producción, siguiendo la §2.5 paso a paso. Texto original: una persona que no haya trabajado en la feature sigue solo la §2.5 de `docs/operacion-multicliente.md` en una máquina limpia con la imagen de T035 y recorre [quickstart §7](quickstart.md); cada comprobación de [contracts/production-recipe.md](contracts/production-recipe.md) debe cumplirse (en especial, el puerto 3000 no responde desde fuera y la petición 31 con `X-Forwarded-For` falso da 429), y cada duda o pregunta se anota como fallo de la receta y se corrige en T036–T040 antes de T046 (SC-006)
- [X] T045 **Avisar al usuario** y, tras su conformidad, actualizar `README.md` con el estado de la feature 013 (requisitos de despliegue seguro: reglas nuevas de `instance:check`, `instance:db` con TLS verificado, limpieza de `db:verify`, `HEALTHCHECK` e imagen fijada, receta §2.5)
- [X] T046 **Avisar al usuario** y, tras su conformidad, actualizar `docs/operacion-multicliente.md`: fila de la 013 en la tabla de la §9.1 con la fecha de cierre, orden de la §9.2 sin P9 pendiente, propuesta P9 marcada como hecha, y referencia en la §11.6 a los hallazgos de la auditoría del 2026-10-05 que quedan cerrados
- [X] T047 Revisar el bloque de órdenes de `CLAUDE.md` y añadir `[--sslrootcert <ruta>]` a `pnpm instance:db <id>` si se documentan sus opciones allí

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias.
- **Foundational (Phase 2)**: T004 depende de T003. Bloquea US1.
- **US1 (Phase 3)**: depende de Phase 2 y de T001/T002.
- **US2 (Phase 4)**: solo depende de Setup; puede ir en paralelo con US1. Si US1 ya está hecha,
  T024 hereda la clasificación de errores de T016 en `src/backup/service.ts` (mismo fichero: no
  trabajar T016 y T024 a la vez).
- **US3 (Phase 5)**: sin dependencias de código con US1 ni US2; puede empezar al acabar Setup.
- **US4 (Phase 6)**: depende del contenido de US1–US3 (textos, opciones, parámetros reales del
  `HEALTHCHECK` y del digest).
- **Polish (Phase 7)**: depende de todas las historias. T046 (cerrar P9 en la guía) espera a
  T044b (validación de la receta por una persona ajena).

### Dependencias dentro de las historias

- US1: T005–T010 (tests) → T011 → T012; T013 → T014; T015 → T016, T017 → T018 → T019.
- US2: T020–T022 (tests) → T023 → T024 → T025, T026.
- US3: T027–T029 (tests) → T030, T031, T032 en paralelo → T033 → T034 → T035.
- US4: T036 → T037 → T038 → T039 → T040 (mismo fichero).

### Ficheros compartidos entre tareas

- `src/backup/service.ts`: T016 (US1), T024 y T025 (US2).
- `src/cli/verify.ts`: T017 (US1) y T026 (US2).
- `src/backup/log.ts`: T015 (US1) y T025 (US2).
- `docs/operacion-multicliente.md`: T036–T040 y T046.

---

## Parallel Example: User Story 1

```bash
# Tests de US1, en paralelo (ficheros distintos):
Task: "T005 Ampliar tests/unit/provisioning/check.test.ts (reglas por perfil, paridad, sin valores)"
Task: "T006 Ampliar tests/unit/provisioning/database.test.ts (parseAdminUrl, buildDatabaseUrl, sslrootcert)"
Task: "T007 Ampliar tests/integration/provisioning/cli-db.test.ts (admin_url_tls_required sin conectar)"
Task: "T008 Ampliar tests/integration/provisioning/cli-check.test.ts (tabla del quickstart §2)"
Task: "T009 Crear tests/integration/db/tls.test.ts (verify-full en cada camino)"
Task: "T010 Crear tests/unit/config/startup-error.test.ts"
```

## Parallel Example: User Story 2

```bash
Task: "T020 Crear tests/unit/backup/verify-names.test.ts"
Task: "T021 Crear tests/integration/backup/verify-cleanup.test.ts"
Task: "T022 Ampliar tests/unit/backup/log.test.ts"
```

## Parallel Example: User Story 3

```bash
Task: "T027 Crear tests/unit/cli/healthcheck.test.ts"
Task: "T028 Crear tests/unit/scripts/image-pinning.test.ts"
Task: "T029 Crear tests/unit/scripts/repo-hygiene.test.ts"
# Después, en paralelo:
Task: "T030 Crear src/cli/healthcheck.ts"
Task: "T031 Crear .npmrc"
Task: "T032 Añadir claves privadas a .gitignore"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 (Setup) y Phase 2 (Foundational).
2. Phase 3 (US1): `instance:check` bloquea los tres fallos, `instance:db` exige TLS verificado y
   la instancia funciona con `verify-full`.
3. **Parar y validar** con el [quickstart §2–§4](quickstart.md). Con esto, el despliegue seguro ya
   no depende de la memoria del operador en lo que más importa.

### Incremental Delivery

1. Setup + Foundational → base lista.
2. US1 → validar → MVP.
3. US2 (limpieza y permisos de `db:verify`) → validar con el quickstart §5.
4. US3 (imagen y repositorio) → validar con el quickstart §6.
5. US4 (receta y guía) → validar con el quickstart §7.
6. Polish y cierre (validación de la receta por una persona ajena, README y guía, avisando antes
   al usuario).

### Parallel Team Strategy

1. Entre todos: Setup + Foundational.
2. Después:
   - Persona A: US1.
   - Persona B: US2 (coordinando con A en `src/backup/service.ts` y `src/cli/verify.ts`).
   - Persona C: US3.
3. US4 cuando US1–US3 estén cerradas.

---

## Notes

- [P] = ficheros distintos y sin dependencias pendientes.
- La etiqueta [Story] enlaza cada tarea con su historia.
- Escribir los tests primero y comprobar que fallan.
- Confirmar tras cada tarea o grupo lógico.
- No editar migraciones publicadas ni añadir ninguna: esta feature no tiene migración.
