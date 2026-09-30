# Research: Aprovisionamiento de instancias

**Feature**: `007-instance-provisioning` | **Plan**: [plan.md](plan.md) | **Spec**: [spec.md](spec.md)

Decisiones técnicas para generar, validar y registrar el entorno de una instancia y crear su base
de datos. Parte del código actual: `src/config/env.ts` valida el entorno al arrancar con un esquema
Zod (`envSchema` + `botSchema`) y ya conoce `INSTANCE_ID_PATTERN`, las reglas de `SESSION_SECRET`,
`BACKUP_KEY`, WhatsApp, SMTP y copias; `src/cli/backup-common.ts` fija el patrón de los comandos
(`CliIO` inyectable, `parseArgs`, `--json`, códigos de salida 0/1/2, `runIfMain`);
`pnpm operator:hash-password` calcula el hash Argon2id con `argon2`; `db:verify --json` emite un
`VerifyReport` (006). La guía [docs/operacion-multicliente.md](../../docs/operacion-multicliente.md)
§2 describe el alta manual que esta feature sustituye. Cada decisión sigue el formato Decisión /
Motivo / Alternativas.

---

## R1. Dónde viven las herramientas y cómo se invocan

**Decisión**: módulo nuevo **`src/provisioning/`** (sin HTTP, sin dependencia del dominio de la
conversación) y un único punto de entrada **`src/cli/instance.ts`** con subórdenes. En
`package.json`, un script por suborden, todos al mismo fichero:

| Script | Suborden | Historia |
|---|---|---|
| `pnpm instance:check <entorno> [--json]` | `check` | US1 |
| `pnpm instance:new [--out <ruta>] …` | `new` | US2 |
| `pnpm instance:db <id> --env <entorno> [--print-sql] …` | `db` | US3 |
| `pnpm instance:list [--json]` | `list` | US4 |
| `pnpm instance:register <entorno> --client <nombre> [--status …]` | `register` | US4 |
| `pnpm instance:sync <id> <entorno>` | `sync` | US4 (FR-032) |
| `pnpm instance:update <id> [--client …] [--image …] …` | `update` | US4 |
| `pnpm instance:verified <id> <fichero.json \| ->` | `verified` | US4 |
| `pnpm instance:retire <id>` | `retire` | US4 (FR-028a) |

**Motivo**:

- Sigue la convención de los comandos existentes (`db:backup`, `kb:snapshot`…): nombre
  `ámbito:verbo`, `tsx` en local.
- Un solo fichero de entrada comparte la lectura de la clave del inventario, la ruta, el bloqueo y
  los mensajes, sin repetir código en nueve CLI.
- Vivir en `src/` hace que el test de neutralidad sectorial (Principio I, FR-033) las recorra y
  que `pnpm typecheck`/`lint` las cubran. Se compilan en la imagen pero nada las invoca al
  arrancar (FR-034); se usan desde el equipo del operador, donde está el repositorio y
  `.env.example`.

**Alternativas**: un paquete o repositorio aparte (se desincronizaría de `env.ts`, que es la
fuente de las reglas); nueve ficheros `src/cli/instance-*.ts` (más repetición); un script de shell
(no portable a Windows y sin tests).

---

## R2. Una sola fuente de reglas del entorno: `env.ts` + reglas de alta

**Decisión**: la validación ejecuta **el mismo esquema que el arranque** y añade encima las
reglas propias del alta.

1. `src/config/env.ts` exporta `checkEnv(source): EnvIssue[]` (`{ variable, message }`), que hace
   `safeParse` del esquema actual y traduce cada incidencia. Las incidencias de campo ya tienen
   `path: ['VAR']`; a las incidencias personalizadas de `botSchema` (WhatsApp incompleto, SMTP sin
   remitente, `BACKUP_KEY` igual a `SESSION_SECRET`, copias obligatorias en production…) se les
   añade el `path` de la variable. `loadEnv` sigue usando solo `message`: **el arranque no cambia**
   (FR-034).
2. `src/provisioning/check.ts` añade las reglas de alta que el arranque no exige:
   `NODE_ENV=production`, `PUBLIC_BASE_URL` presente y `https` (no `localhost`), `TRUST_PROXY`
   vacío en production (advertencia), `DATABASE_URL` de ejemplo o con superusuario, calidad de
   cada secreto (R3), secretos repetidos dentro del propio entorno y comparación con el
   inventario (R5).

**Motivo**: si la validación reimplementase las reglas, con cada feature nueva se desviaría del
arranque y daría "apto" a entornos que no arrancan (SC-003). Reutilizar el esquema garantiza que
"apto" implica "arranca", y las reglas extra solo pueden endurecer.

**Perfil de validación**: `production` por defecto. Si el `INSTANCE_ID` del entorno está en el
inventario con estado `testing` (instancia de pruebas del operador, caso límite de la spec), se
aplica el perfil `testing`: no exige `NODE_ENV=production` ni `https` en `PUBLIC_BASE_URL`, pero
sí todas las reglas del núcleo, la calidad de los secretos y la comparación con el resto.

**Alternativas**: un segundo esquema Zod "de producción" (duplicaría reglas); ejecutar
`loadEnv` y parsear el texto del error (frágil, sin variable).

---

## R3. Calidad de los secretos (FR-004)

**Decisión**: función pura `secretQuality(variable, value)` con una regla por tipo:

| Variables | Regla (error si no la cumple) |
|---|---|
| `SESSION_SECRET`, `BACKUP_KEY`, cada clave de `BACKUP_KEYS_PREVIOUS` | 64 hex y más de 8 caracteres distintos (la regla del núcleo) |
| `OPERATOR_PASSWORD_HASH` | Formato `$argon2id$v=19$m=…,t=…,p=…$salt$hash`; advertencia si `m < 19456` o `t < 2` (mínimos OWASP) |
| `WHATSAPP_VERIFY_TOKEN` | ≥ 32 caracteres y ≥ 10 distintos |
| `WHATSAPP_APP_SECRET` | ≥ 32 caracteres |
| `WHATSAPP_ACCESS_TOKEN` | ≥ 40 caracteres |
| `ANTHROPIC_API_KEY` | ≥ 40 caracteres; advertencia si no empieza por `sk-ant-` |
| `STT_API_KEY` | ≥ 20 caracteres |
| Contraseña de `DATABASE_URL` | ≥ 16 caracteres; error si es `chatbot` (la de `.env.example`) |

Y para todos: error si el valor es de relleno — contiene (sin distinguir mayúsculas) `changeme`,
`example`, `ejemplo`, `placeholder`, `pendiente`, `todo`, `xxx`, `secret`, `password`, `test`, o
es una repetición de un solo carácter o una secuencia `0123…`/`abcd…`.

**Motivo**: las reglas del núcleo ya fijan las claves hex; para los valores de terceros no se
conoce el formato exacto, así que se exige solo una longitud mínima conservadora (para no rechazar
valores válidos) y se detecta el relleno típico. Ninguna regla muestra el valor (FR-007).

**Alternativas**: estimar entropía de Shannon (da falsos positivos con tokens base64 cortos y
falsos negativos con relleno largo); validar la clave contra la API del proveedor (red, coste y
fuera de alcance).

---

## R4. Huellas de secretos: HMAC-SHA256 con la clave del inventario (FR-026)

**Decisión**:

- **Clave del inventario**: 32 bytes aleatorios en hex. Se entrega a las herramientas por la
  variable de entorno **`INSTANCE_INVENTORY_KEY`** (el operador la exporta en su terminal desde su
  gestor de secretos); nunca por argumento (quedaría en el historial de la terminal) ni dentro del
  inventario.
- **Huella** = primeros 16 bytes de `HMAC-SHA256(clave, "chatbot-inventory/v1\0" + clase + "\0" +
  valor normalizado)`, en base64url (22 caracteres).
- **Clase**: todos los secretos comparten la clase `secret`, de modo que un mismo valor se detecta
  aunque esté en variables distintas (el `SESSION_SECRET` de una instancia usado como
  `BACKUP_KEY` de otra). Los identificadores no secretos que se comparan tienen clase propia
  (`database`, `database_user`, `public_url`, `backup_dir`, `whatsapp_phone`) y solo se comparan
  consigo mismos.
- **Normalización**: claves hex en minúsculas; URL pública por su origen; base de datos como
  `host-en-minúsculas:puerto/nombre` (puerto 5432 por defecto); directorio de copias sin barra
  final; el resto, recortado.
- **Comprobación de clave**: el inventario guarda `keyCheck` = primeros 16 bytes de
  `HMAC-SHA256(clave, "chatbot-inventory/v1\0key-check")`. Si no coincide (comparación en tiempo
  constante), la clave no es la del inventario (FR-026a).
- **Qué se huella** ([data-model.md](data-model.md#huella)): `SESSION_SECRET`, `BACKUP_KEY`,
  `BACKUP_KEYS_PREVIOUS` (cada una, como anterior), `OPERATOR_PASSWORD_HASH`, `ANTHROPIC_API_KEY`,
  `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `STT_API_KEY`, la
  contraseña de `DATABASE_URL`, `SMTP_URL` completa, y los identificadores anteriores.

**Motivo**:

- Con HMAC, quien tenga el inventario sin la clave no puede comprobar si un valor candidato es el
  secreto de una instancia (requisito de la clarificación), a diferencia de un SHA-256 sin clave.
- Los secretos generados tienen ≥ 128 bits, así que ni con la clave es viable la fuerza bruta; la
  huella del hash Argon2id detecta que se copió el hash de otra instancia (la contraseña, generada
  siempre por la herramienta, es única).
- 128 bits de huella hacen despreciable la probabilidad de una coincidencia falsa entre unos
  cientos de valores.
- Guardar los identificadores también como huellas con `current: true/false` da un historial
  uniforme: tras un `sync` el valor anterior sigue contando como usado (FR-029, FR-032).

**Alternativas**: SHA-256 sin clave (descartado en la clarificación); Argon2/scrypt por huella
(lento sin beneficio: los valores ya tienen entropía alta); cifrar los secretos en el inventario
(el inventario MUST NOT permitir recuperarlos, FR-026).

---

## R5. Comparación con el inventario (FR-005, FR-006)

**Decisión**: `compare(envFingerprints, inventory, selfId)`:

- Se excluye la instancia con el mismo `INSTANCE_ID` (US1-6); se incluyen todas las demás,
  **también las dadas de baja** (FR-029), y sus huellas vigentes y anteriores.
- `INSTANCE_ID` se compara en claro con el `id` de las demás.
- Cualquier coincidencia de clase `secret` es **error** salvo que las dos variables sean
  `SMTP_URL` (advertencia `shared_smtp`, FR-006). Una coincidencia de `SMTP_URL` con otra
  variable secreta sí es error.
- `database`, `database_user`, `public_url` y `whatsapp_phone` repetidos: **error**.
- `backup_dir` repetido: **advertencia** (FR-006, caso límite).
- Cada entrada dice la variable propia, la variable y el `id` de la otra instancia, y si el valor
  coincidente es vigente o anterior. Nunca el valor.
- Dentro del propio entorno, dos variables secretas con el mismo valor son error
  (`secret_reused_within`); `BACKUP_KEY = SESSION_SECRET` ya lo detecta la regla del núcleo y no se
  duplica.

**Motivo**: es la lista de la FR-005/FR-006 convertida en reglas por clase; la comparación por
huellas permite hacerla sin tener ningún otro fichero de entorno a mano.

**Limitación documentada** (caso límite): el mismo servidor escrito con dos nombres no se detecta;
lo cubre el usuario propio de cada base de datos (US3) y la coincidencia del usuario.

---

## R6. Formato y escritura del inventario (FR-024, FR-031)

**Decisión**:

- **JSON** con sangría de 2 espacios, validado con Zod al leer (`format: "chatbot-inventory"`,
  `version: 1`). Esquema en [contracts/inventory-format.md](contracts/inventory-format.md).
- **Ubicación**: `--inventory <ruta>`, si no la variable `INSTANCE_INVENTORY`, si no
  `~/.chatbotasesor/inventory.json`. Se rechaza una ruta dentro del repositorio del núcleo aunque
  esté excluida del control de versiones: contiene nombres de clientes (FR-024).
- **Bloqueo**: fichero `<inventario>.lock` creado con `open(…, 'wx')` (atómico en Windows y
  POSIX) con el pid y la hora. Si existe, se reintenta durante 5 s y después se falla con
  `inventory_busy`; un bloqueo de más de 10 min se señala como posiblemente huérfano, con la
  indicación de borrarlo a mano si no hay otra operación (no se borra solo).
- **Escritura atómica**: bajo el bloqueo se vuelve a leer y validar el inventario; si no se puede
  leer o no es válido, se aborta sin escribir (FR-031, caso límite). Se escribe
  `<inventario>.tmp-<aleatorio>` con modo `0600`, `fsync`, y `rename` sobre el definitivo (con
  hasta 3 reintentos ante `EPERM`/`EBUSY` en Windows por antivirus o indexador).
- **Creación**: si no existe, la primera orden que escribe (`new` o `register`) lo crea con su
  `keyCheck`. Si `INSTANCE_INVENTORY_KEY` está definida se usa; si no, se genera una clave nueva y
  se muestra una sola vez con la instrucción de guardarla en el gestor de secretos (misma regla de
  terminal que la contraseña, R7). `check` sin inventario valida solo la coherencia y lo advierte
  (`not_compared`).
- **Fechas**: alta, baja y borrado como fecha de calendario `YYYY-MM-DD` del equipo del operador;
  la verificación de copia como instante ISO 8601 con desfase. No afecta a la regla de horarios
  del negocio, que es de la configuración de cada instancia.

**Motivo**: JSON es legible, lo valida Zod sin dependencias nuevas y el operador puede revisarlo
o versionarlo en su propio repositorio privado. El bloqueo con `wx` + `rename` es la forma
portable de "una operación a la vez, nunca a medio escribir".

**Alternativas**: YAML (dependencia nueva, ambigüedades de tipos); SQLite (no legible,
dependencia nativa); `proper-lockfile` (dependencia para algo de 30 líneas).

---

## R7. Generación del entorno (FR-010 a FR-017)

**Decisión**:

- **Plantilla**: `.env.example` de la raíz del núcleo (localizada subiendo desde el módulo hasta
  `package.json`, como `coreVersion`). Se procesa **línea a línea**: se conservan comentarios y
  orden, y cada línea `VAR=valor` se sustituye si la herramienta aporta valor. Si la plantilla
  tiene una variable que la herramienta no conoce, se copia con su valor por defecto (el fichero
  queda completo aunque el núcleo añada variables). Test: el fichero generado tiene exactamente
  las variables de la plantilla.
- **Lectura de entornos**: `util.parseEnv` de Node 22, el mismo analizador que
  `process.loadEnvFile` usa en local. Las herramientas **no** cargan el `.env` del repositorio ni
  tocan `process.env` con el entorno leído.
- **Valores**: `NODE_ENV=production`; `INSTANCE_ID`, `PUBLIC_BASE_URL` (normalizada a origen),
  `DEFAULT_TIMEZONE`, `DEFAULT_PHONE_REGION`, `DEFAULT_CURRENCY`, `EMERGENCY_CONTACT_PHONE`
  (normalizado a E.164 con la región dada) y `BACKUP_DIR` (por defecto
  `/var/lib/chatbot/backups`, el volumen de la imagen); resto, los de la plantilla.
- **Secretos** con `node:crypto`: `SESSION_SECRET` y `BACKUP_KEY` = `randomBytes(32)` en hex;
  `WHATSAPP_VERIFY_TOKEN` = `randomBytes(24)` en hex (48 caracteres), solo con `--whatsapp`;
  contraseña del operador = 24 caracteres con `randomInt` sobre un alfabeto de 56 símbolos sin
  ambiguos (≈ 139 bits) y su hash con `argon2.hash(…, { type: argon2id })`, los mismos parámetros
  que `operator:hash-password`. No hay opción para teclear la contraseña (FR-012).
- **Pendientes** (FR-013): `DATABASE_URL`, `ANTHROPIC_API_KEY`, `WHATSAPP_PHONE_NUMBER_ID`,
  `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_GRAPH_VERSION` (si `--whatsapp`),
  `SMTP_URL` y `SMTP_FROM` quedan vacías con una línea `# PENDIENTE: <quién lo aporta>` justo
  encima. Una cabecera de comentario indica instancia y fecha de generación (sin secretos).
- **Orden y seguridad** (FR-014, FR-015, FR-016): se validan los datos (con los mismos esquemas
  de `env.ts`: `INSTANCE_ID_PATTERN`, `isValidTimezone`, `libphonenumber-js`, origen `https`) →
  se toma el bloqueo del inventario → se comprueba que el `id` no existe y que ninguna huella
  nueva coincide (regenerando si ocurriera, con un máximo de 3 intentos) → se escribe el entorno
  con `flag: 'wx'` (nunca sobrescribe) y `mode: 0o600` → se escribe el inventario → se libera. Si
  falla la escritura del inventario, se borra el fichero de entorno recién creado (sus secretos no
  se usan en ningún sitio) y se informa.
- **Ruta de salida**: `--out`, por defecto `<directorio del inventario>/envs/<id>.env` (fuera del
  repositorio). Si la ruta resuelta está dentro del repositorio del núcleo, se exige que
  `git check-ignore -q <ruta>` diga que está excluida; si `git` no está disponible, se rechaza.
- **Permisos en Windows**: `mode` no aplica; el fichero hereda la ACL del directorio (por defecto,
  el perfil del usuario). Se documenta en la guía (FR-016 "en los sistemas que lo permitan").
- **Mostrar la contraseña una sola vez** (FR-012): `new` exige una terminal interactiva en la
  salida estándar; si la salida está redirigida, se rechaza antes de generar nada
  (`not_interactive`) para que la contraseña no acabe en un fichero o un registro. `new` no tiene
  `--json`. La contraseña no se escribe en ningún fichero ni en registros.

**Motivo**: partir siempre de la plantilla del núcleo elimina el "copiar el `.env` de otro
cliente" (la causa más común de secretos repetidos) y garantiza la clave de copias desde el primer
día. Las comprobaciones antes de escribir hacen que un rechazo no deje nada (FR-014).

**Alternativas**: generar el fichero desde una lista de variables en código (se desincroniza de
`.env.example`); aceptar una contraseña tecleada (descartado en la clarificación); `dotenv` como
dependencia (Node 22 ya trae el analizador).

---

## R8. Creación de la base de datos (FR-018 a FR-023)

**Decisión**:

- **Nombres**: base de datos y usuario `chatbot_<id>` con los guiones cambiados por `_` (≤ 48
  caracteres, dentro del límite de 63 de PostgreSQL). Seguros por construcción (`INSTANCE_ID_PATTERN`)
  y, aun así, citados con `escapeIdentifier` de `pg`.
- **Contraseña del usuario**: `randomBytes(24)` en base64url (32 caracteres, sin caracteres que
  haya que codificar en la URL). Se envía al servidor **ya cifrada como verificador
  SCRAM-SHA-256** calculado en el cliente (`SCRAM-SHA-256$4096:<sal>$<StoredKey>:<ServerKey>`,
  PBKDF2 con `node:crypto`): PostgreSQL guarda tal cual una contraseña que ya viene en ese formato,
  así que la contraseña en claro no aparece en los registros del servidor ni en las órdenes del
  modo "solo instrucciones".
- **Credenciales de administración** (FR-020): URL `postgres://admin:…@host:puerto/postgres`
  leída de la variable `INSTANCE_DB_ADMIN_URL` o, si no está y hay terminal, pedida sin eco
  (como `operator:hash-password`). Solo en memoria; los mensajes de error de conexión se
  sustituyen por códigos propios para que ningún texto de `pg` pueda llevarla.
- **Secuencia** (servidor compatible con PostgreSQL 16):
  1. Comprobar en `pg_database` y `pg_roles` que no existe ninguno de los dos nombres; si existe
     alguno, rechazar sin cambiar nada (`db_exists` / `role_exists`, FR-019).
  2. `CREATE ROLE <u> LOGIN PASSWORD '<verificador>'` (sin `CREATEDB`, `CREATEROLE` ni
     `SUPERUSER`).
  3. `CREATE DATABASE <db> OWNER <u>` (no admite transacción: va aparte).
  4. `REVOKE CONNECT, TEMPORARY ON DATABASE <db> FROM PUBLIC` (FR-018).
  5. Conectarse como `<u>` a `<db>` y ejecutar `select 1` para comprobar la dirección resultante.
  6. Escribir `DATABASE_URL` en el entorno y la identidad en el inventario.

  En PostgreSQL 15+ el esquema `public` es de `pg_database_owner`, es decir, del usuario nuevo, y
  `PUBLIC` ya no tiene `CREATE` en él: no hace falta más.
- **Fallos a mitad** (FR-023): si falla el paso 3, se hace `DROP ROLE` del usuario creado en el
  paso 2 (no hay base de datos que lo use). Si falla el 4 o el 5, **no se borra la base de datos**
  (las herramientas nunca borran bases de datos, clarificación y FR-019): se informa de qué existe
  exactamente (base de datos vacía y usuario) y de las órdenes para terminar o retirarlo a mano, y
  no se escribe nada en el entorno ni en el inventario.
- **Dirección resultante**: servidor y puerto de la URL de administración salvo `--host` /
  `--port` (el nombre con el que la instancia ve el servidor puede ser distinto, p. ej. en una red
  Docker); se conserva `sslmode` si la URL de administración lo lleva.
- **Modo "solo instrucciones"** (`--print-sql`, FR-022): exige `--host` y `--port`, no se
  conecta a nada, imprime las órdenes SQL de los pasos 1–4 (con el verificador, no la contraseña)
  para ejecutarlas con `psql` o la consola del proveedor, y escribe la `DATABASE_URL` en el
  entorno y la identidad en el inventario. La dirección con contraseña no se imprime: va solo al
  fichero de entorno, que es secreto.
- **Modificación del entorno** (FR-021): solo se reemplaza la línea `DATABASE_URL=` (y su
  comentario `# PENDIENTE` si lo hay), con escritura atómica (temporal + `rename`) conservando el
  modo. Si `DATABASE_URL` ya tiene valor, se rechaza (`database_url_set`).
- **Requisito**: la instancia debe estar en el inventario y sin `database` (no se crea dos veces).

**Motivo**: es la receta manual de la guía (§2.2) hecha repetible, con la protección de no tocar
nada existente y sin dejar la contraseña en claro fuera del fichero de entorno.

**Alternativas**: contraseña en claro en `CREATE ROLE` (quedaría en los registros del servidor si
registran sentencias); `\password` de `psql` (no automatizable sin `psql`); borrar la base de
datos a medio crear (lo prohíbe la clarificación).

---

## R9. Registro, sincronización, verificaciones y baja (FR-025 a FR-032)

**Decisión**:

- **`register`**: lee el entorno, lo pasa por la validación de coherencia (sin exigirla) y lo
  registra con sus huellas. `--client` obligatorio; `--status active|testing` (por defecto
  `active`). Si el `INSTANCE_ID` ya existe, se rechaza. Las coincidencias con otras instancias se
  muestran como avisos y la instancia se registra igualmente (US4-1): una instancia ya desplegada
  tiene que contar para las comparaciones aunque haya que corregirla después.
- **`sync`** (rotación, FR-032): recalcula huellas e identidades desde el entorno; las que
  cambian pasan a `current: false` y se añaden las nuevas; ninguna se borra. Rechaza si el
  `INSTANCE_ID` del entorno no es el indicado, y avisa si algún valor nuevo coincide con otra
  instancia.
- **`update`**: datos descriptivos (`--client`, `--image`, `--llm-workspace`,
  `--backup-key-location`), `--status active|testing` y `--data-deleted <YYYY-MM-DD>` (solo en
  instancias dadas de baja). No cambia huellas.
- **`verified`**: lee el JSON de `db:verify --json` (fichero o entrada estándar) y lo valida con
  un esquema Zod del subconjunto que usa (`file`, `restorable`, `failure?`, `sourceInstance?`).
  La instancia de la copia es `sourceInstance` o, si falta (p. ej. `wrong_key`), el prefijo
  `<instancia>__` del nombre del fichero (006). Si no coincide con el `id` indicado, se rechaza
  (`other_instance`). Guarda `at` (ahora), `file`, `result` (`restorable` o el código de fallo) y,
  si es correcta, `lastSuccessfulVerificationAt`.
- **`retire`** (FR-028a): pasa a `retired` con la fecha de baja y muestra los pasos manuales
  (retirar el webhook, revocar la clave del modelo y los secretos, borrar la base de datos y las
  copias en el plazo acordado y anotarlo con `update --data-deleted`). No toca ningún servidor.
- **`list`**: tabla con id, cliente, estado, versión de imagen, última verificación y marca
  `!` en las instancias `active` sin verificación correcta en los últimos 31 días (FR-030,
  SC-007); con `--json`, los mismos datos sin huellas.
- **Estados**: `provisioning` (tras `new`) → `active` o `testing` (por `update --status`) →
  `retired` (por `retire`, sin vuelta atrás). `register` entra directamente en `active` o
  `testing`.

**Motivo**: cubre las operaciones de la FR-028 con la regla de que nada de lo registrado se
olvida (FR-029) y de que el inventario solo se escribe bajo bloqueo.

**Alternativas**: rechazar el registro de instancias con coincidencias (dejaría fuera justo las
que hay que vigilar); leer el resultado de verificación directamente de la instancia (las
herramientas no se conectan a instancias en ejecución, FR-034).

---

## R10. Salida, códigos y privacidad (FR-001, FR-007, FR-008)

**Decisión**:

- Códigos de salida como la 006: **0** apto / correcto, **1** no apto / rechazado, **2**
  argumentos, fichero ilegible o terminal requerida. La clave del inventario ausente o equivocada
  en `check` es **1** con el error `inventory_key_*` (FR-026a: "no apto"); en las demás órdenes,
  **2**.
- Cada entrada de `check` tiene un código cerrado, la variable, un mensaje y la acción que lo
  corrige ([contracts/check-result.md](contracts/check-result.md)).
- `--json` imprime una sola línea con el mismo resultado (FR-008).
- Ningún mensaje contiene valores de variables secretas, la URL de administración ni la
  `DATABASE_URL`; de las URL solo se muestran servidor, puerto, nombre y usuario. Los errores de
  `pg` y de sistema de ficheros se traducen a códigos propios.
- Test de privacidad (SC-005): se recogen todas las salidas de todas las órdenes de las pruebas y
  el inventario resultante y se buscan en ellos todos los valores secretos de los entornos usados
  (incluida la contraseña del operador, salvo en la línea única en que `new` la muestra).

**Motivo**: la salida estructurada y el código de salida permiten usar `instance:check` como
paso de un proceso de despliegue; la regla de no mostrar valores protege aunque la salida acabe
en un registro de CI.

---

## R11. Pruebas

**Decisión**:

- **unit** (`tests/unit/provisioning/`): `secretQuality` (cada regla y relleno), huellas
  (deterministas, dependen de la clave, clase `secret` común), `checkEnv` de `env.ts` (variable en
  cada incidencia), `check` con una tabla que recorre **cada** incoherencia de la FR-003 y **cada**
  tipo de repetición de la FR-005/FR-006 (SC-002), perfil `testing`, exclusión de la propia
  instancia, instancias dadas de baja; plantilla (todas las variables, comentarios, pendientes);
  esquema del inventario; generación de 100 entornos sin secretos repetidos (SC-004, con el hash
  Argon2id inyectable para no tardar); verificador SCRAM (vector de prueba conocido).
- **integration** (`tests/integration/provisioning/`, Testcontainers): creación de dos bases de
  datos (SC-006: cada usuario solo entra en la suya; un usuario sin privilegios no entra en
  ninguna), segundo intento rechazado sin tocar nada, fallo inyectado entre pasos (usuario
  retirado / informe exacto), SQL del modo instrucciones ejecutado con `pg` produce el mismo
  resultado; CLI de extremo a extremo en directorios temporales: `new` → completar terceros →
  `db` → `check` apto a la primera (SC-003); `register`/`verified`/`list`/`retire`/`sync`;
  bloqueo concurrente; inventario corrupto no se sobrescribe; ruta dentro de un repositorio git
  temporal (ignorada / no ignorada); privacidad de todas las salidas (SC-005).
- **Neutralidad**: el recorrido de `tests/unit/sector-neutrality.test.ts` incluye
  `src/provisioning` y `src/cli/instance.ts`.
- Sin `contract` (no hay HTTP) ni `eval` (no cambia la conversación).
