# Implementation Plan: Aprovisionamiento de instancias

**Branch**: `007-instance-provisioning` | **Date**: 2026-09-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/007-instance-provisioning/spec.md`

**Ámbito**: Núcleo (herramientas de operación)

## Summary

El operador da de alta instancias con unas órdenes `pnpm instance:*` iguales para todas:
`instance:new` genera el entorno completo de producción desde `.env.example` con secretos nuevos
(sesión, clave de copias, contraseña del operador mostrada una vez y su hash Argon2id, token del
webhook) y deja señalados los valores de terceros; `instance:db` crea una base de datos vacía y un
usuario propio (o imprime el SQL exacto); `instance:check` valida un entorno antes de desplegar y
lo compara con el resto de instancias; y un inventario local, fuera del repositorio, guarda los
datos descriptivos y **huellas** de los secretos, nunca los secretos.

Enfoque técnico: módulo nuevo `src/provisioning` sin HTTP y un punto de entrada
`src/cli/instance.ts` con subórdenes. La validación **reutiliza el esquema de arranque** de
`src/config/env.ts` (se exporta `checkEnv`, que devuelve cada incidencia con su variable, sin
cambiar `loadEnv`) y añade las reglas de alta: modo producción, `https`, calidad de cada secreto,
repeticiones dentro del entorno y con el inventario. Las huellas son HMAC-SHA256 truncado a 128
bits con una clave propia del inventario (`INSTANCE_INVENTORY_KEY`), con una clase común para
todos los secretos (detecta un secreto reutilizado en otra variable). El inventario es JSON
validado con Zod, escrito con bloqueo exclusivo y `rename` atómico. La base de datos se crea con
`pg`: comprobación previa de nombres, `CREATE ROLE` con verificador SCRAM-SHA-256 calculado en el
cliente (la contraseña no viaja en claro), `CREATE DATABASE … OWNER`, `REVOKE CONNECT … FROM
PUBLIC` y prueba de conexión; ante un fallo se retira solo el usuario recién creado y nunca se
borra una base de datos. Sin dependencias nuevas ni migraciones. Detalle en [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.x (strict) sobre Node.js 22 LTS (heredado)

**Primary Dependencies**: las existentes — Zod (esquemas del inventario, del informe de
`db:verify` y de los datos mínimos), `libphonenumber-js` (teléfono de emergencia), `argon2` (hash
del operador), `pg` (creación de BD). `node:crypto` (aleatoriedad, HMAC, PBKDF2 para SCRAM),
`node:util` `parseEnv` (lectura de entornos, el mismo analizador que `process.loadEnvFile`),
`node:fs` y `git check-ignore` (ruta de salida). **Sin dependencias nuevas.**

**Storage**: sin cambios en la BD de las instancias. Inventario JSON y ficheros de entorno en el
equipo del operador, fuera del repositorio ([data-model.md](data-model.md)).

**Testing**: Vitest — `unit` (reglas de calidad de secretos; huellas; `checkEnv` con variable en
cada incidencia; tabla con **cada** incoherencia de FR-003 y **cada** repetición de FR-005/006
(SC-002); perfil `testing`; exclusión de la propia instancia y cómputo de las dadas de baja;
plantilla completa con pendientes; esquema e invariantes del inventario; 100 entornos sin secretos
repetidos (SC-004); verificador SCRAM con vector conocido), `integration` (Testcontainers: dos BD
creadas y aislamiento entre sus usuarios y frente a un usuario sin privilegios (SC-006); segundo
intento rechazado; fallos inyectados entre pasos; SQL del modo instrucciones equivalente; CLI de
extremo a extremo `new → db → check` apto a la primera (SC-003); registro, verificaciones, baja y
sincronización; bloqueo concurrente; inventario corrupto intacto; ruta en un repositorio git
temporal; ningún secreto en salidas ni inventario (SC-005)). Sin `contract` (no hay HTTP) ni
`eval` (no cambia la conversación).

**Target Platform**: equipo del operador (Windows, macOS o Linux) con Node 22, el repositorio del
núcleo y acceso de red al servidor PostgreSQL de destino (o modo "solo instrucciones"). Las
instancias siguen en el contenedor `node:22-slim` sin cambios.

**Project Type**: servicio web (monolito modular) con un módulo de operación nuevo
`src/provisioning` y una CLI `src/cli/instance.ts`; cambio mínimo en `src/config/env.ts`

**Performance Goals**: SC-001 — alta hasta entorno validado y BD creada en < 15 min de trabajo del
operador; cada orden termina en segundos (el hash Argon2id y la creación de la BD dominan, < 5 s)

**Constraints**: ningún secreto en claro en inventario, salidas ni registros (FR-007, FR-027,
SC-005); la contraseña del operador solo se muestra una vez y en terminal (FR-012); nunca
sobrescribir un entorno ni un inventario ilegible (FR-015, FR-031); nunca reutilizar, vaciar ni
borrar una base de datos (FR-019); credenciales de administración solo en memoria (FR-020); la
validación no escribe (FR-009); "apto" implica que el arranque del núcleo acepta el entorno;
nada de sectores ni clientes en `src/` (FR-033); no interviene en el arranque (FR-034)

**Scale/Scope**: decenas de instancias por operador; un inventario de decenas de KB; ~16 huellas
por instancia más las anteriores

Cifras que la spec delegaba al plan: huella de 128 bits HMAC-SHA256 y clave por
`INSTANCE_INVENTORY_KEY` (R4); espera del bloqueo 5 s y aviso de bloqueo huérfano a los 10 min
(R6); longitudes mínimas por tipo de secreto (R3); contraseña del operador de 24 caracteres
(≈ 139 bits) y de la BD de 32 (R7, R8). No quedan incógnitas técnicas.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Evaluación inicial (antes de Phase 0)

| Principio | Cumplimiento en esta feature | Estado |
|-----------|------------------------------|--------|
| **I. Base común única** | Spec de núcleo. Las herramientas son iguales para todas las instancias y no contienen sectores ni clientes (FR-033): los nombres de cliente solo existen en el inventario del operador, fuera del repositorio. El test de neutralidad recorre `src/provisioning` y `src/cli/instance.ts`. | ✅ |
| **II. Configuración antes que código** | Refuerza el principio: cada instancia se diferencia solo por su entorno y su BD. Las herramientas no añaden nada por instancia al código ni cambian cómo se configura un negocio. | ✅ |
| **III. Personalizaciones aisladas** | Sin extensiones ni puntos de extensión. | ✅ (N/A) |
| **IV. Solo información registrada** | No toca la cadena de respuesta ni el conocimiento. | ✅ (N/A) |
| **V. Siempre hay salida a una persona** | No toca la derivación. La validación exige `EMERGENCY_CONTACT_PHONE` con bot (regla del núcleo) y la generación lo pide siempre, así que ninguna instancia generada queda sin contacto. | ✅ |
| **VI. El operador registra la información** | Herramientas del operador en su equipo; ninguna pantalla ni acceso del negocio. | ✅ |
| Restricción: aislamiento | Es el objetivo de la feature: secretos nuevos por instancia, BD y usuario propios con `CONNECT` retirado a `PUBLIC`, y detección de identificadores, BD y secretos repetidos entre instancias, incluidas las dadas de baja. | ✅ |
| Flujo: pruebas de IV y V | No afecta a la conversación; los tests existentes siguen pasando. | ✅ (N/A) |

**Resultado**: sin violaciones. Se puede continuar con Phase 0.

### Re-evaluación tras el diseño (Phase 1)

Revisados [data-model.md](data-model.md) y [contracts/](contracts/):

- **I**: mensajes y códigos de [instance-commands.md](contracts/instance-commands.md) y
  [check-result.md](contracts/check-result.md) sin sectores ni clientes; los identificadores de
  ejemplo (`demo-01`) y "Cliente de ejemplo" son ilustrativos y solo aparecen en la documentación
  y en `tests/`. ✅
- **II**: la plantilla del entorno sigue siendo `.env.example`; una variable nueva del núcleo
  entra en los entornos generados sin tocar las herramientas, y una regla nueva de `env.ts` entra
  en la validación como `core_rule` (R2, R7). ✅
- **VI**: ninguna ruta HTTP nueva; `instance:retire` pide confirmar con el identificador. ✅
- **Aislamiento y privacidad**: huellas con clave (sin ella no se puede comprobar un valor
  candidato), inventario sin secretos con invariantes comprobadas al leer
  ([inventory-format.md](contracts/inventory-format.md)), contraseña de la BD enviada como
  verificador SCRAM, errores de `pg` traducidos a códigos, test de búsqueda de secretos en todas
  las salidas (SC-005). ✅

**Resultado**: sin violaciones. Complexity Tracking vacío.

**Consecuencias que conviene conocer** (no son violaciones):

- `src/config/env.ts` añade `path` a sus incidencias personalizadas y exporta `checkEnv`; el
  arranque y sus mensajes no cambian (test existente `tests/unit/env.test.ts` + uno nuevo).
- Las herramientas necesitan el repositorio del núcleo (usan `.env.example`); aunque se compilen
  en la imagen, no están pensadas para ejecutarse dentro del contenedor de una instancia.
- En Windows el modo `0600` no aplica: el entorno y el inventario heredan la ACL del directorio
  (por defecto el perfil del usuario). La guía lo indica.
- La clave del inventario es un secreto más del operador: perderla obliga a crear un inventario
  nuevo y registrar de nuevo las instancias desde sus entornos (caso límite de la spec).
- La instancia existente (la primera) se incorpora con `instance:register`; si alguno de sus
  secretos se generó a mano y no cumple las reglas de calidad, `instance:check` lo marcará y habrá
  que rotarlo y hacer `instance:sync`.
- `README.md` y la guía de operación multicliente (§2, §7 y §9) se actualizan al cerrar la feature
  (FR-035); se avisará al usuario antes de cambiar el README, como indica `CLAUDE.md`.

## Project Structure

### Documentation (this feature)

```text
specs/007-instance-provisioning/
├── plan.md              # Este fichero
├── research.md          # Phase 0: decisiones técnicas (R1–R11)
├── data-model.md        # Phase 1: entorno, datos mínimos, inventario, huellas, resultado
├── quickstart.md        # Phase 1: guía de validación de extremo a extremo
├── contracts/
│   ├── instance-commands.md   # pnpm instance:check|new|db|list|register|sync|update|verified|retire
│   ├── check-result.md        # Resultado de la validación y catálogo de códigos
│   └── inventory-format.md    # Formato del inventario v1 y huellas
├── checklists/
└── tasks.md             # Phase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
src/
├── config/env.ts                  # + checkEnv(source): EnvIssue[] (variable + mensaje); path en
│                                  #   las incidencias personalizadas. loadEnv sin cambios.
├── provisioning/                  # NUEVO módulo de operación (sin HTTP)
│   ├── env-file.ts                # parseEnvFile (util.parseEnv), renderTemplate (línea a línea,
│   │                              #   pendientes), setVariable (reescritura atómica de una línea)
│   ├── secrets.ts                 # generación (sesión, copias, token, contraseña) y secretQuality
│   ├── fingerprint.ts             # huella(clase, valor), keyCheck, normalización, huellas de un entorno
│   ├── inventory.ts               # esquema Zod, invariantes, ruta, lectura, bloqueo, escritura atómica
│   ├── check.ts                   # validate(env, inventory|null, key) → CheckResult (reglas de alta + comparación)
│   ├── generate.ts                # datos mínimos → entorno + alta en el inventario
│   ├── database.ts                # nombres, verificador SCRAM, plan SQL, createDatabase (pasos y deshacer)
│   ├── repo-paths.ts              # raíz del núcleo, ruta dentro del repositorio, git check-ignore
│   └── messages.ts                # catálogo de códigos → mensaje y acción (en español)
└── cli/
    └── instance.ts                # NUEVO: subórdenes check, new, db, list, register, sync, update,
                                   #   verified, retire (reutiliza CliIO/parseArgs de backup-common)

tests/
├── unit/provisioning/             # secrets, fingerprint, check (tabla SC-002), env-file, inventory,
│                                  #   generate (SC-004), database (SCRAM y plan SQL)
├── unit/env.test.ts               # + checkEnv: cada incidencia con su variable
├── integration/provisioning/      # database (SC-006, rechazos, fallos inyectados, --print-sql),
│                                  #   cli (new→db→check, register/verified/list/retire/sync),
│                                  #   inventory-lock, repo-path (git temporal), privacy (SC-005)
├── unit/sector-neutrality.test.ts # el recorrido incluye src/provisioning y src/cli/instance.ts
└── helpers/provisioning.ts        # inventario y directorio temporales, clave de test, IO capturado,
                                   #   hasher Argon2id rápido inyectable

package.json                       # scripts instance:check|new|db|list|register|sync|update|verified|retire
docs/operacion-multicliente.md     # §2 alta con las herramientas, §7 baja con instance:retire, §9 P1 hecha
README.md                          # estado de la 007 y órdenes (se avisa antes de cambiarlo)
```

**Structure Decision**: proyecto único, como las features anteriores. `src/provisioning` es un
módulo de operación hermano de `src/backup`: no conoce Fastify ni el dominio; habla con el disco
por `node:fs`, con PostgreSQL por `pg` (solo `database.ts`) y con `git` solo para
`check-ignore`. Las funciones de reglas (`check`, `secretQuality`, huellas, plantilla) son puras y
reciben el inventario ya leído, para probarlas sin disco. `src/cli/instance.ts` compone lectura de
entorno y clave, bloqueo, operación y salida, con `CliIO` inyectable como los comandos de la 006.

## Complexity Tracking

Sin violaciones de la constitución que justificar.
