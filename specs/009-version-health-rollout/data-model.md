# Data Model: Versión visible y actualización escalonada

La feature **no añade tablas ni migraciones** y **no cambia el formato del inventario ni del fichero
de configuración (008)**. Las entidades son valores calculados en cada consulta (como los avisos:
nunca se guardan).

## 1. Versión del núcleo

| Campo | Tipo | Regla |
|---|---|---|
| `coreVersion` | texto | Versión semántica `MAYOR.MENOR.PARCHE[-prerelease]` (`/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/`), leída una vez de `package.json` al arrancar |

- Única fuente: `package.json`. El `Dockerfile` impide construir una imagen con una etiqueta distinta
  (R4). Si no se puede leer o no es semántica, la instancia no arranca.

## 2. Versión del esquema

Derivada de `drizzle.__drizzle_migrations` y del journal del núcleo
([`src/backup/schema-version.ts`](../../src/backup/schema-version.ts)):

| Campo | Tipo | Significado |
|---|---|---|
| `expected` | `{ index: number, tag: string }` | Última migración del núcleo instalado (`installedSchema()`) |
| `applied` | `{ index: number, tag: string \| null } \| null` | Última migración realmente aplicada; `tag = null` si el núcleo no la conoce (esquema más nuevo); `null` si la BD está vacía o no responde |
| `matches` | booleano | `applied` existe y coincide con `expected` en índice, etiqueta **y hash** |

`applied.index` sale del conteo de filas de la tabla de migraciones cuando el núcleo no reconoce la
última (R3). El hash no se expone: solo se usa para comparar.

## 3. Informe de salud

Resultado de `buildHealthReport(deps)`; lo que se ve depende del nivel de acceso.

| Campo | Nivel sin credencial | Nivel con secreto | Notas |
|---|---|---|---|
| `status` | ✔ | ✔ | `ok` \| `degraded` \| `not_ready` |
| `instanceId` | — | ✔ | `INSTANCE_ID` de la instancia, o `null` si no está configurado |
| `coreVersion` | — | ✔ | §1 |
| `schema.applied` | — | ✔ | §2: `{ index, tag }` o `null` |
| `schema.expected` | — | ✔ | §2: `{ index, tag }` |

Ningún otro campo: ni conversaciones, teléfonos, nombres, configuración, secretos, variables de
entorno, rutas, direcciones de BD ni causas de error (FR-002, SC-003). La forma exacta está en
[contracts/health-endpoint.md](contracts/health-endpoint.md).

### Estado: reglas y transiciones

```text
starting ──(arranque completo)──▶ ready ──(stop())──▶ stopping
   │                                │                     │
   └──────────── not_ready ─────────┘ (solo mientras ≠ ready)

ready: BD responde (≤ 2 s) ∧ esquema aplicado = esperado ⇒ ok
ready: BD no responde ∨ esquema ≠ esperado               ⇒ degraded
```

El ciclo de vida lo fija `startInstance` (`ready` tras listen + bot + tareas) y `stop()`
(`stopping`) en un objeto `lifecycle` decorado en la app (`src/health/lifecycle.ts`). No hay estado
persistente.

## 4. Secreto de salud

| Aspecto | Valor |
|---|---|
| Variable | `HEALTH_SECRET` (opcional en el arranque) |
| Formato | 64 caracteres hexadecimales (32 bytes aleatorios), más de 8 símbolos distintos |
| Reglas de entorno | Distinta de `SESSION_SECRET` y de `BACKUP_KEY` |
| Reglas de alta (`instance:check`) | Obligatoria; no repetida en otra instancia (huella) |
| Transporte | `Authorization: Bearer <secreto>` |
| Inventario | Solo su **huella** (`class: "secret"`, `variable: "HEALTH_SECRET"`) en `fingerprints`, igual que el resto de secretos; nunca el valor |

El formato del inventario (007, `version: 1`) **no cambia**: `variable` ya es texto libre de hasta 64
caracteres y `class: "secret"` ya existe. Un inventario antiguo sigue siendo válido; la huella de
`HEALTH_SECRET` aparece tras `instance:sync`.

## 5. Registro del inventario (007, sin cambios)

Campos que usa la orden: `id`, `client`, `status`, `publicUrl`, `imageVersion` (la versión **anotada**)
y `fingerprints`. Con `--annotate` solo se escribe `imageVersion` (R6).

## 6. Informe de versiones (salida de `instance:versions`)

Una fila por instancia no retirada. Forma completa en
[contracts/instance-versions-command.md](contracts/instance-versions-command.md).

| Campo | Tipo | Significado |
|---|---|---|
| `id` · `client` | texto | Del inventario |
| `result` | enum | `ok`, `degraded`, `not_ready`, `unreachable`, `invalid_response`, `no_health`, `auth_failed`, `rate_limited`, `status_only`, `identity_mismatch`, `not_queried` |
| `reason` | enum \| null | Solo en `not_queried`: `no_url`, `not_https`; solo en `status_only`: `no_secret`, `instance_without_secret` |
| `status` | `ok` \| `degraded` \| `not_ready` \| null | Estado informado por la instancia |
| `coreVersion` | texto \| null | Observada; `null` si no se atribuye a la instancia |
| `schema` | `{ applied: string \| null, expected: string } \| null` | Observada |
| `annotated` | texto \| null | `imageVersion` del inventario |
| `matches` | `true` \| `false` \| `null` | Versión observada = anotada; `null` si no hay observada o no hay anotada |
| `review` | booleano | `true` si la fila exige revisión (todo salvo `ok` coincidente) |

Reglas de atribución (FR-014): `coreVersion` y `schema` solo se rellenan cuando `instanceId` de la
respuesta es igual al `id` del inventario. En `identity_mismatch` no se muestra el identificador
recibido (podría ser de otro cliente): solo el resultado.

Transiciones: ninguna; el informe se calcula en cada ejecución y no se guarda.

## 7. Tanda de actualización

Concepto de procedimiento, sin representación en el sistema: un grupo reducido de instancias que se
actualiza y se comprueba con `instance:versions` antes de pasar al siguiente
([contracts/release-procedure.md](contracts/release-procedure.md)).
