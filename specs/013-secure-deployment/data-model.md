# Data Model: Requisitos de despliegue seguro

**Feature**: 013-secure-deployment · **Fecha**: 2026-10-06

**Sin cambios en la base de datos de la instancia**: no hay migración, no cambia el esquema y no
sube `formatVersion` (no es configuración del negocio). Las entidades de esta feature viven en
memoria, en ficheros de configuración del repositorio o en el servidor de verificación de copias.

---

## 1. Clasificación de una URL de base de datos

Resultado puro de `classifyDatabaseUrl(url)` (`src/config/database-url.ts`, research R1). No se
guarda ni se muestra nunca.

| Campo | Tipo | Regla |
|---|---|---|
| `kind` | `'ok' \| 'invalid'` | `invalid` si no es `postgres:`/`postgresql:` o no tiene host ni socket |
| `local` | boolean | `localhost`, `127.0.0.0/8`, `::1` (cualquier forma), socket local |
| `verifiedTls` | boolean | un único `sslmode` y vale exactamente `verify-full` |
| `caFile` | string \| null | valor de `sslrootcert`; solo para comprobar que se puede leer |

Derivado: **requiere TLS verificado** ⇔ `kind = 'ok'` ∧ ¬`local` ∧ ¬`verifiedTls`.

---

## 2. Regla de despliegue (hallazgo de `instance:check`)

Reutiliza `Finding` de `src/provisioning/check.ts`, sin cambios de forma: `code`, `variable`,
`message`, `action` y `detail`. Las reglas nuevas o modificadas y su severidad por perfil están
en [contracts/check-rules.md](contracts/check-rules.md).

| Código | Estado |
|---|---|
| `trust_proxy_empty` | modificado: error en producción, advertencia en pruebas; mensaje y acción nuevos |
| `database_tls_required` | nuevo |
| `database_url_invalid` | nuevo |
| `admin_url_tls_required` | nuevo, error de la orden `instance:db` (catálogo de órdenes) |

`CheckCode` es la unión cerrada de las claves de `CHECK_CATALOG`. Añadir un código obliga a
escribir su mensaje y su acción, porque el compilador lo exige.

---

## 3. Base temporal de verificación

Base de datos del servidor de `BACKUP_VERIFY_URL` (research R5).

| Atributo | Valor |
|---|---|
| Nombre | `verify_<yyyymmddhhmmss>_<16 hex>`. La marca es el instante de creación en UTC; el sufijo, 8 bytes aleatorios |
| Patrón exacto | `^verify_(\d{14})_([0-9a-f]{16})$` con fecha y hora válidas |
| Formato anterior | `^verify_[0-9a-f]{16}$` (núcleo anterior a la 013) |
| Dueño | el usuario de `BACKUP_VERIFY_URL` |
| Permisos | `CONNECT` y `TEMPORARY` revocados a `PUBLIC` antes de cargar ningún dato |

**Ciclo de vida**:

```text
(no existe) --CREATE + REVOKE--> creada --conexión de carga--> en uso
en uso --fin normal (finally)--> DROP … WITH (FORCE) --> (no existe)
en uso --proceso interrumpido--> huérfana
huérfana --db:verify posterior: patrón exacto ∧ sin conexiones ∧ (marca < ahora − 6 h ∨ formato anterior)--> DROP (sin FORCE) --> (no existe)
huérfana --DROP rechazado por conexión (55006)--> se respeta, sin contarla
huérfana --DROP rechazado por permisos u otro error--> sigue; cuenta en `failed`
```

Constante: `VERIFY_MAX_AGE_HOURS = 6`.

---

## 4. Informe de verificación (`VerifyReport`)

Se añade un campo; los demás no cambian (006, contracts/backup-commands.md).

| Campo | Tipo | Significado |
|---|---|---|
| `orphans.listed` | boolean | `false` si no se pudo listar el servidor; la verificación sigue |
| `orphans.removed` | integer ≥ 0 | huérfanas borradas en esta ejecución |
| `orphans.failed` | integer ≥ 0 | huérfanas que no se pudieron borrar (permisos u otro error) |

Ningún nombre de base ni dato del negocio. El evento `verify_completed` del registro de copias
lleva los mismos tres campos.

`BackupFailureCode` y `RestoreFailureCode` ganan `db_ca_unreadable`, `db_tls_untrusted` y
`db_tls_unsupported` (research R4; asignación en contracts/database-tls.md).

---

## 5. Error de configuración de la base de datos

`DatabaseConfigError` (`src/config/database-url.ts`). Lo lanzan el arranque, `db:migrate` y las
órdenes de copias antes de conectar.

| Campo | Valores |
|---|---|
| `reason` | `ca_unreadable` · `tls_untrusted` · `tls_unsupported` · `unreachable` |
| `variable` | `DATABASE_URL` · `BACKUP_VERIFY_URL` |
| `message` | texto fijo en español que nombra la variable; sin URL, host, usuario, ruta ni texto del error original |

---

## 6. Configuración del repositorio y de la imagen

| Fichero | Contenido nuevo | Comprobación |
|---|---|---|
| `Dockerfile` | `ARG NODE_IMAGE=node:22-slim@sha256:<64 hex>` usado por los dos `FROM`; copia de `.npmrc`; `HEALTHCHECK` (R6) | prueba estática |
| `package.json` | `packageManager` con `+sha512.<128 hex>`; `pnpm.onlyBuiltDependencies = ["argon2", "esbuild"]` | prueba estática |
| `.npmrc` | `save-exact=true` | prueba estática |
| `.gitignore` | `*.pem`, `*.key`, `*.p12` | `git check-ignore` en prueba unitaria; ningún fichero rastreado coincide |
| `src/cli/healthcheck.ts` | sonda de salud de la imagen | prueba unitaria con servidor HTTP de prueba |
