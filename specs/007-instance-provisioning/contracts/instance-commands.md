# Contrato: órdenes `pnpm instance:*`

**Feature**: `007-instance-provisioning` | Decisiones: [research.md](../research.md) R1, R6–R10

Todas las órdenes son subórdenes de `src/cli/instance.ts` (`tsx` en local). Se ejecutan en el
equipo del operador, con el repositorio del núcleo; no se conectan a instancias en ejecución ni
son necesarias para que una instancia arranque (FR-034). Ninguna carga el `.env` del repositorio.

## Entorno común

| Variable | Uso |
|---|---|
| `INSTANCE_INVENTORY` | Ruta del inventario (por defecto `~/.chatbotasesor/inventory.json`); `--inventory <ruta>` la sustituye |
| `INSTANCE_INVENTORY_KEY` | Clave del inventario (64 hex); obligatoria si el inventario existe |
| `INSTANCE_DB_ADMIN_URL` | Solo `instance:db`: URL de administración del servidor; si falta y hay terminal, se pide sin eco |

## Códigos de salida

| Código | Significado |
|---|---|
| 0 | Correcto / apto |
| 1 | Rechazado por las reglas (no apto, id repetido, BD existente, resultado de otra instancia…) |
| 2 | Argumentos no válidos, fichero ilegible, inventario ilegible o bloqueado, clave ausente o equivocada (salvo en `check`, donde es 1), terminal requerida |

## Mensajes comunes

| Código | Mensaje |
|---|---|
| `inventory_key_missing` | Hay un inventario en `<ruta>` pero falta `INSTANCE_INVENTORY_KEY`. Cárgala desde tu gestor de secretos. Si la has perdido, crea un inventario nuevo (`--inventory <otra ruta>`) y vuelve a registrar las instancias con `instance:register`. |
| `inventory_key_wrong` | `INSTANCE_INVENTORY_KEY` no es la clave de este inventario. |
| `inventory_unreadable` | No se puede leer el inventario (`<motivo>`). No se ha modificado. Revísalo o restaura tu copia. |
| `inventory_busy` | Otra operación está usando el inventario. Inténtalo de nuevo. (Si lleva más de 10 min: puede ser un bloqueo huérfano; borra `<ruta>.lock` si no hay otra operación en curso.) |
| `inventory_in_repo` | El inventario no puede estar dentro del repositorio del núcleo: contiene nombres de clientes. |
| `unknown_instance` | No hay ninguna instancia `<id>` en el inventario. |
| `not_interactive` | Esta orden muestra un secreto una sola vez y necesita una terminal; no redirijas su salida. |
| `inventory_missing` | No existe un inventario en `<ruta>`. Si ya tienes uno, revisa `INSTANCE_INVENTORY` o `--inventory`. Si es la primera alta, confirma su creación en la terminal o repite con `--create-inventory`. (Código 2; solo `new` y `register` pueden crearlo.) |

**Creación del inventario** (`new` y `register`): si no existe, con terminal se pregunta «No existe
un inventario en `<ruta>`. Si ya tienes uno, revisa `INSTANCE_INVENTORY` o `--inventory`. Para crear
uno nuevo escribe `crear`»; cualquier otra respuesta cancela sin escribir nada. Sin terminal hace
falta `--create-inventory`. Si `INSTANCE_INVENTORY_KEY` está definida, la pregunta avisa de que
parece existir ya un inventario en otra ruta.

---

## `pnpm instance:check <entorno> [--inventory <ruta>] [--json]` (US1)

Valida el fichero de entorno y lo compara con el inventario. No escribe nada (FR-009). Salida y
catálogo de códigos: [check-result.md](check-result.md).

---

## `pnpm instance:new …` (US2)

```text
pnpm instance:new --id <id> --client <nombre> --url https://… --timezone <IANA>
                  --region <XX> --currency <XXX> --emergency-phone <tel>
                  [--whatsapp] [--backup-dir <ruta>] [--out <ruta>] [--inventory <ruta>]
                  [--create-inventory]
```

Los datos que falten se preguntan si hay terminal. Exige terminal en la salida estándar.

**Salida correcta** (0):

```text
Instancia demo-02 dada de alta en el inventario (estado: en alta).
Entorno escrito en C:\Users\op\.chatbotasesor\envs\demo-02.env (solo legible por tu usuario).

Contraseña del operador del panel (usuario «operador»). Se muestra SOLO ESTA VEZ:

    7kQm…24 caracteres

Siguientes pasos:
  1. Guarda la contraseña, el fichero de entorno y su BACKUP_KEY en tu gestor de secretos
     (la BACKUP_KEY, fuera del directorio de copias). Anota dónde con:
       pnpm instance:update demo-02 --backup-key-location "<dónde>"
  2. Crea la base de datos: pnpm instance:db demo-02
  3. Completa los valores PENDIENTE del fichero (clave del modelo de lenguaje, WhatsApp, correo).
  4. Valida: pnpm instance:check <fichero>
```

En el paso 2 se añade `--env <fichero>` solo si se usó `--out` (sin él, `instance:db` usa la misma
ruta por defecto).

Si el inventario no existía y no había `INSTANCE_INVENTORY_KEY`, antes de los pasos se muestra
también, una sola vez, la clave nueva del inventario con la instrucción de guardarla y exportarla.

**Rechazos** (1, sin escribir nada): `invalid_id`, `duplicate_instance_id` (también si la otra
está dada de baja), `invalid_url` / `duplicate_public_url`, `invalid_timezone`, `invalid_region`,
`invalid_currency`, `invalid_phone`, `invalid_backup_dir`, `output_exists` ("ya existe
`<ruta>`; indica otra con `--out`"), `output_in_repo` ("`<ruta>` está dentro del repositorio y no
está excluida del control de versiones"). Cada mensaje nombra el dato erróneo.

---

## `pnpm instance:db <id> …` (US3)

```text
pnpm instance:db <id> [--env <fichero>] [--host <servidor>] [--port <puerto>] [--inventory <ruta>]
pnpm instance:db <id> [--env <fichero>] --print-sql --host <servidor> --port <puerto>
```

`--env` por defecto es `<directorio del inventario>/envs/<id>.env` (la ruta por defecto de `new`);
si no existe, se rechaza con `env_unreadable` (2) y la indicación de usar `--env`.

Requisitos: `<id>` en el inventario, no `retired`, sin `database`; el `INSTANCE_ID` del fichero es
`<id>`; su `DATABASE_URL` está vacía.

**Orden**: toma el bloqueo del inventario y lo mantiene hasta el final; escribe `DATABASE_URL` en
el fichero **antes** de crear nada (la contraseña nunca existe solo en memoria); crea la base de
datos; si falla, vuelve a dejar vacía `DATABASE_URL`; si va bien, escribe la identidad en el
inventario.

**Salida correcta** (0):

```text
Base de datos creada en db.interna:5432
  base de datos  chatbot_demo_02 (vacía; solo su usuario puede conectarse)
  usuario        chatbot_demo_02 (sin privilegios de administración)
  comprobado     el usuario se conecta a su base de datos
DATABASE_URL escrita en <fichero>. Inventario actualizado.
Las credenciales de administración no se han guardado.
```

**`--print-sql`** (0): no se conecta a nada. Imprime las órdenes y escribe `DATABASE_URL` en el
fichero y la identidad en el inventario:

```text
-- Ejecuta con un usuario que pueda crear bases de datos y usuarios (psql o consola del proveedor).
-- Si alguna de estas dos consultas devuelve filas, NO sigas: ya existen.
SELECT 1 FROM pg_roles    WHERE rolname = 'chatbot_demo_02';
SELECT 1 FROM pg_database WHERE datname = 'chatbot_demo_02';
CREATE ROLE "chatbot_demo_02" LOGIN PASSWORD 'SCRAM-SHA-256$4096:…';
CREATE DATABASE "chatbot_demo_02" OWNER "chatbot_demo_02";
REVOKE CONNECT, TEMPORARY ON DATABASE "chatbot_demo_02" FROM PUBLIC;

DATABASE_URL (con la contraseña) escrita en <fichero>; no se muestra aquí.
```

**Rechazos** (1, sin cambiar nada): `db_exists`, `role_exists`, `database_already_registered`,
`database_url_set`, `env_other_instance`, `instance_retired`.

**Fallos** (1): `admin_connect_failed` ("no se pudo conectar con las credenciales de
administración a `host:puerto`"; sin el texto de `pg`), `permission_denied` (la cuenta no puede
crear bases de datos o usuarios: usa `--print-sql`), `step_failed` con informe exacto:

```text
Fallo al crear la base de datos (paso: database).
  Deshecho: usuario chatbot_demo_02 retirado.
  No queda nada creado en el servidor. DATABASE_URL ha vuelto a quedar vacía y el inventario no
  se ha modificado.
```

```text
Fallo al retirar el acceso general (paso: revoke).
  Quedan creados: base de datos chatbot_demo_02 (vacía) y usuario chatbot_demo_02.
  No se ha borrado nada. Para terminar a mano:
    REVOKE CONNECT, TEMPORARY ON DATABASE "chatbot_demo_02" FROM PUBLIC;
  o para retirarlo: DROP DATABASE "chatbot_demo_02"; DROP ROLE "chatbot_demo_02";
  DATABASE_URL ha vuelto a quedar vacía y el inventario no se ha modificado.
```

Si la restauración de `DATABASE_URL` también falla, el informe lo dice y pide vaciarla a mano.

`inventory_not_updated` (1): la base de datos se creó y `DATABASE_URL` está escrita, pero falló la
escritura del inventario:

```text
Base de datos creada y DATABASE_URL escrita en <fichero>, pero el inventario no se ha actualizado.
Ejecuta: pnpm instance:sync demo-02 <fichero>
```

---

## `pnpm instance:list [--json]` (US4)

```text
Inventario C:\Users\op\.chatbotasesor\inventory.json — 3 instancias

  ID        CLIENTE               ESTADO      IMAGEN  ÚLTIMA VERIFICACIÓN
  demo-01   Cliente de ejemplo    activa      0.1.0   2026-09-30 restaurable
! demo-02   Otro cliente          activa      0.1.0   2026-08-12 restaurable (49 días)
  demo-03   Cliente antiguo       de baja     0.1.0   —                         (baja 2026-09-01, datos borrados 2026-09-20)

! 1 instancia activa sin verificación correcta en los últimos 31 días.
```

Con `--json`: `{ "inventory": "<ruta>", "instances": [ … ] }`, cada instancia con los campos del
inventario **sin** `fingerprints` y con `verificationOverdue: boolean`. `list` no exige la clave
(no compara ni escribe) pero, si se da, la comprueba.

---

## `pnpm instance:register <entorno> --client <nombre> [--status active|testing] [--create-inventory]` (US4)

Registra una instancia existente. Lee `INSTANCE_ID`, `PUBLIC_BASE_URL`, `BACKUP_DIR`, la identidad
de `DATABASE_URL` y las huellas. Rechaza (1) `duplicate_instance_id` o un entorno sin
`INSTANCE_ID` válido. Las coincidencias con otras instancias se muestran como avisos
(`duplicate_*`) y la instancia se registra igualmente (0), con el recordatorio de corregirlas y
hacer `instance:sync`.

## `pnpm instance:sync <id> <entorno>` (FR-032)

Tras rotar secretos o cambiar la BD, la URL o el directorio: las huellas que cambian pasan a
anteriores y se añaden las nuevas. Actualiza también `database`, `publicUrl` y `backupDir` desde el
entorno (completa `database` tras un `inventory_not_updated` de `instance:db`). Rechaza (1) si el
`INSTANCE_ID` del entorno no es `<id>`.
Informa de qué variables han cambiado (por nombre) y avisa si un valor nuevo coincide con otra
instancia.

## `pnpm instance:update <id> [opciones]` (US4)

`--client <texto>`, `--image <versión>`, `--llm-workspace <texto>`, `--backup-key-location <texto>`,
`--status active|testing`, `--data-deleted <YYYY-MM-DD>` (solo en `retired`). Rechaza (1)
transiciones no permitidas (`invalid_transition`) y textos que parezcan secretos o URL con
credenciales (`looks_like_secret`).

## `pnpm instance:verified <id> <fichero.json | ->` (US4)

Anota el resultado de `db:verify --json`. Rechaza (1) `invalid_report` (no es un informe de
`db:verify`) y `other_instance` ("la copia `<fichero>` es de la instancia `<otra>`"). Correcto (0):
"Verificación anotada: `<fichero>` · restaurable" (o el código de fallo).

## `pnpm instance:retire <id>` (FR-028a)

Pide confirmar escribiendo el `<id>` (o `--yes` sin terminal). Pasa a `retired` con la fecha de
hoy y muestra:

```text
Instancia demo-03 dada de baja en el inventario. Sus identificadores y secretos siguen contando
como usados. Esta herramienta no borra nada. Pasos manuales:
  1. Desactiva el chat web y retira el webhook de WhatsApp en Meta.
  2. Entrega al cliente los datos que correspondan según el contrato.
  3. Para el contenedor, revoca su clave del modelo de lenguaje y elimina sus secretos.
  4. En el plazo acordado, borra la base de datos, el volumen de copias y sus réplicas, y anótalo:
       pnpm instance:update demo-03 --data-deleted <YYYY-MM-DD>
```
