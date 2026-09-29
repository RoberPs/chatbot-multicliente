---

description: "Lista de tareas de la feature 006: copias de seguridad y restauración por instancia"
---

# Tasks: Copias de seguridad y restauración por instancia

**Input**: documentos de diseño de `/specs/006-instance-backup-restore/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Ámbito**: Núcleo

**Tests**: se incluyen. El plan fija las suites `unit` (formato, nombres, retención, programación,
configuración) e `integration` (Testcontainers: ciclo completo, rechazos, atomicidad, arranque,
retención, comprobación, copia diaria, registros). No hay tests `contract` ni `eval`: no cambia
ninguna ruta HTTP ni la conversación. Los tests de cada historia se escriben primero y deben
fallar antes de implementar.

**Organization**: por historia de usuario. La fase fundacional deja preparados la configuración,
el formato `CBAK` v1, los nombres, la versión del esquema (incluida la reconstrucción hasta un
índice), los bloqueos, los errores, los registros y los helpers de test; no cambia el arranque ni
crea ningún comando. Cada historia añade después su operación, su comando y sus pruebas.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede hacer en paralelo (ficheros distintos, sin dependencias pendientes)
- **[Story]**: historia a la que pertenece (US1…US6)
- Rutas desde la raíz del repositorio (proyecto único: `src/`, `tests/`)

## Reglas que aplican a todas las tareas

- `src/backup` es un módulo de operación: no importa Fastify ni nada de `src/admin`,
  `src/channels` o de la cadena de respuesta; habla con PostgreSQL por `pg` (+ `pg-copy-streams`)
  y con el disco por `node:fs`. Cifrado, HKDF y gzip solo con `node:crypto` y `node:zlib`.
- En `src/` no puede haber nombres ni lógica de sector o cliente (FR-023): las tablas se leen del
  catálogo de PostgreSQL, nunca se enumeran a mano. Los datos de ejemplo, solo en `tests/fixtures/`.
- Registros con el catálogo cerrado de [contracts/backup-log.md](contracts/backup-log.md): nunca
  rutas completas, mensajes de error de PostgreSQL, textos, teléfonos, nombres ni la clave (FR-024).
- Ningún fichero con nombre de copia puede quedar a medias (FR-006): se escribe
  `.<nombre>.partial`, `fsync` y `rename`.
- Toda restauración es una única transacción; cualquier rechazo deja la BD sin ningún cambio
  (FR-011, SC-008). La restauración no pasa por la escritura protegida (FR-032 de la 001): deja el
  estado de la copia tal cual (plan, Consecuencias).
- El orden de arranque vive en `src/startup.ts` (`startInstance`), con dependencias inyectables
  para poder probarlo; `src/server.ts` solo carga el entorno, lo invoca y conecta las señales.
- Las horas de la copia diaria van en hora local del negocio con su zona IANA; la fecha del nombre
  del fichero y `createdAt` son marcas técnicas en UTC.
- No hay migraciones nuevas. Las migraciones publicadas no se editan (la restauración compara su
  hash, R5).
- Textos, comentarios y mensajes en español.

---

## Phase 1: Setup (infraestructura compartida)

**Purpose**: dependencia de `COPY` en flujo, scripts de los comandos y variables de ejemplo.

- [ ] T001 Añadir `pg-copy-streams` (dependencia) y `@types/pg-copy-streams` (desarrollo) con `pnpm add` en `package.json` y `pnpm-lock.yaml`
- [ ] T002 [P] Añadir a `package.json` los scripts `db:backup` (`tsx src/cli/backup.ts`), `db:restore` (`tsx src/cli/restore.ts`), `db:verify` (`tsx src/cli/verify.ts`) y `db:backups` (`tsx src/cli/backups.ts`)
- [ ] T003 [P] Añadir a `.env.example` el bloque "Copias de seguridad (feature 006)" con `INSTANCE_ID`, `BACKUP_DIR`, `BACKUP_KEY` (con la instrucción `openssl rand -hex 32` y el aviso de guardarla fuera de `BACKUP_DIR`), `BACKUP_KEYS_PREVIOUS`, `BACKUP_RETENTION_DAYS=7`, `BACKUP_DAILY_TIME=03:00` y `BACKUP_VERIFY_URL`, explicando que en `production` las tres primeras son obligatorias

---

## Phase 2: Foundational (prerrequisitos bloqueantes)

**Purpose**: configuración validada, formato de fichero, nombres, versión del esquema, bloqueos,
errores, registros y helpers de test. Nada de esto cambia todavía el arranque del servidor.

**⚠️ CRITICAL**: ninguna historia puede empezar hasta terminar esta fase.

### Tests fundacionales (escribir primero, deben fallar)

- [ ] T004 [P] Ampliar `tests/unit/env.test.ts` con la configuración de copias: `INSTANCE_ID`/`BACKUP_DIR`/`BACKUP_KEY` van juntas o ninguna (`env.backup` = `null`); en `production` faltar cualquiera es error; `INSTANCE_ID` con el patrón `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`; `BACKUP_DIR` ruta absoluta; `BACKUP_KEY` 64 hex, no repetitiva (misma regla que `SESSION_SECRET`) y distinta de `SESSION_SECRET`; `BACKUP_KEYS_PREVIOUS` lista de 64 hex separada por comas; `BACKUP_RETENTION_DAYS` por defecto 7, 0 y 31 rechazados con "BACKUP_RETENTION_DAYS debe estar entre 1 y 30 días (máximo 30)"; `BACKUP_DAILY_TIME` `HH:MM` 24 h por defecto `03:00`; `BACKUP_VERIFY_URL` por defecto `DATABASE_URL`
- [ ] T005 [P] Crear `tests/unit/backup/naming.test.ts`: `backupFileName` produce `<instancia>__<0004>_<tag>__<AAAAMMDDTHHMMSSZ>__<motivo>.cbak` (fecha en UTC); el patrón de [data-model.md](data-model.md#copia-backupfile) acepta los tres motivos y rechaza `.partial`, otros sufijos, motivos desconocidos, mayúsculas y nombres parecidos (`demo-01__x.cbak`, `demo-01__0004_handoff__20260929T101500Z__manual.cbak.bak`); `partialName` empieza por punto y termina en `.partial`
- [ ] T006 [P] Crear `tests/unit/backup/format.test.ts` para CBAK v1 ([contracts/backup-file-format.md](contracts/backup-file-format.md)): ida y vuelta con varios tamaños (vacío, < 64 KiB, exactamente 64 KiB, varios bloques; todos salvo el último de 65 536 bytes); byte cambiado en un bloque → `corrupted`; fichero truncado (sin bloque final) → `corrupted`; bloques reordenados → `corrupted`; bytes sobrantes tras el último → `corrupted`; cabecera manipulada (un recuento cambiado) → `corrupted`; clave incorrecta → `wrong_key` con el `keyId` de la cabecera; clave anterior en la lista de lectura → descifra; firma distinta o cabecera no JSON → `not_a_backup`; `formatVersion: 2` → `unsupported_format`; campo desconocido en la cabecera → rechazo (Zod estricto); `readHeader` lee la cabecera sin clave; el fichero no contiene en claro una cadena conocida del volcado
- [ ] T007 [P] Crear `tests/unit/backup/log.test.ts`: cada evento del catálogo de [contracts/backup-log.md](contracts/backup-log.md) sale con `channel: 'backup'`, su nivel y solo sus campos; un campo no previsto se descarta; `restore_completed` es `warn`

### Implementación fundacional

- [ ] T008 Ampliar `src/config/env.ts` con las variables de copias (validación Zod, mismas reglas y mensajes que T004) y exponer `env.backup: BackupEnv | null` (`instanceId`, `dir`, `key`, `previousKeys`) agrupado como `WHATSAPP_*`, más `BACKUP_RETENTION_DAYS`, `BACKUP_DAILY_TIME` y `BACKUP_VERIFY_URL` siempre con su valor por defecto; en `production` `env.backup = null` es error de configuración
- [ ] T009 [P] Crear `src/backup/errors.ts` con los códigos cerrados de copia (`key_missing`, `key_invalid`, `dir_missing`, `dir_not_writable`, `no_space`, `busy`, `db_error`, `io_error`) y de restauración/comprobación (`not_a_backup`, `unsupported_format`, `key_missing`, `key_invalid`, `wrong_key`, `corrupted`, `other_instance`, `schema_newer`, `schema_mismatch`, `instance_running`, `count_mismatch`, `db_error`, `verify_db_unavailable`), las clases `BackupError`, `RestoreFailure` (con `code` y datos sin datos personales, p. ej. `keyId`, esquema y `coreVersion` de la copia) y `MigrationBlockedError` (`pending`, `failure` incluido `backup_not_configured`), y una función que traduce errores de sistema (`ENOENT`, `EACCES`/`EPERM`/`EROFS`, `ENOSPC`) a esos códigos sin conservar el mensaje original
- [ ] T010 [P] Crear `src/backup/log.ts` con el catálogo cerrado de eventos (`backup_created`, `backup_failed`, `backup_disabled`, `backup_retention_applied`, `migration_blocked`, `migration_failed`, `restore_completed`, `restore_rejected`, `verify_completed`) sobre `LoggerLike` de `src/conversation/activity-log.ts`, con lista blanca de campos por evento (hace pasar T007)
- [ ] T011 [P] Crear `src/backup/config.ts`: tipo `BackupConfig` (`instanceId`, `dir`, `key`, `readKeys`, `retentionDays`, `dailyTime`, `verifyUrl`) construido desde `Env`; `deriveFileKey(key, salt)` = HKDF-SHA256 con info `chatbot-backup/v1/data`; `keyId(key)` = 8 primeros bytes de HKDF con sal vacía e info `chatbot-backup/v1/key-id`, en hex; `findReadKey(config, keyId)` que busca entre `BACKUP_KEY` y `BACKUP_KEYS_PREVIOUS`; `coreVersion()` que lee `version` del `package.json` del núcleo (válido con `tsx` y desde `dist/`)
- [ ] T012 [P] Crear `src/backup/naming.ts` con `backupFileName({ instanceId, schema, createdAt, reason })`, `BACKUP_NAME_PATTERN`, `isBackupName`, `partialName(name)` e `isOwnPartial(name, instanceId)` (hace pasar T005)
- [ ] T013 Crear `src/backup/format.ts` (CBAK v1): esquema Zod estricto de la cabecera; `createBackupWriter(header, key)` que recibe el volcado en claro, lo pasa por gzip, lo parte en bloques de 65 536 bytes y escribe firma `CBAK\0\0\0\1`, longitud de cabecera (uint32 BE, ≤ 64 KiB), cabecera y bloques AES-256-GCM (nonce = contador de 11 bytes BE + byte de último; AAD = SHA-256 de la cabecera); `readHeader(path)` sin clave; `authenticateHeader(path, keys)` que descifra solo el primer bloque; `openBackup(path, keys)` que devuelve la cabecera y un flujo del volcado en claro que falla con `RestoreFailure('corrupted')` ante cualquier bloque no autenticado, contador fuera de orden, falta de bloque final o bytes sobrantes (hace pasar T006; depende de T009, T011)
- [ ] T014 Crear `src/backup/schema-version.ts` con `installedSchema()` (última migración del journal, con índice, `tag` y hash vía `readMigrationFiles` de `drizzle-orm/migrator` sobre `src/db/migrations`), `databaseSchema(client)` (última fila de `drizzle.__drizzle_migrations` cruzada por `created_at` = `folderMillis`, o `empty` si no existe la tabla o no tiene filas), `pendingMigrations(client)` (misma regla que `PgDialect.migrate`) y `applyMigrationsUpTo(client, index)`: ejecuta en la transacción recibida los SQL de las migraciones `0..index` (troceados por `--> statement-breakpoint` como Drizzle) e inserta en `drizzle.__drizzle_migrations` sus filas con el mismo `hash` y `created_at` que escribiría el migrador, creando antes el esquema y la tabla de migraciones si no existen
- [ ] T015 [P] Crear `src/backup/locks.ts` con las claves constantes `INSTANCE_RUNNING` y `BACKUP_IN_PROGRESS` y `tryAdvisoryLock(url, key)` que abre una conexión `pg` propia, hace `pg_try_advisory_lock` y devuelve `{ release() } | null` (liberar = `pg_advisory_unlock` + cerrar la conexión)
- [ ] T016 Crear `tests/helpers/backup.ts`: directorio `BACKUP_DIR` temporal por test (y su borrado), dos claves de test aleatorias, `testBackupConfig(overrides)`, `seedInstance(db, fixture = allFixtures[0])` que acepta cualquier fixture de `tests/fixtures/load.ts` y añade conversaciones y mensajes de ejemplo (alguna con último mensaje de hace más de 30 días respecto al reloj del test), `tableSnapshot(url)` que devuelve todas las filas de todas las tablas de `public` y `drizzle` ordenadas y los valores de las secuencias (igualdad tabla a tabla), `createDatabaseMigratedUpTo(index)` (BD vacía nueva migrada hasta un índice con `applyMigrationsUpTo`), `captureLogger()` y un reloj controlable
- [ ] T017 [P] Crear `tests/integration/backup/schema-version.test.ts`: BD recién creada vacía → `databaseSchema` = `empty` y todas pendientes; BD de la plantilla → última migración del journal y ninguna pendiente; `installedSchema().tag` = `0004_handoff` con el hash que calcula Drizzle; `applyMigrationsUpTo(3)` en una BD vacía deja `databaseSchema` = `0003_map_url`, `pendingMigrations` = `[0004_handoff]`, y el migrador normal de Drizzle aplica después solo la `0004`

**Checkpoint**: configuración, formato y utilidades listos y probados; el arranque sigue igual.

---

## Phase 3: User Story 1 - El operador hace una copia de una instancia (Priority: P1) 🎯 MVP

**Goal**: `pnpm db:backup` crea un único fichero `.cbak` cifrado, coherente de un único instante,
con nombre y resumen sin datos personales, sin pausar al bot y sin dejar ficheros a medias.

**Independent Test**: con una instancia con datos de `tests/fixtures/`, pedir una copia y
comprobar que hay un único fichero, que su contenido no es legible sin la clave y que nombre y
resumen identifican instancia, esquema y fecha (quickstart B-1, B-2, B-3).

### Tests for User Story 1 ⚠️

- [ ] T018 [P] [US1] Crear `tests/integration/backup/backup.test.ts`: con `seedInstance`, `createBackup` deja un único fichero que cumple el patrón con motivo `manual`; la cabecera tiene `instanceId`, `schema` = `databaseSchema`, `coreVersion` del `package.json`, `createdAt` del reloj y recuentos iguales a `count(*)` de cada tabla de `public` y `drizzle`; el fichero no contiene en claro el nombre del negocio, teléfonos ni textos de mensajes de la fixture; el informe tiene `file` (sin ruta), `sizeBytes`, `schema`, `tables`, `durationMs`; permisos `0600` en sistemas POSIX; sin clave → `key_missing`, directorio inexistente → `dir_missing`, directorio de solo lectura → `dir_not_writable` (se omite en Windows si no se puede simular), y en los tres casos ni `.cbak` ni `.partial`; con el bloqueo `BACKUP_IN_PROGRESS` tomado por otra conexión → `busy`; un fallo a mitad de escritura (flujo de destino que falla) borra el `.partial`; un `.partial` propio de hace más de 1 h se borra en la siguiente copia y uno reciente o de otra instancia no; `backup_created` y `backup_failed` registrados con sus campos
- [ ] T019 [P] [US1] Crear `tests/integration/backup/concurrency.test.ts`: mientras la copia vuelca (flujo de destino ralentizado), otra conexión inserta conversaciones y mensajes y actualiza el negocio sin quedar bloqueada (cada escritura termina en < 1 s); las escrituras concurrentes se lanzan cuando el volcador ha emitido su primer registro `table` (sincronización por evento, no por tiempos); al leer la copia con `openBackup`, los recuentos del volcado coinciden con la cabecera y con el estado anterior a las escrituras concurrentes (un único instante, FR-002)
- [ ] T020 [P] [US1] Crear `tests/integration/backup/backup-cli.test.ts`: `main(['--json'])` de `src/cli/backup.ts` con entorno inyectado devuelve 0 e imprime un JSON de una línea con el informe; la salida legible incluye nombre, tamaño, esquema, núcleo, fecha local en la zona del negocio y recuentos por tabla; sin `BACKUP_KEY` → código 1 con el mensaje de `key_missing` del contrato; `BACKUP_RETENTION_DAYS=31` → código 2 con el mensaje del máximo; ninguna salida contiene la clave

### Implementation for User Story 1

- [ ] T021 [US1] Crear en `src/backup/dump.ts` el volcador: en una conexión `pg` propia abre `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, lee `databaseSchema`, lista del catálogo las tablas de `public` y `drizzle` (orden alfabético) con sus columnas, cuenta filas, lee las secuencias (`last_value`, `is_called`) y emite como flujo los registros del volcado (`begin`, `table` + filas de `COPY "schema"."tabla" (columnas…) TO STDOUT` + `\.`, `sequences`, `end`) según [contracts/backup-file-format.md](contracts/backup-file-format.md); devuelve también cabecera parcial (`schema`, `tables`) antes de empezar a emitir filas
- [ ] T022 [US1] Crear `src/backup/service.ts` con `createBackup({ databaseUrl, config, reason, clock, logger })`: valida clave (`key_missing`/`key_invalid`); toma `BACKUP_IN_PROGRESS` con `tryAdvisoryLock` (`busy`); comprueba que `BACKUP_DIR` existe, es directorio y es escribible (`dir_missing`/`dir_not_writable`); borra `.partial` propios de más de 1 h; escribe `.<nombre>.partial` con modo `0600` encadenando `dump` → `createBackupWriter`; `fsync`, `rename` al nombre final y `fsync` del directorio; ante cualquier fallo borra el parcial y traduce el error a su código (`no_space`, `io_error`, `db_error`); libera el bloqueo siempre; devuelve `BackupReport` y registra `backup_created`/`backup_failed` (hace pasar T018, T019)
- [ ] T023 [P] [US1] Crear `src/cli/backup-common.ts` con lo compartido por los cuatro comandos: lectura de argumentos, carga de `loadDotEnvIfPresent` + `loadEnv` con salida 2 y mensaje ante configuración no válida, resolución de `<fichero>` (nombre en `BACKUP_DIR` o ruta), formato de tamaños y recuentos en español, fecha local con la zona horaria del negocio leída de la BD, impresión `--json` en una línea y mapa de códigos de fallo a los mensajes de [contracts/backup-commands.md](contracts/backup-commands.md)
- [ ] T024 [US1] Crear `src/cli/backup.ts` con `main(argv, io)` exportada (testeable) y ejecución directa como en `src/db/migrate.ts`: construye `BackupConfig`, llama a `createBackup` con motivo `manual` y reloj del sistema, imprime el informe legible o `--json` y sale con 0/1/2 (hace pasar T020)

**Checkpoint**: la US1 funciona sola: `pnpm db:backup` protege ya a un cliente real.

---

## Phase 4: User Story 2 - El operador restaura una copia (Priority: P1)

**Goal**: `pnpm db:restore` devuelve la instancia parada exactamente al estado de la copia, en una
única transacción, tras comprobar la copia entera, y rechaza sin tocar nada las copias dañadas, de
otra clave, de otra instancia o de un esquema posterior. Las conversaciones que ya superan los 30
días se borran antes de que el servidor escuche.

**Independent Test**: copia → cambiar el nombre del negocio y borrar un servicio → restaurar →
panel y `pnpm kb:snapshot` como en la copia (quickstart B-4, B-5, B-6).

### Tests for User Story 2 ⚠️

- [ ] T025 [P] [US2] Crear `tests/integration/backup/backup-restore.test.ts` con `it.each(allFixtures)` (FR-023): para cada sector, con `seedInstance(db, fixture)`, `tableSnapshot` antes de copiar; copia; cambiar el nombre del negocio, borrar un servicio, añadir una conversación, cambiar `business.status` y `web_chat_settings.enabled`; `restoreBackup` → `tableSnapshot` idéntico al inicial (filas, `drizzle.__drizzle_migrations` y secuencias: el siguiente `nextval` es el mismo) y `KnowledgeReader.getSnapshot()` igual al de antes de los cambios (SC-002); el estado del negocio y del chat web es el de la copia (FR-013); el informe trae recuentos por tabla, `pendingMigrations` vacía y `expiredConversations` = conversaciones de la fixture con más de 30 días; tras `createRetention(...).purge()` con el mismo reloj ninguna de ellas existe (SC-005); `restore_completed` registrado
- [ ] T026 [P] [US2] Crear `tests/integration/backup/restore-atomic.test.ts`: un fallo inyectado durante la carga (opción interna de prueba de `restoreInto` que lanza tras cargar la N-ésima tabla) y un `count_mismatch` provocado deshacen todo: `tableSnapshot` y `databaseSchema` quedan como antes de empezar (US2-7, FR-011); la conexión queda utilizable
- [ ] T027 [P] [US2] Crear `tests/integration/backup/rejections.test.ts`, comprobando en cada caso que `tableSnapshot` no cambia, que el código es el esperado y que se registra `restore_rejected`: byte cambiado → `corrupted`; truncado → `corrupted`; fichero ajeno → `not_a_backup`; `BACKUP_KEY` distinta → `wrong_key` con el `keyId` y sin la clave en el mensaje; misma copia con la clave anterior en `BACKUP_KEYS_PREVIOUS` → restaura; copia de otra instancia sin `fromInstance` o con otro valor → `other_instance`, con `fromInstance` igual a la cabecera → restaura; copia con índice de esquema mayor que el instalado (escrita con `createBackupWriter` y cabecera forjada con la clave de test) → `schema_newer` con el `coreVersion` de la copia; mismo índice con otro hash → `schema_mismatch`; bloqueo `INSTANCE_RUNNING` tomado por otra conexión → `instance_running`; mientras una restauración tiene el bloqueo, `tryAdvisoryLock(INSTANCE_RUNNING)` de otro proceso devuelve `null`
- [ ] T028 [P] [US2] Crear `tests/integration/backup/older-schema.test.ts`: en una BD de `createDatabaseMigratedUpTo(3)` con datos insertados con SQL compatible con `0003`, copia (cabecera con `0003_map_url`); restaurarla en una BD con el esquema actual deja `databaseSchema` = `0003_map_url`, `pendingMigrations` = `[0004_handoff]`, no queda ningún objeto de `0004` (tablas de derivación inexistentes) y el informe lo anuncia como migración pendiente
- [ ] T029 [P] [US2] Crear `tests/integration/backup/restore-cli.test.ts`: `main` de `src/cli/restore.ts` sin `--yes` muestra el resumen y pide el `INSTANCE_ID` destino; escribir otro valor cancela sin tocar la BD (código 1); escribir el correcto restaura (código 0); stdin no interactivo sin `--yes` → código 2; `--from-instance` se pasa a la restauración; `--json` imprime el `RestoreReport`; los mensajes de rechazo son los de [contracts/backup-commands.md](contracts/backup-commands.md)
- [ ] T030 [P] [US2] Crear `tests/integration/backup/startup.test.ts`: con una conversación de hace más de 30 días, `startInstance` con un `listen` espía comprueba, en el momento de llamarlo, que esa conversación ya no existe (SC-005, R11)

### Implementation for User Story 2

- [ ] T031 [US2] Añadir a `src/backup/dump.ts` el lector del volcado: recorre el flujo en claro de `openBackup`, valida cada registro (`begin` con el mismo esquema que la cabecera, `table` con `rows` igual a la cabecera, terminador `\.`, `sequences`, `end.tables`) y ofrece por tabla sus columnas y un flujo de filas en formato `COPY` texto; cualquier desajuste → `RestoreFailure('corrupted')`
- [ ] T032 [US2] Añadir a `src/backup/service.ts` `restoreInto(client, file, { config, fromInstance, acceptAnyInstance })` en dos pasadas (research R6): (1) comprobación previa completa sin tocar la BD — cabecera, clave (`findReadKey`), todos los bloques y el volcado hasta `end`, instancia (`other_instance`) y esquema (`schema_newer` si el índice supera el instalado, `schema_mismatch` si el hash no coincide); (2) una transacción con `SET LOCAL lock_timeout = '5s'` que vacía el contenido de `public` y `drizzle` (tablas, secuencias y tipos, sin borrar los esquemas), `applyMigrationsUpTo(N)` (T014), comprueba que las tablas reconstruidas son las de la cabecera, carga con `COPY … FROM STDIN` en orden de dependencias calculado de `pg_constraint`, fija las secuencias con `setval`, recuenta contra la cabecera (`count_mismatch`) y hace `COMMIT`; ante cualquier error `ROLLBACK` y código cerrado (`db_error` sin el mensaje de PostgreSQL); no recalcula avisos ni revierte por avisos críticos (excepción a FR-032, plan); devuelve recuentos, `expiredConversations` (conversaciones sin mensajes en los últimos 30 días según `conversationSettings`, 0 si el esquema de la copia no tiene esas tablas) y `pendingMigrations`
- [ ] T033 [US2] Añadir a `src/backup/service.ts` `restoreBackup({ databaseUrl, file, config, fromInstance, clock, logger })`: toma `INSTANCE_RUNNING` con `tryAdvisoryLock` (`instance_running` si no puede) y lo mantiene durante `restoreInto`; registra `restore_completed` (con `crossInstance`) o `restore_rejected`; libera siempre (hace pasar T025–T028)
- [ ] T034 [US2] Crear `src/cli/restore.ts` con `main(argv, io)`: `<fichero> [--from-instance <id>] [--yes] [--json]`, resumen de la cabecera y confirmación escribiendo el `INSTANCE_ID` destino (con `node:readline`), código 2 si stdin no es interactivo y falta `--yes`, salida legible con migraciones pendientes y conversaciones que se borrarán al arrancar, o `--json` (hace pasar T029)
- [ ] T035 [US2] Crear `src/startup.ts` con `startInstance({ env, clock, logger, buildApp, listen })` que migra, crea un `createRetention` propio (independiente de que haya bot, con `createActivityLog` y el reloj recibido) y **espera** a `purge()` antes de llamar a `listen`; después arranca procesador y retención horaria del bot como hasta ahora; devuelve `{ stop() }` con el cierre ordenado actual. Cambiar `src/server.ts` para que solo cargue el entorno, llame a `startInstance` y conecte `SIGINT`/`SIGTERM` a `stop()` (research R11, FR-012; hace pasar T030)

**Checkpoint**: US1 + US2 forman el mínimo útil: copiar y volver atrás con garantías.

---

## Phase 5: User Story 3 - Copia obligatoria antes de las migraciones (Priority: P1)

**Goal**: al arrancar (servidor o `pnpm db:migrate`) con datos y migraciones pendientes, la
instancia hace una copia `premigration` antes de la primera migración; si no puede, no migra ni
escucha y lo registra. El arranque toma el bloqueo de instancia en marcha antes de todo.

**Independent Test**: arrancar con una migración pendiente y comprobar que antes de aplicarla
existe una copia nueva con el esquema anterior; repetir sin clave y comprobar que la instancia no
arranca y el esquema no cambia (quickstart B-7, B-8).

### Tests for User Story 3 ⚠️

- [ ] T036 [P] [US3] Crear `tests/integration/backup/premigration.test.ts`: en `createDatabaseMigratedUpTo(3)` con datos, `runMigrations(url, defaults, { backup })` crea `…__0003_map_url__…__premigration.cbak` cuya cabecera tiene `drizzle.__drizzle_migrations` con 4 filas (hecha antes de migrar) y después la BD queda en `0004_handoff`; sin pendientes → ninguna copia; BD vacía → ninguna copia y migra; con datos y pendientes sin `backup` → `MigrationBlockedError` (`backup_not_configured`), `__drizzle_migrations` sin cambios y `migration_blocked` registrado con las etiquetas pendientes; con `BACKUP_DIR` inexistente → bloqueado con `dir_missing` y esquema sin cambios; una migración que falla tras la copia (carpeta de migraciones de prueba con una migración rota, vía la opción `migrationsFolder`) → error con el nombre de la copia previa y `migration_failed` registrado; la copia `premigration` se restaura en una BD nueva con `applyMigrationsUpTo(3)` (FR-017: se simula el núcleo anterior con el código actual limitado a la migración 3; no se prueba con un núcleo anterior real) y la restauración de una copia de `0003` seguida de `runMigrations` con `backup` crea su copia previa y migra (US2-3)
- [ ] T037 [P] [US3] Crear `tests/integration/backup/migrate-cli.test.ts`: `pnpm db:migrate` (función principal de `src/db/migrate.ts` con entorno inyectado) con datos, pendientes y sin configuración de copias sale con código 1 y el mensaje "No se aplican las migraciones pendientes (…): no se pudo hacer la copia previa (…). El esquema no ha cambiado."; con configuración, crea la copia y migra
- [ ] T038 [P] [US3] Ampliar `tests/integration/backup/startup.test.ts`: con datos y migraciones pendientes y sin configuración de copias, `startInstance` rechaza con `MigrationBlockedError`, `listen` no se llama y `__drizzle_migrations` no cambia (SC-003); con `INSTANCE_RUNNING` tomado por otra conexión rechaza con "Hay una restauración en curso o la instancia ya está en marcha" sin migrar; tras arrancar, otra conexión no puede tomar `INSTANCE_RUNNING` y tras `stop()` sí

### Implementation for User Story 3

- [ ] T039 [US3] Cambiar `src/db/migrate.ts`: `runMigrations(url, defaults, options?: { backup?: BackupGuard; logger?: LoggerLike; migrationsFolder?: string })`; antes de `migrate()` lee `databaseSchema` y `pendingMigrations` (T014); BD vacía o sin pendientes → como hasta ahora; con datos y pendientes → `createBackup` con motivo `premigration`, y sin `backup` o si falla lanza `MigrationBlockedError` y registra `migration_blocked`; si `migrate()` falla tras la copia, registra `migration_failed` y relanza con el nombre de la copia previa; la plantilla de tests (`tests/helpers/global-setup.ts`) sigue funcionando sin cambios (BD vacía)
- [ ] T040 [US3] Actualizar la ejecución directa de `src/db/migrate.ts` (`pnpm db:migrate`): usa `loadEnv()` y construye el `BackupGuard` desde `env.backup`; ante `MigrationBlockedError` o fallo de migración imprime los mensajes de [contracts/backup-commands.md](contracts/backup-commands.md#pnpm-dbmigrate-y-arranque-del-servidor) y sale con código 1 (hace pasar T037)
- [ ] T041 [US3] Ampliar `startInstance` en `src/startup.ts`: antes de migrar toma `INSTANCE_RUNNING` con `tryAdvisoryLock` (si no puede, rechaza con "Hay una restauración en curso o la instancia ya está en marcha") y lo mantiene mientras vive la instancia; pasa el `BackupGuard` y el logger a `runMigrations`; ante `MigrationBlockedError` o fallo de migración registra y rechaza sin llamar a `listen`; fuera de `production` sin `env.backup` registra una vez `backup_disabled` con las variables que faltan; `stop()` libera el bloqueo después de cerrar la app. En `src/server.ts`, un rechazo de `startInstance` imprime el mensaje y sale con código 1 (hace pasar T038)

**Checkpoint**: ninguna actualización del núcleo migra sin red (SC-003).

---

## Phase 6: User Story 4 - Las copias caducan (Priority: P2)

**Goal**: las copias propias de más de `BACKUP_RETENTION_DAYS` días se borran tras cada copia y con
`pnpm db:backups --prune`, conservando siempre la más reciente válida e ignorando ficheros ajenos.

**Independent Test**: con copias de distintas fechas y retención configurada, comprobar que se
borran exactamente las que la superan y nunca la más reciente (quickstart B-9).

### Tests for User Story 4 ⚠️

- [ ] T042 [P] [US4] Crear `tests/unit/backup/retention.test.ts` para `selectExpired(backups, now, days)`: borra las de edad > `days × 24 h` y conserva la del límite exacto; si todas caducan conserva la más reciente válida; una más reciente no válida no cuenta y se conserva la válida anterior; las `premigration` y `daily` siguen la misma regla; las de otra instancia nunca se devuelven; la edad sale de `createdAt` de la cabecera, no del nombre
- [ ] T043 [P] [US4] Crear `tests/integration/backup/retention.test.ts`: copias propias con `createdAt` forzado (reloj del test) a 1, 5, 8 y 20 días, una de otra instancia, un fichero ajeno, uno con nombre parecido y un `.partial`; con `retentionDays = 7` una copia nueva borra las de 8 y 20 días y su informe dice `deleted: 2`; los ficheros ajenos, el de otra instancia y el `.partial` siguen ahí; con todas caducadas queda la más reciente válida y `backup_retention_applied` lleva `keptExpiredLatest: true`; `main(['--prune'])` de `src/cli/backups.ts` aplica la misma retención y `main([])` lista solo las propias con nombre, tamaño, fecha local, motivo, esquema, válida y fecha de caducidad

### Implementation for User Story 4

- [ ] T044 [US4] Crear `src/backup/retention.ts` con `selectExpired` (pura, hace pasar T042) y `applyRetention({ config, clock, logger })`: lista `BACKUP_DIR`, se queda con los nombres del patrón cuya cabecera se lee y tiene el `instanceId` propio, marca como válidas las que pasan `authenticateHeader` con alguna clave configurada, borra las que devuelve `selectExpired`, registra `backup_retention_applied` y devuelve `{ deleted, kept, keptExpiredLatest }`
- [ ] T045 [US4] Añadir a `src/backup/service.ts` `listBackups({ config, clock })` (propias con nombre, tamaño, cabecera, validez y fecha de caducidad) y llamar a `applyRetention` al terminar bien cada `createBackup`, rellenando `BackupReport.retention`; un fallo de la retención se registra pero no invalida la copia recién creada; si la copia falla, `createBackup` no aplica la retención (la aplica quien la llama: el programador, R10)
- [ ] T046 [US4] Crear `src/cli/backups.ts` con `main(argv, io)`: `[--prune] [--json]`, tabla legible con las columnas del contrato (fecha en hora local del negocio) y, con `--prune`, el resultado de la retención (hace pasar T043)
- [ ] T047 [US4] Mostrar en la salida de `src/cli/backup.ts` la línea "Retención (N días): X copias borradas, Y conservadas." y ampliar `tests/integration/backup/backup-cli.test.ts` para comprobarla

**Checkpoint**: ninguna copia sobrevive más de lo configurado salvo la última válida (SC-006).

---

## Phase 7: User Story 5 - El operador comprueba que una copia se puede restaurar (Priority: P2)

**Goal**: `pnpm db:verify` restaura la copia en una BD temporal separada, compara los recuentos,
la borra siempre y emite un informe de validez; una guía documenta el ciclo completo.

**Independent Test**: comprobar una copia válida y una dañada; el informe distingue ambas y la BD
de la instancia no cambia (quickstart B-10 y Parte A).

### Tests for User Story 5 ⚠️

- [ ] T048 [P] [US5] Crear `tests/integration/backup/verify.test.ts`: copia válida → `restorable: true`, esquema, fecha y recuentos iguales a la cabecera; ninguna BD `verify_%` en `pg_database` al terminar; `tableSnapshot` de la instancia sin cambios; copia con un byte cambiado → `restorable: false` con `corrupted` y sin BD temporal; clave distinta → `wrong_key`; copia de otra instancia → restaurable y `sourceInstance` la muestra; `BACKUP_VERIFY_URL` con un usuario sin `CREATEDB` o servidor inalcanzable → `verify_db_unavailable`; `verify_completed` registrado; `main(['<fichero>', '--json'])` de `src/cli/verify.ts` sale con 0 si es restaurable y 1 si no, con las salidas del contrato

### Implementation for User Story 5

- [ ] T049 [US5] Añadir a `src/backup/service.ts` `verifyBackup({ file, config, clock, logger })`: se conecta a la BD indicada en `BACKUP_VERIFY_URL` (por defecto la de la instancia, solo para crear y borrar la temporal, sin leer ni escribir sus tablas) y crea `verify_<16 hex>` (`verify_db_unavailable` si falla), ejecuta `restoreInto` sobre ella con `acceptAnyInstance`, recuenta y compara con la cabecera, y en un `finally` la borra con `DROP DATABASE … WITH (FORCE)`; devuelve `VerifyReport` y registra `verify_completed`
- [ ] T050 [US5] Crear `src/cli/verify.ts` con `main(argv, io)`: `<fichero> [--json]`, salida `RESTAURABLE` / `NO RESTAURABLE: <motivo> (<código>)` y "Base de datos temporal eliminada." según [contracts/backup-commands.md](contracts/backup-commands.md#pnpm-dbverify) (hace pasar T048)
- [ ] T051 [US5] Escribir la guía de validación del operador en `docs/operacion-multicliente.md` (sección nueva enlazada desde §2.6 y §5) a partir de la Parte A de [quickstart.md](quickstart.md): cuándo repetirla (alta, mensual, tras actualizar con migraciones, tras cambiar la clave), requisitos previos (clave fuera de `BACKUP_DIR`, volumen persistente y réplica/instantáneas, instancia de pruebas con `CREATEDB` y sin `WHATSAPP_*` ni `SMTP_*`), los seis pasos con comandos y resultado esperado, y qué anotar en el inventario (FR-022, SC-007)

**Checkpoint**: el operador puede demostrar que sus copias se restauran.

---

## Phase 8: User Story 6 - Copias periódicas automáticas (Priority: P3)

**Goal**: el servidor hace una copia `daily` al día a la hora local configurada en la zona del
negocio (03:00 por defecto), recupera la del día si arranca tarde, nunca hace dos el mismo día,
un fallo no detiene la atención y la retención se aplica aunque la copia falle.

**Independent Test**: con la hora configurada y el reloj adelantado, se crea una copia `daily`, no
se crean dos el mismo día y la retención las trata como a las demás (quickstart B-11).

### Tests for User Story 6 ⚠️

- [ ] T052 [P] [US6] Crear `tests/unit/backup/scheduler.test.ts` para `dueDailyBackup({ now, timezone, time, dailyToday, failedOn })`: antes de la hora → `false`; a la hora y después → `true`; con `dailyToday` → `false`; con `failedOn` = hoy local → `false` y al día siguiente → `true`; el día local se calcula en la zona del negocio (00:30 en `Europe/Madrid` es otro día que en UTC); salto de primavera en `Europe/Madrid` (2026-03-29) con hora `02:30` → `true` desde el primer minuto posterior; retroceso de otoño (2026-10-25) con hora `02:30` → una sola copia; otra zona (`America/Mexico_City`) con la misma regla
- [ ] T053 [P] [US6] Crear `tests/integration/backup/daily.test.ts` con reloj controlable y pasadas manuales del programador: antes de la hora no copia; tras la hora crea `…__daily.cbak`; una segunda pasada y un programador nuevo (reinicio) el mismo día no crean otra; arranque tarde el mismo día crea la que faltaba; un fallo (directorio inexistente) registra `backup_failed` con motivo `daily` y no reintenta hasta el día siguiente, pero un programador nuevo ese día sí; con `BACKUP_IN_PROGRESS` tomado no marca el día y reintenta en la siguiente pasada; tras la copia se aplica la retención; la zona horaria se relee en cada pasada (cambiarla en `business` cambia el día local); `stop()` espera a la copia en curso; con la copia fallando por `no_space` (flujo de destino que lanza `ENOSPC`) y copias caducadas en el directorio, la pasada borra las caducadas, conserva la última válida y registra `backup_failed` y `backup_retention_applied`
- [ ] T054 [P] [US6] Ampliar `tests/integration/backup/startup.test.ts`: con `env.backup`, el programador arranca después de `listen` y `stop()` lo para antes de cerrar la BD, esperando a una copia en curso

### Implementation for User Story 6

- [ ] T055 [US6] Crear `src/backup/scheduler.ts` con `dueDailyBackup` (pura, hora local sin pasar a UTC, reutilizando las utilidades de zona horaria que ya haya en `src/`; hace pasar T052) y `createBackupScheduler({ databaseUrl, db, config, clock, logger, intervalMs = 60_000 })` con `tick()`, `start()` (pasada inmediata y cada 60 s) y `stop()` (espera a la copia en curso): lee `business.timezone` en cada pasada, decide `dailyToday` mirando las copias `daily` propias de `BACKUP_DIR` por `createdAt` de la cabecera, llama a `createBackup` con motivo `daily`; si la copia falla (salvo `busy`), guarda `failedOn` y **aplica igualmente `applyRetention`** en esa pasada, para liberar espacio aunque la copia no se haya podido hacer; la retención también se aplica una vez al día en la pasada que alcanza la hora configurada aunque ya exista la copia del día; con `busy` no marca el día y reintenta en la siguiente pasada; nunca propaga errores (hace pasar T053)
- [ ] T056 [US6] Ampliar `startInstance` en `src/startup.ts`: con `env.backup` crea el programador y lo arranca después de `listen` junto al procesador y la retención; `stop()` lo para (esperando la copia en curso) antes de `closeDb` y de liberar `INSTANCE_RUNNING` (hace pasar T054)

**Checkpoint**: todas las historias funcionan de forma independiente.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: privacidad de los registros, neutralidad, rendimiento, imagen, documentación y
validación final.

- [ ] T057 [P] Crear `tests/integration/backup/logs.test.ts` (SC-004, [contracts/backup-log.md](contracts/backup-log.md)): con `seedInstance` y `captureLogger`, ejecutar copia, restauración, restauración rechazada, comprobación, retención, copia diaria fallida y arranque bloqueado, y comprobar que ningún registro contiene el nombre del negocio, teléfonos, emails, textos de mensajes de la fixture, la clave de test, `BACKUP_DIR` completo ni mensajes de PostgreSQL
- [ ] T058 [P] Ampliar `tests/unit/sector-neutrality.test.ts` para exigir que el recorrido incluya `backup/format.ts`, `backup/service.ts`, `backup/scheduler.ts`, `cli/backup.ts` y `startup.ts` (FR-023)
- [ ] T059 [P] Crear `tests/integration/backup/performance.test.ts` (SC-001): con ~10⁴ mensajes y 30 días de actividad generados en el test, la copia termina en < 60 s y durante ella una escritura concurrente responde en < 1 s; la restauración y la comprobación de esa copia terminan en el mismo orden de tiempo
- [ ] T060 [P] Cambiar `Dockerfile`: crear `/var/lib/chatbot/backups` con propietario `node`, declarar `VOLUME` y documentar en un comentario que `BACKUP_DIR` debe apuntar a un volumen persistente escribible por `node`
- [ ] T061 [P] Actualizar `docs/operacion-multicliente.md` §2.3 (variables `INSTANCE_ID`, `BACKUP_*` y volumen), §2.6 (copia y comprobación al cerrar el alta), §5 (copia previa automática, migraciones de solo añadir y ficheros publicados que no se editan, cómo volver atrás con la copia `premigration`), §7 (qué pasa con las copias en la baja) y marcar la propuesta P3 como implementada por la 006
- [ ] T062 [P] Actualizar el bloque "Arranque y pruebas en local" de `CLAUDE.md` con `pnpm db:backup`, `db:restore`, `db:verify` y `db:backups`
- [ ] T063 Revisión de seguridad de `src/backup`, `src/startup.ts` y `src/cli/*` (agente `security-auditor` o revisión manual): la clave nunca sale en registros, errores ni salida; permisos `0600` de las copias; sin rutas completas ni errores de PostgreSQL en registros; `db:restore` no se puede ejecutar sin confirmación salvo `--yes`; nombres de BD temporales no inyectables
- [ ] T064 Avisar al usuario y actualizar `README.md` con el estado de la 006, las variables nuevas, los comandos y la consecuencia para instancias existentes (en `production` no arrancan sin `INSTANCE_ID`, `BACKUP_DIR`, `BACKUP_KEY` y un volumen)
- [ ] T065 Ejecutar `pnpm lint`, `pnpm typecheck` y `pnpm test` (unit + contract + integration) y corregir lo que falle
- [ ] T066 Recorrer los escenarios B-1 a B-11 de [quickstart.md](quickstart.md) en local con `docker compose up -d db` y anotar el resultado, y hacer una vez la Parte A (guía del operador) cronometrada contra SC-007 (< 15 min)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias.
- **Foundational (Phase 2)**: depende de Setup; bloquea todas las historias. Incluye
  `applyMigrationsUpTo` (T014), que usan US2, US3 y los helpers de test.
- **US1 (Phase 3)**: depende de Foundational.
- **US2 (Phase 4)**: depende de US1 (necesita copias para restaurar: `createBackup` en sus tests).
- **US3 (Phase 5)**: depende de US1 (`createBackup` con motivo `premigration`) y de T035
  (`src/startup.ts`); la parte de US2-3 de T036 usa `restoreBackup` (US2).
- **US4 (Phase 6)**: depende de US1; independiente de US2 y US3.
- **US5 (Phase 7)**: depende de US2 (`restoreInto`).
- **US6 (Phase 8)**: depende de US1 y de US4 (`applyRetention` en el programador); T056 amplía
  `src/startup.ts` tras T041.
- **Polish (Phase 9)**: depende de todas las historias que se entreguen.

### User Story Dependencies

```text
Setup → Foundational → US1 ─┬─→ US2 ──┬─→ US5
                            │         └─→ US3 (src/startup.ts de T035; T036 usa restoreBackup)
                            ├─→ US4 ──→ US6 (retención en el programador; startup.ts tras T041)
```

### Dentro de cada historia

- Tests primero y fallando; luego implementación en el orden de las tareas.
- `src/backup/service.ts` se toca en varias historias (T022, T032, T033, T045, T049): esas tareas
  no son [P] entre sí.
- `src/startup.ts` se crea en T035 y lo amplían T041 y T056; `tests/integration/backup/startup.test.ts`
  se crea en T030 y lo amplían T038 y T054. Van en ese orden, no en paralelo.

### Parallel Opportunities

- Setup: T002 y T003 en paralelo tras T001.
- Foundational: T004–T007 (tests) en paralelo; T009, T010, T011, T012 y T015 en paralelo; T013
  tras T009 y T011; T017 en paralelo con T013–T016.
- US1: T018, T019 y T020 en paralelo; T023 en paralelo con T021–T022.
- US2: T025–T030 en paralelo; T031 en paralelo con los tests.
- Tras US1, US4 puede avanzar en paralelo con US2 (ficheros distintos salvo
  `src/backup/service.ts`, que se coordina).
- Polish: T057–T062 en paralelo.

---

## Parallel Example: User Story 1

```bash
# Tests de la US1 a la vez:
Task: "Test de copia bajo demanda y fallos en tests/integration/backup/backup.test.ts"
Task: "Test de copia con escrituras concurrentes en tests/integration/backup/concurrency.test.ts"
Task: "Test del comando db:backup en tests/integration/backup/backup-cli.test.ts"

# Implementación que no comparte fichero:
Task: "Volcador en src/backup/dump.ts"
Task: "Utilidades comunes de los comandos en src/cli/backup-common.ts"
```

## Parallel Example: User Story 2

```bash
Task: "Ciclo copia/restauración con los tres sectores en tests/integration/backup/backup-restore.test.ts"
Task: "Restauración que falla a mitad en tests/integration/backup/restore-atomic.test.ts"
Task: "Rechazos en tests/integration/backup/rejections.test.ts"
Task: "Esquema anterior en tests/integration/backup/older-schema.test.ts"
Task: "Comando db:restore en tests/integration/backup/restore-cli.test.ts"
Task: "Purga antes de escuchar en tests/integration/backup/startup.test.ts"

Task: "Lector del volcado en src/backup/dump.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1)

1. Phase 1 (Setup) y Phase 2 (Foundational).
2. Phase 3 (US1): `pnpm db:backup` funcionando.
3. **Parar y validar**: quickstart B-1, B-2 y B-3.

Con solo la US1 ya hay copias cifradas; restaurarlas exige la US2, así que el mínimo que se
entrega a un cliente real es **US1 + US2 + US3** (las tres P1).

### Incremental Delivery

1. Setup + Foundational → base lista.
2. US1 → copias bajo demanda.
3. US2 → restauración total o nula y arranque en `src/startup.ts` (mínimo útil).
4. US3 → ninguna migración sin copia previa (requisito para actualizar clientes reales).
5. US4 → caducidad compatible con los 30 días de conversaciones.
6. US5 → comprobación y guía del operador.
7. US6 → copia diaria automática.
8. Polish → registros, neutralidad, rendimiento, imagen, documentación y README.

### Parallel Team Strategy

Tras Foundational y US1: una persona con US2 → US3 → US5 y otra con US4 → US6, coordinando los
cambios en `src/backup/service.ts` y el orden de `src/startup.ts` (T035 → T041 → T056).

---

## Notes

- [P] = ficheros distintos y sin dependencias pendientes.
- [Story] enlaza cada tarea con su historia para la trazabilidad.
- Cada historia se puede probar por separado con su test de integración y su escenario del
  quickstart.
- Commit tras cada tarea o grupo lógico; parar en cada checkpoint para validar.
- `README.md` solo se toca en T064 y avisando antes al usuario.
