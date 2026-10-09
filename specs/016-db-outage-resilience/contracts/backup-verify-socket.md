# Contrato: comprobación de copias con direcciones por socket local

**Feature**: 016-db-outage-resilience · Cubre FR-006, FR-007, FR-008, FR-011 y FR-012.

---

## 1 · `withDatabaseName`: la misma dirección, otra base

`src/config/database-url.ts`. Función pura; es el **único** sitio del núcleo que reconstruye una
dirección de base de datos.

```text
withDatabaseName(url: string, database: string): string | null
```

| Entrada | `database` | Salida |
|---|---|---|
| `postgres://u:c@servidor:5432/base` | `verify_x` | `postgres://u:c@servidor:5432/verify_x` |
| `postgres://u:c@servidor/base?sslmode=verify-full&sslrootcert=/ca.crt` | `verify_x` | la misma con `/verify_x` y **los dos parámetros intactos** |
| `postgres://u:c@/base?host=/var/run/postgresql` | `verify_x` | `postgres://u:c@/verify_x?host=/var/run/postgresql` |
| `postgresql://u:c@/base?host=/tmp&sslmode=disable` | `verify_x` | la misma con `/verify_x` y los dos parámetros |
| `postgres://u:c@/base?host=/var/run/postgresql` | *(la misma base)* | idéntica a la entrada |
| `mysql://u@servidor/base` | cualquiera | `null` |
| `no-es-una-url` | cualquiera | `null` |

**Garantías.**

- Conserva usuario, contraseña codificada, servidor (o su ausencia), puerto y **todos** los
  parámetros de consulta, en su orden.
- Nunca lanza: los casos imposibles devuelven `null`.
- No se muestra en ningún mensaje ni registro (FR-012).

**Prueba de FR-011**: tabla unitaria con las tres formas de dirección, **sin base de datos real**.
Es la prueba que cae si se revierte la corrección (SC-006, SC-007).

---

## 2 · `pnpm db:verify` con una base alcanzada por socket

| Caso | Resultado |
|---|---|
| Copia válida, base y servidor de verificación por socket local | **RESTAURABLE**, con los recuentos por tabla, y la base temporal borrada |
| Copia válida, base por nombre de servidor | **RESTAURABLE**: exactamente igual que antes (US2-3) |
| Copia dañada o incompleta | **NO RESTAURABLE**: `corrupted` |
| Copia hecha con otra clave | **NO RESTAURABLE**: `wrong_key`, con el id de clave |
| `BACKUP_VERIFY_URL` ininterpretable | **NO RESTAURABLE**: `verify_url_invalid` |
| No se puede conectar con el servidor de verificación | **NO RESTAURABLE**: `verify_db_unavailable` |
| Se conecta pero no se puede crear la base temporal | **NO RESTAURABLE**: `verify_db_create_failed` |
| Fallo de TLS o de la autoridad | **NO RESTAURABLE**: `db_ca_unreadable`, `db_tls_untrusted` o `db_tls_unsupported` (013, sin cambios) |

La base temporal se borra siempre, también en los fallos, y la limpieza de huérfanas al principio
de la comprobación sigue igual que en la 013.

---

## 3 · Motivos y textos (FR-008)

| Código | Motivo corto | Mensaje de la orden |
|---|---|---|
| `verify_url_invalid` | `BACKUP_VERIFY_URL no se puede interpretar` | `BACKUP_VERIFY_URL no se puede interpretar. Revisa su formato en el fichero de entorno.` |
| `verify_db_unavailable` | `no se pudo conectar con el servidor de verificación` | `No se pudo conectar con el servidor de verificación. Comprueba que está en marcha y accesible desde la instancia.` |
| `verify_db_create_failed` | `no se pudo crear la base de datos temporal` | `No se pudo crear la base de datos temporal: BACKUP_VERIFY_URL necesita un usuario con CREATEDB.` |

**Regla de no mentir.** Un fallo ocurrido en una capa nunca se atribuye a otra: la dirección, la
conexión y la creación son tres motivos distintos, y ninguno de los tres se usa para un problema
**de la copia**. Ningún mensaje lleva la dirección, el host, el usuario ni la ruta del socket
(FR-012).

---

## 4 · Puntos que interpretan una dirección de base de datos (FR-007)

Después de esta corrección, **todos** admiten la forma por socket local:

| Punto | Qué hace con un socket |
|---|---|
| `withDatabaseName` | lo conserva (§1) |
| `classifyDatabaseUrl`, `isLocalHost` | ya lo admitían: un socket es local (013) |
| `urlPassword` (`src/config/secret-rules.ts`) | devuelve la contraseña, así que **la regla de calidad sí se aplica** en producción |
| `databaseIdentity`, `databasePassword` (`src/provisioning/fingerprint.ts`) | devuelven identidad y contraseña; con socket, `host` es la ruta del socket y `port`, 5432 |
| `instance:check`, regla del usuario `postgres` | **se aplica** también con socket, porque ya tiene identidad |
| `parseAdminUrl` (`src/provisioning/database.ts`) | sigue rechazándolo **a propósito**: `instance:db` necesita un servidor para construir la `DATABASE_URL` de la instancia |

**Criterio verificable.** Una búsqueda de `new URL(` sobre direcciones de base de datos en `src/`
no devuelve ninguna que no pase por el intérprete tolerante de `src/config/database-url.ts`,
salvo `parseAdminUrl`, que documenta por qué exige servidor.

**Cobertura de pruebas (SC-007).** Cada una de esas funciones tiene un caso con dirección por
socket en sus pruebas unitarias, además del caso con nombre de servidor que ya tenía.
