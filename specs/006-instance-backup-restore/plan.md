# Implementation Plan: Copias de seguridad y restauración por instancia

**Branch**: `006-instance-backup-restore` | **Date**: 2026-09-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/006-instance-backup-restore/spec.md`

**Ámbito**: Núcleo

## Summary

El operador puede copiar, restaurar y comprobar la base de datos de cualquier instancia con los
mismos comandos (`pnpm db:backup`, `db:restore`, `db:verify`, `db:backups`), la instancia hace una
copia diaria a una hora local configurable y, al arrancar con migraciones pendientes y datos, hace
una copia previa o no arranca. Las copias caducan (7 días por defecto, 1–30) conservando siempre la
última válida.

Enfoque técnico: módulo nuevo `src/backup` sin HTTP. La copia es un **volcado lógico de datos**
hecho en Node dentro de una transacción `REPEATABLE READ` (`COPY TO STDOUT` con
`pg-copy-streams`), sin DDL: al restaurar, el esquema se reconstruye con las migraciones del propio
núcleo hasta la versión de la copia y se cargan los datos, todo en **una transacción**. Así no hace
falta `pg_dump` en la imagen, en Windows ni en Testcontainers. El fichero `CBAK` v1 lleva una
cabecera en claro (instancia, esquema, núcleo, fecha, motivo, recuentos) autenticada por bloques de
64 KiB cifrados con AES-256-GCM y clave derivada por HKDF de `BACKUP_KEY`. Se escribe como
`.partial` y se renombra al terminar. Bloqueos consultivos de PostgreSQL impiden restaurar con la
instancia en marcha y dos copias a la vez. `runMigrations` gana la copia previa y el bloqueo
(fail-closed); el servidor borra las conversaciones de más de 30 días antes de escuchar y arranca
un programador de la copia diaria. Sin migraciones nuevas. Detalle en [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.x (strict) sobre Node.js 22 LTS (heredado)

**Primary Dependencies**: las de la 001–005 (Fastify 5, Drizzle ORM, `pg`, Zod, …) más
**`pg-copy-streams`** (y `@types/pg-copy-streams`) para `COPY TO/FROM` en flujo (R1). Cifrado,
HKDF y gzip con `node:crypto` y `node:zlib`. `readMigrationFiles` de `drizzle-orm/migrator` para
la versión del esquema (R5).

**Storage**: PostgreSQL 16, la misma BD por instancia; **sin cambios de esquema**. Ficheros `.cbak`
en `BACKUP_DIR`, un volumen persistente de la instancia ([data-model.md](data-model.md)).

**Testing**: Vitest — `unit` (formato: ida y vuelta, byte cambiado, truncado, bloques reordenados,
clave incorrecta, cabecera manipulada; nombres y patrón; `selectExpired`; `dueDailyBackup` con
cambios de hora; configuración), `integration` (Testcontainers: copia/restauración con igualdad
tabla a tabla, copia con escrituras concurrentes, restauración que falla a mitad y deja la BD
igual, copia de esquema anterior + arranque con copia previa, esquema posterior, otra instancia,
instancia en marcha, copia en curso, arranque bloqueado sin clave, BD vacía sin copia,
retención con ficheros ajenos, comprobación que borra la BD temporal, copia diaria y arranque
tardío con reloj controlable, registros sin datos personales, neutralidad de sector (ciclo
copia/restauración igual con las fixtures de los tres sectores y recorrido de `src/backup`)). Sin
contratos HTTP ni `eval`: no cambia la conversación.

**Target Platform**: el mismo contenedor Linux por instancia (`node:22-slim`, sin binarios nuevos)
con un volumen para `BACKUP_DIR`; desarrollo en Windows/macOS/Linux

**Project Type**: servicio web (monolito modular): módulo de operación nuevo `src/backup`, cuatro
comandos en `src/cli` y cambios en el arranque (`src/startup.ts` nuevo, `src/server.ts`,
`src/db/migrate.ts`)

**Performance Goals**: SC-001 — copia de una instancia con 30 días de actividad típica (del orden
de 10⁴ mensajes, < 50 MB) en < 1 min sin pausar al bot; restauración y comprobación del mismo
orden

**Constraints**: una copia = un instante (FR-002); nada legible sin la clave (SC-004); ningún
fichero a medias con nombre de copia (FR-006); restauración todo o nada y solo con la instancia
parada (FR-008, FR-011); ninguna migración sin copia previa si hay datos (SC-003); ninguna
conversación de más de 30 días visible tras restaurar (SC-005); retención 1–30 días con la última
válida siempre (SC-006); registros sin datos personales (FR-024); horas en hora local del negocio;
sin lógica sectorial (FR-023); sin almacenamiento externo (FR-025)

**Scale/Scope**: 1 BD pequeña por instancia (≈ 25 tablas, decenas de MB como mucho); ≤ 1 copia
diaria + las manuales y previas; ≤ 30 días de copias en disco

Cifras que la spec delegaba al plan: bloques de 64 KiB (R3), espera de bloqueos 5 s (R6), pasada
del programador cada 60 s (R10), parciales huérfanos > 1 h (R8), reintento de la diaria fallida al
día siguiente o al reiniciar (R10). No quedan incógnitas técnicas ([research.md](research.md)).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Evaluación inicial (antes de Phase 0)

| Principio | Cumplimiento en esta feature | Estado |
|-----------|------------------------------|--------|
| **I. Base común única** | Spec de núcleo. Los comandos, el formato y la retención son iguales para todas las instancias (FR-023); las tablas se leen del catálogo, no se enumeran por sector. El test de neutralidad recorre también `src/backup`. | ✅ |
| **II. Configuración antes que código** | Identificador, directorio, clave, retención y hora de la copia son variables de la instancia; la zona horaria sale de la configuración del negocio. Nada cambia por código entre instancias. | ✅ |
| **III. Personalizaciones aisladas** | Sin extensiones ni puntos de extensión. | ✅ (N/A) |
| **IV. Solo información registrada** | No toca la cadena de respuesta. Tras restaurar, el bot lee con `KnowledgeReader.getSnapshot()` sin caché lo que hay en la BD, que es exactamente lo registrado en la copia (SC-002). | ✅ |
| **V. Siempre hay salida a una persona** | No cambia la derivación ni el contacto. Las derivaciones activas restauradas siguen las reglas habituales con la hora real al arrancar (caso límite). El arranque solo se bloquea antes de atender (migración sin copia), nunca a mitad de una conversación; la copia diaria no pausa al bot. | ✅ |
| **VI. El operador registra la información** | Copias y restauraciones son comandos del operador en la instancia; no hay pantalla ni acceso del negocio. La restauración no cambia por su cuenta el estado del negocio ni de los canales (FR-013). | ✅ |
| Restricción: aislamiento | Cada copia lleva su `instanceId` dentro y autenticado; la retención solo toca las propias; restaurar la de otra instancia exige nombrarla (`--from-instance`); clave distinta por instancia y guardada fuera de las copias. | ✅ |
| Flujo: pruebas de IV y V | No afecta a la conversación; los tests de IV y V existentes siguen pasando y la integración comprueba que el snapshot tras restaurar es el de la copia. | ✅ |

**Resultado**: sin violaciones. Se puede continuar con Phase 0.

### Re-evaluación tras el diseño (Phase 1)

Revisados [data-model.md](data-model.md) y [contracts/](contracts/):

- **I**: mensajes de [backup-commands.md](contracts/backup-commands.md) y eventos de
  [backup-log.md](contracts/backup-log.md) sin sectores ni clientes; los identificadores de
  ejemplo (`demo-01`) son ilustrativos. ✅
- **II**: [data-model.md](data-model.md#configuración-de-copias) no añade nada por instancia al
  código; la hora es local y la zona horaria, la del negocio. ✅
- **IV/V**: el servidor espera al borrado de conversaciones caducadas antes de escuchar (R11): una
  copia antigua no puede hacer que el bot conteste con conversaciones de más de 30 días. ✅
- **VI**: ninguna ruta HTTP nueva; `db:restore` pide confirmar con el `INSTANCE_ID` destino. ✅
- **Aislamiento y privacidad**: formato con cabecera sin datos personales, cifrado autenticado por
  bloques ([backup-file-format.md](contracts/backup-file-format.md)); registros sin rutas ni
  errores de PostgreSQL; la guía avisa de que la instancia de pruebas queda con datos reales y
  debe ir sin vías de aviso. ✅

**Resultado**: sin violaciones. Complexity Tracking vacío.

**Consecuencias que conviene conocer** (no son violaciones):

- En `production` la instancia **no arranca** sin `INSTANCE_ID`, `BACKUP_DIR` y `BACKUP_KEY`:
  las instancias existentes necesitan esas variables y un volumen antes de actualizar a esta
  versión.
- La imagen necesita un volumen escribible por el usuario `node` montado en `BACKUP_DIR`.
- Sacar las copias de la máquina (réplica, instantáneas, sincronización) es de la plataforma; la
  guía lo recuerda.
- `db:verify` necesita un usuario con `CREATEDB`: en producción se hace desde la instancia de
  pruebas o el equipo del operador.
- A partir de ahora las migraciones MUST seguir siendo de solo añadir y los ficheros de migraciones
  ya publicados MUST NOT editarse: la restauración de copias antiguas reaplica las migraciones y
  comprueba su hash (R5).
- El servidor tarda un poco más en escuchar: espera a una pasada del borrado de conversaciones.
- La restauración es una excepción deliberada a la regla de escritura protegida del núcleo
  (aplicar → recalcular avisos → revertir si un negocio activo queda con un aviso crítico, FR-032
  de la 001): restaura el estado de la copia tal cual, aunque tenga avisos críticos con el núcleo
  instalado (caso límite de la spec, FR-013). El panel muestra esos avisos y el operador los
  corrige con las escrituras normales, que sí pasan por la protección.

## Project Structure

### Documentation (this feature)

```text
specs/006-instance-backup-restore/
├── plan.md              # Este fichero
├── research.md          # Phase 0: decisiones técnicas
├── data-model.md        # Phase 1: copia, informes, retención, programación, configuración
├── quickstart.md        # Phase 1: guía de validación del operador y escenarios de desarrollo
├── contracts/
│   ├── backup-commands.md     # db:backup, db:restore, db:verify, db:backups, arranque
│   ├── backup-file-format.md  # Formato CBAK v1
│   └── backup-log.md          # Eventos backup_*, restore_*, verify_*, migration_*
├── checklists/
└── tasks.md             # Phase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
src/
├── config/env.ts                  # + INSTANCE_ID, BACKUP_DIR, BACKUP_KEY, BACKUP_KEYS_PREVIOUS,
│                                  #   BACKUP_RETENTION_DAYS, BACKUP_DAILY_TIME, BACKUP_VERIFY_URL → env.backup
├── db/migrate.ts                  # runMigrations(url, defaults, { backup }): copia previa y bloqueo
├── backup/                        # NUEVO módulo de operación (sin HTTP)
│   ├── config.ts                  # BackupConfig, claves y keyId
│   ├── format.ts                  # CBAK v1: cabecera Zod, escritor y lector por bloques (AES-GCM, HKDF, gzip)
│   ├── dump.ts                    # volcado: instantánea, recuentos, COPY TO, secuencias; lector de registros
│   ├── schema-version.ts          # installedSchema, databaseSchema, pendingMigrations, applyMigrationsUpTo
│   ├── naming.ts                  # nombre, patrón, .partial
│   ├── locks.ts                   # bloqueos consultivos instance_running / backup_in_progress
│   ├── service.ts                 # createBackup, restoreBackup, verifyBackup, listBackups
│   ├── retention.ts               # selectExpired (pura) y applyRetention
│   ├── scheduler.ts               # dueDailyBackup (pura) y createBackupScheduler
│   ├── errors.ts                  # BackupError / RestoreFailure / MigrationBlockedError (códigos cerrados)
│   └── log.ts                     # catálogo de eventos
├── cli/
│   ├── backup.ts                  # NUEVO: pnpm db:backup
│   ├── restore.ts                 # NUEVO: pnpm db:restore
│   ├── verify.ts                  # NUEVO: pnpm db:verify
│   └── backups.ts                 # NUEVO: pnpm db:backups [--prune]
├── startup.ts                     # startInstance(): bloqueo de instancia, migrar con copia, purga antes de listen, programador
└── server.ts                      # solo lee el entorno, llama a startInstance y gestiona señales

tests/
├── unit/backup/                   # format, naming, retention, scheduler, config
├── integration/backup/            # backup-restore (recorre las fixtures de los tres sectores),
│                                  # concurrency, restore-atomic, older-schema, rejections,
│                                  # premigration, retention, verify, daily, logs
├── unit/sector-neutrality.test.ts          # el recorrido incluye src/backup y los comandos nuevos
└── helpers/backup.ts              # BACKUP_DIR temporal, clave de test, copias con fecha forzada,
                                   # BD migrada hasta un índice (applyMigrationsUpTo)

Dockerfile                         # VOLUME/directorio para BACKUP_DIR con permisos de node
.env.example                       # bloque "Copias de seguridad (feature 006)"
package.json                       # scripts db:backup, db:restore, db:verify, db:backups; pg-copy-streams
docs/operacion-multicliente.md     # §2.3, §2.6, §5 y §7 remiten a los comandos; P3 marcada
README.md                          # estado de la 006 y variables (se avisa antes de cambiarlo)
```

**Structure Decision**: proyecto único, como las features anteriores. `src/backup` es un módulo de
operación hermano de `src/db`: no conoce Fastify ni el dominio de la conversación; habla con
PostgreSQL por `pg` y con el disco por `node:fs`. Los comandos siguen el patrón de `src/cli`
(`tsx` en local, `node dist/...` en la imagen). `src/startup.ts` compone el arranque (bloqueo,
migración con copia, purga y programador) con dependencias inyectables para probar el orden;
`src/server.ts` solo lo invoca.

## Complexity Tracking

Sin violaciones de la constitución que justificar.
