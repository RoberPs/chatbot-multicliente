---

description: "Lista de tareas de la feature 007: aprovisionamiento de instancias"
---

# Tasks: Aprovisionamiento de instancias

**Input**: documentos de diseño de `/specs/007-instance-provisioning/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Ámbito**: Núcleo (herramientas de operación)

**Tests**: se incluyen. El plan fija las suites `unit` (calidad de secretos, huellas, `checkEnv`,
tabla SC-002, perfil `testing`, plantilla, inventario, SC-004, verificador SCRAM) e `integration`
(Testcontainers y directorios temporales: BD por instancia SC-006, rechazos, fallos inyectados,
`--print-sql`, CLI de extremo a extremo SC-003, bloqueo, inventario corrupto, repositorio git
temporal, privacidad SC-005). No hay tests `contract` (no hay HTTP) ni `eval` (no cambia la
conversación). Los tests de cada historia se escriben primero y deben fallar antes de implementar.

**Organization**: por historia de usuario. La fase fundacional deja preparados `checkEnv` en
`env.ts`, el catálogo de mensajes, la lectura de entornos, las huellas, el inventario (esquema,
clave, bloqueo, escritura atómica), las rutas del repositorio, los helpers de test y el esqueleto
de `src/cli/instance.ts` sin subórdenes. Cada historia añade después su lógica, su suborden y sus
pruebas.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: se puede hacer en paralelo (ficheros distintos, sin dependencias pendientes)
- **[Story]**: historia a la que pertenece (US1…US4)
- Rutas desde la raíz del repositorio (proyecto único: `src/`, `tests/`)

## Reglas que aplican a todas las tareas

- `src/provisioning` es un módulo de operación hermano de `src/backup`: no importa Fastify ni nada
  de `src/admin`, `src/channels`, `src/knowledge`, `src/conversation` ni `src/webchat`. Habla con
  el disco por `node:fs`, con PostgreSQL por `pg` **solo** desde `database.ts` y con `git` solo
  para `check-ignore` desde `repo-paths.ts`. Sin dependencias nuevas.
- Las funciones de reglas (`secretQuality`, huellas, `check`, plantilla, plan SQL, operaciones
  sobre el inventario) son **puras** y reciben el inventario ya leído; la CLI compone disco,
  bloqueo, operación y salida con `CliIO` inyectable (patrón de `src/cli/backup-common.ts`).
- **Ningún** mensaje, resultado, registro ni excepción propagada contiene el valor de un secreto,
  la contraseña del operador (salvo la línea única de `new`), la clave del inventario (salvo la
  línea única al crearlo), la URL de administración ni una `DATABASE_URL` con contraseña (FR-007,
  FR-020, FR-027). Los errores de `pg` y de `node:fs` se traducen a códigos propios de
  `messages.ts`; de las URL solo se muestran servidor, puerto, nombre y usuario.
- Las herramientas no cargan el `.env` del repositorio ni escriben en `process.env` los entornos
  leídos; los entornos se leen con `util.parseEnv`.
- `check` no escribe nunca (FR-009). Toda escritura del inventario va bajo bloqueo, relee y valida
  antes de escribir y termina en `rename` atómico (FR-031). Nunca se sobrescribe un fichero de
  entorno existente (`flag: 'wx'`) y solo `instance:db` reescribe una línea (`DATABASE_URL`).
- Las herramientas nunca borran una base de datos ni copias (FR-019, FR-028a); el único deshacer
  permitido es `DROP ROLE` del usuario recién creado cuando falla `CREATE DATABASE`.
- En `src/` no puede haber nombres ni lógica de sector o cliente (FR-033). Los identificadores de
  ejemplo (`demo-01`) y nombres de cliente, solo en `tests/`.
- El arranque del núcleo no cambia (FR-034): `loadEnv` sigue igual y ningún fichero de
  `src/provisioning` se importa desde `src/server.ts` ni `src/startup.ts`.
- Códigos de salida: 0 correcto/apto, 1 rechazado/no apto, 2 argumentos, fichero ilegible,
  inventario ilegible o bloqueado, clave ausente o equivocada (salvo en `check`, donde es 1),
  terminal requerida ([contracts/instance-commands.md](contracts/instance-commands.md)).
- No hay migraciones nuevas. Textos, comentarios y mensajes en español.

---

## Phase 1: Setup (infraestructura compartida)

**Purpose**: scripts de las órdenes y cobertura del test de neutralidad.

- [X] T001 Añadir a `package.json` los scripts `instance:check`, `instance:new`, `instance:db`, `instance:list`, `instance:register`, `instance:sync`, `instance:update`, `instance:verified` e `instance:retire`, todos `tsx src/cli/instance.ts <suborden>` (R1)
- [X] T002 [P] Ampliar `tests/unit/sector-neutrality.test.ts` con una aserción de que el recorrido de `src/` incluye `src/provisioning/` y `src/cli/instance.ts` cuando existen (FR-033)

---

## Phase 2: Foundational (prerrequisitos bloqueantes)

**Purpose**: validación del núcleo reutilizable, catálogo de mensajes, lectura de entornos,
huellas, inventario con clave, bloqueo y escritura atómica, rutas del repositorio, helpers de test
y esqueleto de la CLI. Nada de esto cambia el arranque.

**⚠️ CRITICAL**: ninguna historia puede empezar hasta terminar esta fase.

### Tests fundacionales (escribir primero, deben fallar)

- [X] T003 [P] Ampliar `tests/unit/env.test.ts` con `checkEnv(source)`: devuelve `[]` para un entorno válido; cada incidencia trae `variable` y `rule` además de `message`, incluidas las personalizadas de `botSchema` según la lista de reglas de R2; «faltan: WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET» da **dos** entradas `whatsapp_incomplete`, una por variable; las copias que faltan en production dan una entrada `backup_required` por variable; `SMTP_URL` sin `SMTP_FROM` → `smtp_incomplete`; `BACKUP_KEY` igual a `SESSION_SECRET` → `backup_key_equals_session`; `EMERGENCY_CONTACT_PHONE` con bot → `emergency_phone_required`; una incidencia de campo sin `rule` sale como `missing` (valor ausente) o `core_rule`; y el texto del error de `loadEnv` es idéntico byte a byte al de antes para un conjunto fijo de entornos inválidos definido en el test (arranque sin cambios, FR-034)
- [X] T004 [P] Crear `tests/unit/provisioning/fingerprint.test.ts`: `fingerprint(key, class, value)` es determinista, de 22 caracteres base64url, cambia con la clave y con la clase; la clase `secret` es común (mismo valor en `SESSION_SECRET` y `BACKUP_KEY` da la misma huella); normalización (hex en minúsculas, URL pública a origen, BD `host-minúsculas:puerto/nombre` con 5432 por defecto, `DATABASE_USER` `host:puerto/usuario`, `BACKUP_DIR` sin barra final, resto recortado); `keyCheck(key)` y `verifyKey(key, keyCheck)` en tiempo constante; `envFingerprints(env, key, today)` produce exactamente las variables y clases de la tabla de [data-model.md](data-model.md#huella) (cada `BACKUP_KEYS_PREVIOUS` con `current: false`, `DATABASE_PASSWORD` desde la contraseña de `DATABASE_URL`, nada de `INSTANCE_ID`) y omite las variables vacías; ninguna salida contiene el valor
- [X] T005 [P] Crear `tests/unit/provisioning/inventory.test.ts`: el esquema Zod estricto acepta el ejemplo de [contracts/inventory-format.md](contracts/inventory-format.md) y rechaza `version: 2`, `format` distinto, campos desconocidos, ids repetidos, `status = retired` sin `dates.retired` (y al revés), `dataDeleted` sin `retired`, cualquier texto con `://…:…@`; `serializeInventory` ordena instancias por `id`, sangría de 2 y salto de línea final; `resolveInventoryPath` sigue `--inventory` › `INSTANCE_INVENTORY` › `~/.chatbotasesor/inventory.json`; `loadInventoryForUse` distingue `absent`, `inventory_unreadable` (JSON roto o esquema inválido, con motivo sin contenido), `inventory_key_missing` e `inventory_key_wrong`
- [X] T006 [P] Crear `tests/unit/provisioning/env-file.test.ts` (parte de lectura): `parseEnvFile` usa `util.parseEnv` y devuelve el mismo resultado que `process.loadEnvFile` para comillas, comentarios y valores vacíos; no toca `process.env`; fichero inexistente o ilegible → error `env_unreadable` sin contenido
- [X] T007 [P] Crear `tests/helpers/provisioning.ts`: directorio temporal con inventario y `envs/`; clave de test fija de 64 hex; `CliIO` capturado (stdout, stderr, `isTTY` configurable, respuestas a preguntas); hasher Argon2id rápido inyectable; fábrica de entornos válidos de producción con secretos aleatorios; fábrica de inventarios con N instancias (incluida una `retired` y una `testing`); `collectSecrets(env)` para las búsquedas de privacidad
- [X] T008 [P] Crear `tests/integration/provisioning/inventory-lock.test.ts`: dos escrituras simultáneas → una espera y la otra termina, o falla con `inventory_busy` a los 5 s; el fichero final es siempre JSON válido y completo; un `.lock` de más de 10 min se señala como posiblemente huérfano y **no** se borra; un inventario corrupto no se sobrescribe (bytes idénticos tras el intento) y el error es `inventory_unreadable`; tras la escritura no queda ningún `.tmp-*`; en POSIX el modo es `0600`
- [X] T009 [P] Crear `tests/integration/provisioning/repo-path.test.ts` con un repositorio git temporal: `isInsideCoreRepo` detecta rutas dentro y fuera (también con `..` y enlaces resueltos); `isGitIgnored` devuelve verdadero para una ruta en `.gitignore` y falso para una que no; sin `git` disponible (PATH vacío inyectado) → rechazo; `resolveInventoryPath` dentro del repositorio → `inventory_in_repo` aunque esté ignorada

### Implementación fundacional

- [X] T010 Exportar `checkEnv(source): EnvIssue[]` (`{ variable: string | null, rule: string, message: string }`) desde `src/config/env.ts` haciendo `safeParse` del esquema actual; añadir `params: { rule, variables }` a cada `addIssue` personalizado de `botSchema` y `params.rule` a los refinamientos de campo (`TRUST_PROXY`, `PUBLIC_BASE_URL`…) según la lista de R2, **sin tocar ningún `message`**; `checkEnv` expande `params.variables` en una entrada por variable (o usa `path[0]`) y asigna `missing`/`core_rule` a las incidencias de campo sin `rule`; `loadEnv` sigue formateando solo `message` (T003)
- [X] T011 [P] Crear `src/provisioning/messages.ts`: catálogo cerrado de códigos → `{ message(ctx), action }` en español para los errores y advertencias de [contracts/check-result.md](contracts/check-result.md), los mensajes comunes y rechazos de [contracts/instance-commands.md](contracts/instance-commands.md) (incluidos `inventory_missing` y la pregunta de creación del inventario) y los fallos de `instance:db` (incluido `inventory_not_updated`); tipos `CheckCode`, `CommandCode`; `ctx` solo admite nombres de variable, ids, rutas, servidor/puerto/nombre/usuario y fechas
- [X] T012 [P] Crear `src/provisioning/env-file.ts` con `parseEnvFile(path)` (lectura UTF-8 + `util.parseEnv`, errores traducidos a `env_unreadable`) y el tipo `EnvMap` (T006)
- [X] T013 [P] Crear `src/provisioning/fingerprint.ts`: `fingerprint(key, class, value)` = base64url de los 16 primeros bytes de `HMAC-SHA256(key, "chatbot-inventory/v1\0" + clase + "\0" + normalizado)`; `keyCheck`, `verifyKey` con `timingSafeEqual`; `parseInventoryKey` (64 hex); normalizadores por variable; `envFingerprints(env, key, today)` según la tabla de [data-model.md](data-model.md#huella); `databaseIdentity(databaseUrl)` → `{host, port, name, user}` sin contraseña (T004)
- [X] T014 Crear `src/provisioning/repo-paths.ts`: `coreRoot()` subiendo hasta `package.json` (como `coreVersion`), `isInsideCoreRepo(path)` con rutas resueltas, `isGitIgnored(path)` con `git check-ignore -q` (sin `git` → no ignorada) y `templatePath()` = `<raíz>/.env.example` (T009)
- [X] T015 Crear `src/provisioning/inventory.ts` (esquema, lectura y escritura): esquema Zod estricto de `Inventory`/`Instance`/`DatabaseIdentity`/`Verification`/`Fingerprint` con las invariantes de [contracts/inventory-format.md](contracts/inventory-format.md); `resolveInventoryPath` (rechaza rutas dentro del repositorio con `inventory_in_repo`); `readInventory` (sin bloqueo, para `check` y `list`); `loadInventoryForUse(path, key)`; `withInventoryLock(path, fn)` con `open(…, 'wx')` de `<ruta>.lock` (pid y hora), reintentos 5 s, aviso de huérfano a 10 min, relectura y validación bajo bloqueo y escritura `<ruta>.tmp-<8 hex>` modo `0600` → `fsync` → `rename` con 3 reintentos ante `EPERM`/`EBUSY`; `createInventory(key, today)` con `keyCheck`; `newInventoryKey()` (depende de T013, T014; T005, T008)
- [X] T016 Crear el esqueleto de `src/cli/instance.ts`: `runIfMain`, despacho de subórdenes (desconocida → uso y código 2), opción común `--inventory`, lectura de `INSTANCE_INVENTORY_KEY` solo desde el entorno del proceso, mapeo de códigos de `messages.ts` a salida y código de salida, `requireInteractive(io)` (`not_interactive`), y captura de cualquier excepción no prevista con un mensaje genérico sin su texto (reutiliza `CliIO`/`parseArgs` de `src/cli/backup-common.ts`)

**Checkpoint**: base lista — `pnpm test:unit provisioning` y `pnpm test env` pasan; el arranque no ha cambiado.

---

## Phase 3: User Story 1 - El operador valida un entorno antes de desplegar (Priority: P1) 🎯 MVP

**Goal**: `pnpm instance:check <entorno> [--json]` da "apto"/"no apto" con errores y advertencias
por variable y acción, comparando con todas las demás instancias del inventario sin mostrar ningún
valor secreto.

**Independent Test**: con un inventario de dos instancias y entornos preparados (correcto,
incompleto, con el `SESSION_SECRET` de otra, con la misma BD que otra), solo el correcto sale apto
(código 0) y cada fallo nombra la variable y la instancia con la que coincide; la salida no
contiene ningún valor secreto.

### Tests for User Story 1 ⚠️

- [X] T017 [P] [US1] Crear `tests/unit/provisioning/secrets.test.ts` (parte de calidad): `secretQuality(variable, value)` aplica cada regla de R3 — 64 hex con más de 8 caracteres distintos para `SESSION_SECRET`/`BACKUP_KEY`/`BACKUP_KEYS_PREVIOUS`; formato `$argon2id$v=19$…` y advertencia `weak_argon2_params` si `m < 19456` o `t < 2`; longitudes mínimas de `WHATSAPP_VERIFY_TOKEN` (≥ 32 y ≥ 10 distintos), `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `ANTHROPIC_API_KEY` (+ `llm_key_format`), `STT_API_KEY`, contraseña de `DATABASE_URL` (≥ 16; `chatbot` → `example_database`); relleno según las reglas a–d de R3 → `weak_secret` (`changeme123`, `test-token-…`, `sk-ant-test-…`, `mi_password_…`, un valor corto con `secret`, un solo carácter repetido, secuencias `0123…`/`abcd…`); en cambio, un valor aleatorio de 32 caracteres con `xxx` o `test` en medio **no** es `weak_secret`; ningún resultado contiene el valor
- [X] T018 [P] [US1] Crear `tests/unit/provisioning/check.test.ts` con una **tabla que recorre cada caso** (SC-002): cada incoherencia de FR-003 (`public_url_not_https` incluido `localhost`, `whatsapp_incomplete` por variable, `smtp_incomplete` en ambos sentidos, `llm_key_required`, teléfono inválido, zona inexistente, retención y hora fuera de rango, `trust_proxy_all`, `backup_key_equals_session`, `INSTANCE_ID` mal formado), cada `missing` de FR-002, `not_production`, `weak_secret`, `example_database`, `secret_reused_within`, y cada repetición de FR-005 (`duplicate_instance_id`, `duplicate_database`, `duplicate_database_user`, `duplicate_public_url`, `duplicate_whatsapp_phone`, `duplicate_secret` para cada variable secreta, vigente y anterior, y entre variables distintas) → `ok: false` con el código y la variable esperados; advertencias de FR-006 (`shared_smtp`, `shared_backup_dir`) y `SMTP_URL` igual al secreto de otra variable → error; se compara con instancias `retired` (FR-029); la propia instancia no cuenta (US1-6); `not_registered`, `retired_instance`, `not_compared` sin inventario; perfil `testing` omite `not_production`, `public_url_not_https`, `trust_proxy_empty` y `database_localhost`; `pending_optional` para grupos vacíos; los códigos específicos sustituyen al `core_rule` equivalente y una incidencia desconocida del núcleo sale como `core_rule`; `JSON.stringify(resultado)` no contiene ningún valor de `collectSecrets(env)`
- [X] T019 [P] [US1] Crear `tests/integration/provisioning/cli-check.test.ts`: `instance:check` con entorno apto → código 0 y `APTO para desplegar.`; no apto → 1 con la salida para personas de [contracts/check-result.md](contracts/check-result.md); `--json` → una sola línea que valida el esquema del resultado; fichero inexistente → 2 sin JSON; inventario sin `INSTANCE_INVENTORY_KEY` → 1 con `inventory_key_missing`; clave equivocada → 1 con `inventory_key_wrong`; inventario corrupto → 1 con `inventory_unreadable`; sin inventario → 0 con `not_compared`, cuyo mensaje nombra la ruta buscada; el entorno y el inventario conservan bytes y `mtime` (FR-009) y no se crea `.lock`; stdout y stderr no contienen ningún secreto

### Implementation for User Story 1

- [X] T020 [US1] Implementar `secretQuality(variable, value)` y la detección de relleno en `src/provisioning/secrets.ts` con las reglas de R3 (relleno según las reglas a–d, nunca por una subcadena en medio de un valor de 24 caracteres o más), devolviendo códigos (`weak_secret`, `example_database`, `weak_argon2_params`, `llm_key_format`) sin el valor (T017)
- [X] T021 [US1] Implementar en `src/provisioning/check.ts` las reglas de coherencia: ejecutar `checkEnv` con el entorno leído y traducir cada incidencia **por su `rule`, nunca por el texto del mensaje**: `missing` y `backup_required` → `missing`; `whatsapp_incomplete`, `smtp_incomplete`, `llm_key_required`, `backup_key_equals_session` y `trust_proxy_all` conservan su código; `public_url_invalid` → `public_url_not_https`; `emergency_phone_*`, `stt_key_required`, `core_rule` y cualquier regla desconocida → `core_rule` con el mensaje del núcleo; añadir las reglas de alta del perfil (`not_production`, `public_url_not_https`, `trust_proxy_empty`, `database_superuser`, `database_localhost`, `pending_optional`), la calidad de cada secreto con `secretQuality` y `secret_reused_within` (sin duplicar `BACKUP_KEY = SESSION_SECRET`) (depende de T010, T020)
- [X] T022 [US1] Implementar en `src/provisioning/check.ts` `compare(envFingerprints, inventory, selfId)` según R5 (excluye el mismo `id`, incluye `retired` y huellas vigentes y anteriores, `INSTANCE_ID` en claro, clases `secret`/`database`/`database_user`/`public_url`/`whatsapp_phone` → error, `SMTP_URL`↔`SMTP_URL` → `shared_smtp`, `backup_dir` → `shared_backup_dir`) con `otherInstance`, `otherVariable` y `otherCurrent`; y `validate(env, inventoryState, key)` → `CheckResult` (`ok`, `instanceId`, `profile` según el estado `testing` del inventario, `compared`, `comparedWith`, `errors`, `warnings`, `not_registered`, `retired_instance`, `not_compared`, errores `inventory_key_*`/`inventory_unreadable` con `variable: null`) (T018)
- [X] T023 [US1] Implementar `formatCheckResult(result)` para personas en `src/provisioning/check.ts` con el formato exacto de [contracts/check-result.md](contracts/check-result.md) (cabecera con perfil y número de instancias, bloques ERRORES/ADVERTENCIAS con `✗`/`!` y `→ acción`, línea final `APTO`/`NO APTO para desplegar.`)
- [X] T024 [US1] Añadir la suborden `check <entorno> [--inventory] [--json]` a `src/cli/instance.ts`: lee el entorno (2 si no se puede), lee el inventario sin bloqueo, ejecuta `validate`, imprime JSON en una línea o el formato para personas y sale con 0/1; nunca escribe (T019)

**Checkpoint**: `instance:check` sirve ya para la instancia existente y cualquier entorno hecho a mano; US1 se puede demostrar sola con inventarios de los helpers.

---

## Phase 4: User Story 2 - El operador genera el entorno de una instancia nueva (Priority: P1)

**Goal**: `pnpm instance:new …` escribe un entorno completo de producción desde `.env.example`
con secretos nuevos, deja pendientes los valores de terceros, muestra una sola vez la contraseña
del operador (y la clave del inventario si lo crea) y registra la instancia "en alta".

**Independent Test**: generar dos entornos seguidos; ambos tienen exactamente las variables de la
plantilla, ningún secreto se repite entre ellos ni con el inventario, la contraseña aparece solo en
la línea única de la salida y en ningún fichero, y `instance:check` solo marca como pendientes los
valores de terceros.

### Tests for User Story 2 ⚠️

- [X] T025 [P] [US2] Ampliar `tests/unit/provisioning/secrets.test.ts` con la generación: `SESSION_SECRET` y `BACKUP_KEY` de 64 hex, `WHATSAPP_VERIFY_TOKEN` de 48 hex, contraseña del operador de 24 caracteres del alfabeto de 56 símbolos sin ambiguos; todos superan `secretQuality`; si la aleatoriedad inyectada produce primero un valor que no pasa `secretQuality`, el generador lo descarta y devuelve el siguiente; el hash se calcula con el hasher inyectado y los parámetros de `operator:hash-password`
- [X] T026 [P] [US2] Ampliar `tests/unit/provisioning/env-file.test.ts` con `renderTemplate(template, values, pending, header)`: conserva comentarios y orden de `.env.example`; sustituye solo las líneas con valor aportado; copia con su valor por defecto las variables que la herramienta no conoce; deja vacías las pendientes con `# PENDIENTE: <quién>` justo encima; cabecera con instancia y fecha sin secretos; el resultado tiene **exactamente** las variables de la plantilla real `.env.example` (con y sin `--whatsapp`)
- [X] T027 [P] [US2] Crear `tests/unit/provisioning/generate.test.ts`: validación de datos mínimos (`invalid_id`, `invalid_url` incluido `localhost` y rutas, `invalid_timezone`, `invalid_region`, `invalid_currency`, `invalid_phone`, `invalid_backup_dir`, cliente vacío o > 120) sin producir nada; `duplicate_instance_id` también con una instancia `retired`; `duplicate_public_url`; teléfono normalizado a E.164 y URL a origen; la instancia nueva sale `provisioning` con sus huellas y `dates.provisioned`; si una huella generada coincide con el inventario se regenera (máx. 3 intentos, con aleatoriedad inyectada); **SC-004**: 100 generaciones seguidas con el hasher rápido sin ningún secreto repetido
- [X] T028 [P] [US2] Crear `tests/integration/provisioning/cli-new.test.ts`: alta correcta → código 0, entorno en `<dir inventario>/envs/<id>.env` (modo `0600` en POSIX), inventario con la instancia `provisioning`, contraseña mostrada en una sola línea y ausente del entorno, del inventario y de cualquier otro fichero del directorio; sin inventario ni clave → se pregunta y, solo si se responde `crear`, se crea y la clave se muestra una vez (con otra respuesta no se escribe nada; con `INSTANCE_INVENTORY_KEY` definida la pregunta avisa de un posible inventario en otra ruta); salida no interactiva → `not_interactive` antes de generar nada; `output_exists` sin tocar el fichero; `--out` dentro de un repositorio git temporal no ignorada → `output_in_repo`, ignorada → aceptada; datos que faltan se preguntan con terminal; fallo inyectado al escribir el inventario → se borra el entorno recién creado y se informa; con cualquier rechazo, ni entorno ni inventario cambian; siguientes pasos como en [contracts/instance-commands.md](contracts/instance-commands.md), con `--env <fichero>` en el paso de `instance:db` solo cuando se usó `--out`

### Implementation for User Story 2

- [X] T029 [US2] Implementar la generación de secretos en `src/provisioning/secrets.ts`: `generateHexSecret(bytes)`, `generateVerifyToken()`, `generateOperatorPassword()` con `randomInt` y alfabeto de 56 símbolos, y `hashOperatorPassword(password, hasher)` con Argon2id y los parámetros de `src/cli/hash-password.ts` (extraerlos a una constante compartida si hace falta); cada generador regenera hasta que su valor pasa `secretQuality` (R3) (T025)
- [X] T030 [US2] Implementar `renderTemplate` en `src/provisioning/env-file.ts` (procesado línea a línea, pendientes, cabecera) y `writeNewEnvFile(path, content)` con `flag: 'wx'` y `mode: 0o600`, traduciendo `EEXIST` a `output_exists` (T026)
- [X] T031 [US2] Crear `src/provisioning/generate.ts`: `validateMinimalData(input)` con `INSTANCE_ID_PATTERN`, `isValidTimezone` y `libphonenumber-js` de los mismos módulos que `env.ts`; `buildInstanceEnv(input, inventory, key, deps)` que genera secretos, comprueba huellas contra el inventario (regenera hasta 3 veces), produce valores y pendientes de R7 (`DATABASE_URL`, `ANTHROPIC_API_KEY`, WhatsApp si `--whatsapp`, `SMTP_URL`, `SMTP_FROM`) y la `Instance` `provisioning`; `resolveOutputPath` con el valor por defecto y las reglas de `output_in_repo` (depende de T013, T014, T015, T029, T030; T027)
- [X] T032 [US2] Añadir la suborden `new` a `src/cli/instance.ts`: exige terminal, pregunta los datos que falten, valida, crea el inventario y su clave si no existen **solo tras la confirmación `crear`** (o `--create-inventory`) y muestra la clave una vez, toma el bloqueo, comprueba `id` y huellas, escribe el entorno y después el inventario (si falla, borra el entorno y lo informa), libera y muestra la contraseña una sola vez y los siguientes pasos de [contracts/instance-commands.md](contracts/instance-commands.md); sin `--json` (T028)

**Checkpoint**: US1 + US2 cubren el "alta sin copiar entornos": `instance:new` y después `instance:check` del fichero generado da apto salvo pendientes de terceros y `DATABASE_URL`.

---

## Phase 5: User Story 3 - El operador crea la base de datos de la instancia con un usuario propio (Priority: P2)

**Goal**: `pnpm instance:db <id> [--env <fichero>]` crea una BD vacía y un usuario propio con
contraseña aleatoria enviada como verificador SCRAM, retira `CONNECT` a `PUBLIC`, comprueba la
conexión, escribe `DATABASE_URL` en el entorno y la identidad en el inventario; con `--print-sql`,
imprime las órdenes equivalentes sin conectarse.

**Independent Test**: en un PostgreSQL 16 de Testcontainers, crear las BD de dos instancias y
comprobar que cada usuario entra solo en la suya, que un usuario sin privilegios no entra en
ninguna y que un segundo intento con el mismo nombre se rechaza sin tocar la existente.

### Tests for User Story 3 ⚠️

- [X] T033 [P] [US3] Crear `tests/unit/provisioning/database.test.ts`: `databaseNames(id)` → `chatbot_<id con _>` ≤ 48 caracteres; `scramVerifier(password, salt, iterations)` coincide con un vector de prueba conocido (`SCRAM-SHA-256$4096:<sal>$<StoredKey>:<ServerKey>`); `planSql(names, verifier)` produce las sentencias de [contracts/instance-commands.md](contracts/instance-commands.md) con `escapeIdentifier` y sin la contraseña en claro; `buildDatabaseUrl` usa servidor y puerto de la URL de administración salvo `--host`/`--port`, conserva `sslmode` y codifica la contraseña; `describeAdminUrl` solo devuelve `host:puerto`; los errores de `pg` se traducen a `admin_connect_failed`/`permission_denied`/`step_failed` sin su texto
- [X] T034 [P] [US3] Ampliar `tests/unit/provisioning/env-file.test.ts` con `setVariable(path, 'DATABASE_URL', value)`: reemplaza solo esa línea y su `# PENDIENTE` inmediato, conserva el resto byte a byte y el modo del fichero, escritura atómica (temporal + `rename`), rechaza con `database_url_set` si ya tiene valor
- [X] T035 [P] [US3] Crear `tests/integration/provisioning/database.test.ts` (Testcontainers PostgreSQL 16): dos instancias creadas → cada usuario conecta a su BD, no a la otra (SC-006), y un rol `LOGIN` sin privilegios creado en el test no conecta a ninguna; el usuario no tiene `CREATEDB`/`CREATEROLE`/`SUPERUSER`; la BD está vacía y su esquema `public` es del usuario; segundo intento con BD o rol existentes → `db_exists`/`role_exists` sin cambiar nada (catálogos idénticos antes y después); fallo inyectado en `CREATE DATABASE` → rol retirado y `rolledBack: ['role']`; fallo inyectado en `REVOKE` o en la prueba de conexión → BD y rol siguen existiendo, informe con `steps` exactos y órdenes manuales; el SQL de `--print-sql` ejecutado con `pg` produce el mismo estado y la `DATABASE_URL` escrita conecta; la contraseña del usuario no aparece en `pg_stat_activity` ni en las sentencias enviadas (solo el verificador)
- [X] T036 [P] [US3] Crear `tests/integration/provisioning/cli-db.test.ts`: `instance:db` con `INSTANCE_DB_ADMIN_URL` → código 0, salida de [contracts/instance-commands.md](contracts/instance-commands.md), `DATABASE_URL` escrita y `database` en el inventario sin contraseña; rechazos `unknown_instance`, `instance_retired`, `database_already_registered`, `database_url_set`, `env_other_instance` sin cambiar nada; sin `--env` usa `<dir. inventario>/envs/<id>.env` y, si no existe, código 2 con `env_unreadable`; fallo inyectado en la creación (paso `database` y paso `revoke`) → `DATABASE_URL` vuelve a quedar vacía y el inventario no cambia; fallo inyectado al escribir el inventario tras crear la BD → `DATABASE_URL` queda escrita, código 1 con `inventory_not_updated`, y un `instance:sync` posterior completa `database`; mientras dura la orden, otra escritura del inventario espera o falla con `inventory_busy`; sin URL y sin terminal → 2; con terminal se pide sin eco; `--print-sql` sin `--host`/`--port` → 2, con ellos no abre ninguna conexión (cliente `pg` inyectado que falla si se usa); la URL de administración, su contraseña y la `DATABASE_URL` no aparecen en stdout, stderr, inventario ni ningún otro fichero (FR-020)
- [X] T037 [US3] Crear `tests/integration/provisioning/cli-e2e.test.ts` (SC-003): `new` → `db` contra Testcontainers → completar `ANTHROPIC_API_KEY` de prueba → `check` apto a la primera, sin errores; y el mismo entorno es aceptado por `loadEnv` del núcleo (con `BACKUP_DIR` apuntando a un directorio temporal) ("apto" ⇒ "arranca")

### Implementation for User Story 3

- [X] T038 [US3] Implementar `setVariable` en `src/provisioning/env-file.ts` (T034)
- [X] T039 [US3] Crear `src/provisioning/database.ts` (parte pura): `databaseNames`, `generateDbPassword` (`randomBytes(24)` en base64url), `scramVerifier` con PBKDF2-SHA256 de `node:crypto`, `planSql`, `buildDatabaseUrl`, `describeAdminUrl` y `translatePgError` (T033)
- [X] T040 [US3] Implementar `createDatabase(adminUrl, plan, deps)` en `src/provisioning/database.ts`: comprobación previa en `pg_database`/`pg_roles`, `CREATE ROLE … LOGIN PASSWORD '<verificador>'`, `CREATE DATABASE … OWNER` fuera de transacción, `REVOKE CONNECT, TEMPORARY … FROM PUBLIC`, prueba `select 1` como el usuario nuevo; `DROP ROLE` solo si falla el paso de la BD; resultado `{ database, steps, rolledBack, failure }` y órdenes manuales si queda algo creado; cliente `pg` y puntos de fallo inyectables; cierra siempre las conexiones (T035)
- [X] T041 [US3] Añadir la suborden `db <id> [--env <fichero>] [--host] [--port] [--print-sql]` a `src/cli/instance.ts` (`--env` por defecto `<dir. inventario>/envs/<id>.env`): obtiene la URL de administración de `INSTANCE_DB_ADMIN_URL` o la pide sin eco (solo en memoria); toma el bloqueo del inventario y lo mantiene hasta el final; comprueba los requisitos (instancia en inventario, no `retired`, sin `database`, `INSTANCE_ID` del fichero, `DATABASE_URL` vacía); escribe `DATABASE_URL` con `setVariable` **antes** de crear nada; ejecuta `createDatabase` (o imprime `planSql`); si falla, vuelve a dejar vacía `DATABASE_URL` e informa (también si esa restauración falla); si va bien, escribe la identidad en el inventario y, si esa escritura falla, termina con `inventory_not_updated`; imprime el informe de éxito o de fallo de [contracts/instance-commands.md](contracts/instance-commands.md) (T036, T037)

**Checkpoint**: el alta completa (`new` → `db` → `check`) funciona de extremo a extremo; SC-003 y SC-006 verificados.

---

## Phase 6: User Story 4 - El operador consulta y mantiene el inventario de instancias (Priority: P2)

**Goal**: `instance:list`, `register`, `sync`, `update`, `verified` y `retire` mantienen el
inventario sin secretos, con las instancias dadas de baja contando para siempre y el aviso de
verificación vencida.

**Independent Test**: registrar una instancia existente desde su entorno, anotar una verificación
de copia a partir del JSON de `db:verify`, listar y dar de baja; en cada paso, buscar en el
inventario los valores secretos de los entornos usados devuelve 0 coincidencias.

### Tests for User Story 4 ⚠️

- [X] T042 [P] [US4] Ampliar `tests/unit/provisioning/inventory.test.ts` con las operaciones puras: `registerInstance` (rechaza `duplicate_instance_id` y entorno sin `INSTANCE_ID` válido; con coincidencias registra igualmente y devuelve los avisos `duplicate_*`; estado `active` por defecto o `testing`); `syncInstance` (huellas cambiadas pasan a `current: false`, se añaden las nuevas, ninguna se borra, actualiza `database`, `publicUrl` y `backupDir` desde el entorno —también cuando `database` era `null`—, informa de las variables cambiadas, rechaza `env_other_instance`); `updateInstance` (transiciones de [data-model.md](data-model.md#transiciones-de-estado), `invalid_transition` desde `retired`, `--data-deleted` solo en `retired`, `looks_like_secret` para textos con URL con credenciales o con forma de secreto); `recordVerification` (esquema del subconjunto de `VerifyReport`, instancia por `sourceInstance` o por el prefijo `<instancia>__` del fichero, `other_instance`, `invalid_report`, `lastSuccessfulVerificationAt` solo con `restorable`); `retireInstance` (fecha de hoy, final); `listView(inventory, now)` con `verificationOverdue` para activas sin verificación correcta en 31 días y sin `fingerprints`
- [X] T043 [P] [US4] Crear `tests/integration/provisioning/cli-inventory.test.ts`: `register` → 0 con avisos si coincide con otra; `register` sin inventario y sin terminal → 2 con `inventory_missing` sin escribir nada, y con `--create-inventory` lo crea; `verified` con un fichero y con `-` (entrada estándar) y con el informe de otra instancia → `other_instance`; `update --status active --image 0.1.0`; `list` para personas con la marca `!` y el resumen final, y `--json` sin huellas; `list` sin clave funciona y con clave equivocada falla; `retire` pide escribir el `id` (o `--yes` sin terminal), muestra los pasos manuales y después `new` con ese `id` → `duplicate_instance_id` y `check` de otro entorno con sus secretos → `duplicate_secret`; `sync` tras rotar `SESSION_SECRET` → la huella anterior sigue contando; tras cada orden el inventario no contiene ningún valor de `collectSecrets` de los entornos usados

### Implementation for User Story 4

- [X] T044 [US4] Implementar en `src/provisioning/inventory.ts` las operaciones puras `registerInstance`, `syncInstance` (que también actualiza `database`, `publicUrl` y `backupDir` desde el entorno), `updateInstance`, `recordVerification` (con el esquema Zod del subconjunto de `db:verify --json`), `retireInstance` y `listView`, reutilizando `envFingerprints`/`databaseIdentity` de `fingerprint.ts` y `compare` de `check.ts` para los avisos (T042)
- [X] T045 [US4] Implementar `formatInstanceList(view, inventoryPath)` en `src/provisioning/inventory.ts` con la tabla de [contracts/instance-commands.md](contracts/instance-commands.md) (estados en español, `—` sin verificación, días transcurridos, baja y borrado, `!` y resumen de vencidas) (SC-007)
- [X] T046 [US4] Añadir las subórdenes `list [--json]`, `register <entorno> --client [--status]`, `sync <id> <entorno>`, `update <id> [opciones]`, `verified <id> <fichero|->` y `retire <id> [--yes]` a `src/cli/instance.ts`; las que escriben lo hacen con `withInventoryLock`; `register` crea el inventario y su clave si no existe solo tras la confirmación `crear` en la terminal o con `--create-inventory` (si no, `inventory_missing`); `retire` muestra los pasos manuales de FR-028a (T043)

**Checkpoint**: las cuatro historias funcionan; el operador responde desde `instance:list` qué instancias hay, su estado, versión y verificaciones vencidas.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: privacidad de extremo a extremo, documentación y validación final.

- [X] T047 [P] Crear `tests/integration/provisioning/privacy.test.ts` (SC-005): ejecuta todas las subórdenes (`new`, `db`, `check` con y sin `--json`, `register`, `sync`, `update`, `verified`, `list` con y sin `--json`, `retire`) y sus rechazos principales sobre entornos de prueba, recoge stdout, stderr, el inventario y cualquier fichero nuevo fuera de los entornos, y busca todos los valores de `collectSecrets`, la clave del inventario, la URL de administración y las `DATABASE_URL`: 0 coincidencias (salvo la línea única de la contraseña de `new` y la de la clave al crear el inventario)
- [X] T048 [P] Comprobar en `tests/unit/isolation.test.ts` (o el test de dependencias de módulos equivalente) que `src/provisioning` no importa Fastify ni módulos de dominio/canales/panel, que solo `database.ts` importa `pg` y que `src/server.ts`/`src/startup.ts` no importan `src/provisioning` (FR-034)
- [X] T049 [P] Actualizar `docs/operacion-multicliente.md`: §2 alta con `instance:new` → `instance:db` (o `--print-sql`) → completar pendientes → `instance:check`, sustituyendo los pasos manuales; clave del inventario y su custodia; permisos en Windows (ACL heredada); limitación de alias de servidor; §7 baja con `instance:retire` y `update --data-deleted`; recuperación de un entorno perdido (rehacerlo desde la plantilla con secretos nuevos, pasar la `BACKUP_KEY` antigua a `BACKUP_KEYS_PREVIOUS` si se conserva e `instance:sync`); §9 propuesta P1 hecha (FR-035)
- [X] T050 Avisar al usuario y después actualizar `README.md` con el estado de la 007 y las órdenes `pnpm instance:*` (FR-035, regla de `CLAUDE.md`)
- [X] T051 [P] Añadir a la sección "Arranque y pruebas en local" de `CLAUDE.md` las líneas de `pnpm instance:new`, `instance:db`, `instance:check` e `instance:list` con `INSTANCE_INVENTORY` e `INSTANCE_INVENTORY_KEY`
- [X] T052 Ejecutar `pnpm lint && pnpm typecheck && pnpm test` (unit + integration) y corregir lo que falle; confirmar que los tests existentes de arranque (`tests/unit/env.test.ts`) siguen pasando sin cambios en sus expectativas
- [X] T053 Recorrer los escenarios 1–4 de [quickstart.md](quickstart.md) en el equipo del operador (incluido Windows) y anotar cualquier desviación en la guía o en los contratos

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sin dependencias.
- **Foundational (Phase 2)**: depende de Setup; **bloquea todas las historias**.
- **US1 (Phase 3)**: depende de Foundational.
- **US2 (Phase 4)**: depende de Foundational; usa `secretQuality` de US1 en sus tests (T025) y la
  prueba independiente de US2 usa `instance:check` → conviene terminar US1 antes.
- **US3 (Phase 5)**: depende de Foundational. `instance:db` necesita una instancia en el inventario
  (los tests la crean con los helpers); T037 (extremo a extremo) necesita US1 y US2.
- **US4 (Phase 6)**: depende de Foundational; los avisos de `register`/`sync` reutilizan `compare`
  de US1 (T022).
- **Polish (Phase 7)**: depende de todas las historias.

### User Story Dependencies

- **US1 (P1)**: independiente tras Foundational. MVP.
- **US2 (P1)**: independiente en su implementación; su validación final usa US1.
- **US3 (P2)**: independiente salvo T037 (US1 + US2).
- **US4 (P2)**: independiente salvo la reutilización de `compare` (US1).

### Within Each User Story

- Tests primero y fallando.
- Lógica pura (`secrets.ts`, `env-file.ts`, `check.ts`, `generate.ts`, `database.ts`,
  `inventory.ts`) antes de la suborden de `src/cli/instance.ts`.
- `src/cli/instance.ts` y `src/provisioning/secrets.ts`, `env-file.ts`, `check.ts`,
  `inventory.ts` se tocan en varias historias: esas tareas van en secuencia, nunca en paralelo.

### Parallel Opportunities

- Setup: T002 en paralelo con T001.
- Foundational: todos los tests T003–T009 en paralelo; T011, T012 y T013 en paralelo; T010 en
  paralelo con ellos (fichero distinto).
- US1: T017, T018 y T019 en paralelo.
- US2: T025, T026, T027 y T028 en paralelo.
- US3: T033, T034, T035 y T036 en paralelo; T038 y T039 en paralelo.
- US4: T042 y T043 en paralelo.
- Con Foundational terminado, US3 (`database.ts`) puede avanzar en paralelo con US1/US2, salvo las
  tareas que tocan `src/cli/instance.ts` y `env-file.ts`.
- Polish: T047, T048, T049 y T051 en paralelo.

---

## Parallel Example: User Story 1

```bash
# Tests de US1 a la vez:
Task: "secretQuality en tests/unit/provisioning/secrets.test.ts"
Task: "Tabla SC-002 en tests/unit/provisioning/check.test.ts"
Task: "CLI check en tests/integration/provisioning/cli-check.test.ts"
```

## Parallel Example: User Story 3

```bash
# Tests de US3 a la vez:
Task: "Nombres, SCRAM y plan SQL en tests/unit/provisioning/database.test.ts"
Task: "setVariable en tests/unit/provisioning/env-file.test.ts"
Task: "Testcontainers SC-006 en tests/integration/provisioning/database.test.ts"
Task: "CLI db en tests/integration/provisioning/cli-db.test.ts"

# Implementación pura en paralelo:
Task: "setVariable en src/provisioning/env-file.ts"
Task: "Nombres, SCRAM y plan SQL en src/provisioning/database.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1: Setup.
2. Phase 2: Foundational (bloquea todo).
3. Phase 3: US1 — `instance:check`.
4. **PARAR y VALIDAR**: registrar a mano en un inventario de prueba y validar el entorno de la
   instancia existente; ya protege cualquier cambio de entorno.

### Incremental Delivery

1. Setup + Foundational → base lista.
2. US1 → `instance:check` (MVP).
3. US2 → `instance:new`; alta sin copiar entornos.
4. US3 → `instance:db`; alta completa hasta BD creada (SC-001, SC-003, SC-006).
5. US4 → mantenimiento del inventario y registro de la instancia existente.
6. Polish → privacidad SC-005, guía, README (avisando antes) y quickstart.

---

## Notes

- [P] = ficheros distintos y sin dependencias pendientes.
- [Story] = trazabilidad con la historia de la spec.
- Commit tras cada tarea o grupo lógico.
- Evitar: mostrar valores en mensajes de aserción de los tests (usar comparaciones booleanas para
  las búsquedas de secretos, de modo que un fallo tampoco imprima el secreto).
