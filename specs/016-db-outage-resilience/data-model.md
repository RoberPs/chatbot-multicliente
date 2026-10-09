# Data Model: Resistencia a los cortes de la base de datos

**Feature**: 016-db-outage-resilience · **Fecha**: 2026-10-09

**No hay cambios de base de datos.** Ninguna tabla, columna, índice ni migración. Por tanto
`formatVersion` de `src/config-transfer/format.ts` **no sube** y no hay actualizador nuevo
(assumption de la spec, R10).

Las entidades de esta corrección viven **en memoria del proceso** o son **tipos** que cruzan
módulos. Se describen aquí con sus campos, invariantes y transiciones.

---

## 1 · Estado del corte (`OutageState`) — en memoria, nunca persistido

`src/db/outage.ts`. Uno por proceso; las pruebas crean el suyo.

| Campo | Tipo | Significado |
|---|---|---|
| `state` | `'up' \| 'down'` | Si la base de datos está dando servicio |
| `since` | `Date \| null` | Instante del inicio del corte; `null` con `up` |
| `failures` | `number` | Fallos agrupados desde `since`; se reinicia al recuperar |
| `lastSummaryAt` | `Date \| null` | Último resumen emitido, para espaciarlos 5 min |
| `notified` | `Set<string>` | `channelUserId` que ya recibieron el aviso degradado (R5) |

**Transiciones.**

```text
up   --note(error) con isDbUnavailable(error)-->  down
       · registra db_outage_started (una vez)
       · arranca el sondeo cada 10 s

down --note(error)-->                             down   (solo failures += 1)
down --resumen cada 5 min-->                      down   (db_outage_ongoing)
down --sondeo "select 1" con éxito-->             up
       · registra db_outage_recovered { durationMs, failures }
       · para el sondeo y vacía notified
```

**Invariantes.**

- `state = 'up'` ⇒ `since === null`, `failures === 0`, `notified` vacío.
- De `down` solo se sale por un sondeo correcto: ni por tiempo ni por intervención.
- El número de anotaciones de un corte es `2 + floor(duración / 5 min)`, independiente del número
  de peticiones (FR-014, SC-008).
- `note()` con un error que **no** es de disponibilidad no cambia nada: no se inventan cortes.

**Eventos del registro** (catálogo cerrado, sin texto libre; FR-012):

| Evento | Campos | Cuándo |
|---|---|---|
| `db_outage_started` | — | una vez al detectar el corte |
| `db_outage_ongoing` | `elapsedMs`, `failures` | cada 5 min de corte |
| `db_outage_recovered` | `durationMs`, `failures` | una vez al volver la base |
| `db_degraded_reply_sent` | `channel`, `customer` (seudónimo) | aviso degradado enviado (R5) |
| `db_degraded_reply_skipped` | `channel`, `reason` (`no_contact` \| `no_sender` \| `already_notified`) | no había nada que enviar |

---

## 2 · Clasificación de un error de base de datos

`src/db/client.ts` (junto a `isPoolBusy`). Función pura, sin estado.

```text
isDbUnavailable(error: unknown): boolean
```

Recorre `error.cause` hasta 5 niveles y devuelve `true` si algún nivel tiene uno de los códigos
de R2 (red de Node, SQLSTATE clase 08, `57P01`/`57P02`/`57P03`) o si `isPoolBusy(error)`.
**Nunca** compara textos nuevos. No distingue causas: para esta corrección, «no contesta» es un
único estado.

---

## 3 · Estado de salud (`HealthStatus`) — tipo existente, valor nuevo

`src/health/report.ts`.

| Valor | HTTP | Significado | Lo interpreta como |
|---|---|---|---|
| `ok` | 200 | todo correcto | sana |
| `db_unavailable` | **200** | **nuevo**: la base de datos no contesta; el proceso vive y sirve | **sana** (no reiniciable, FR-003) |
| `degraded` | 503 | la base contesta pero su esquema está vacío, es desconocido o no es el esperado | enferma: necesita al operador |
| `not_ready` | 503 | arrancando o cerrando | aún/ya no |

**Orden de evaluación** (sustituye al de la 009):

1. ciclo de vida distinto de `ready` → `not_ready`;
2. el sondeo falla o se pasa de plazo → `db_unavailable`;
3. el sondeo responde `empty` o `unknown`, o el esquema no coincide → `degraded`;
4. en otro caso → `ok`.

**Campos del informe durante el corte**: `schema.applied = null`, `spendCap = null`,
`coreVersion` y `schema.expected` con sus valores de siempre (se leen del núcleo, no de la BD).

**Consumidores que cambian con el valor nuevo**: `publicView`, `fullView`,
`src/channels/health/routes.ts` (código 200), `src/cli/healthcheck.ts` (sale con 0) y
`src/provisioning/versions.ts` (`statusSchema`, `codeMatches`, etiquetas de `instance:versions`).

---

## 4 · Dirección de base de datos — dos formas, un solo intérprete

`src/config/database-url.ts`. Sin tipos nuevos: se añade una función.

| Forma | Ejemplo | Quién la usa |
|---|---|---|
| Por nombre de servidor | `postgres://u:c@servidor:5432/base?sslmode=verify-full` | desarrollo, pruebas, instancias remotas |
| **Por socket local** | `postgres://u:c@/base?host=/var/run/postgresql` | **el despliegue de producción** |

```text
withDatabaseName(url: string, database: string): string | null
```

**Invariantes.**

- Conserva usuario, contraseña, servidor (o su ausencia), puerto y **todos** los parámetros de
  consulta, incluidos `host`, `sslmode` y `sslrootcert`.
- Cambia solo el nombre de la base.
- `withDatabaseName(u, nombreDeSuBase)` ≡ `u` para las dos formas (idempotencia).
- Devuelve `null` —nunca lanza— si la dirección no se puede interpretar o el protocolo no es
  `postgres:`/`postgresql:`.
- No aparece en ningún mensaje: es un valor de entrada a `pg`, nunca de salida (FR-012).

---

## 5 · Motivos de la comprobación de copias (`RestoreFailureCode`)

`src/backup/errors.ts`. Se sustituye un código por tres, para que el motivo no mienta (FR-008).

| Código | Capa que falla | Sustituye a |
|---|---|---|
| `verify_url_invalid` | la dirección de verificación no se puede interpretar | *(nuevo)* |
| `verify_db_unavailable` | la conexión con el servidor de verificación | mismo nombre, significado estrecho |
| `verify_db_create_failed` | `create database` o `revoke` en el servidor | parte del antiguo `verify_db_unavailable` |

Los motivos **de la copia** (`not_a_backup`, `corrupted`, `wrong_key`, `schema_*`,
`count_mismatch`) no cambian y no pueden confundirse con los tres de arriba: es el criterio
comprobable de FR-008 y del escenario US2-2.

`VerifyReport` no cambia de forma: `restorable`, `failure`, `tables`, `orphans`, `durationMs`.

---

## 6 · Vista del chat web (`frame`) — un campo más

`src/channels/web/views/frame.eta` y `src/channels/web/assets/frame.js`.

| Campo de la vista | Tipo | Origen | Para qué |
|---|---|---|---|
| `contact` | `string \| null` | `lastContact.value` de `src/channels/web/routes.ts` | lo que enseña la interfaz cuando el servidor no contesta (FR-013) |

**Reglas.**

- Es el contacto del negocio si al servir la página se pudo leer el snapshot; el teléfono de
  emergencia de la instancia si no; `null` si la instancia no tiene ninguno.
- Viaja como atributo de datos en `<html>`, escapado por Eta.
- `frame.js` lo copia a `state.contact` **antes** de cualquier petición; `GET /state` puede
  refinarlo después, pero no es condición para mostrarlo.
- No lleva nada más de la instancia: ni base, ni servidor, ni credenciales (FR-012).
