# Implementation Plan: Requisitos de despliegue seguro

**Branch**: `013-secure-deployment` | **Date**: 2026-10-06 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/013-secure-deployment/spec.md`

**Ámbito**: Núcleo (operación y documentación; propuesta P9)

## Summary

Hacer que el despliegue seguro se compruebe en lugar de depender de la memoria del operador. Es
la última propuesta bloqueante antes de la primera publicación en producción.

Enfoque técnico (detalle en [research.md](research.md)):

1. **Clasificación de URL de BD**: una función pura compartida (`src/config/database-url.ts`)
   decide si el host es local (`localhost`, `127.0.0.0/8`, `::1`, socket) y si la URL exige
   `sslmode=verify-full` (R1).
2. **`instance:check`**: `trust_proxy_empty` pasa a error en producción. Hay error nuevo
   `database_tls_required` por cada URL de BD remota sin TLS verificado (`DATABASE_URL`,
   `BACKUP_VERIFY_URL`, `INSTANCE_DB_ADMIN_URL`). Las tres reglas son advertencias en el perfil de
   pruebas (R2).
3. **`instance:db`**: se niega siempre a conectar con un servidor remoto sin TLS verificado.
   Además gana `--sslrootcert` y pone `verify-full` por defecto con `--print-sql --host` remoto
   (R3).
4. **TLS en todas las conexiones**: las conexiones no cambian, porque `pg` ya aplica lo que dice
   la URL. Lo que cambia es que se comprueba antes si el fichero de `sslrootcert` se puede leer y
   que los errores de conexión se traducen por código a mensajes sin host ni ruta, en el arranque
   y en las órdenes de copias (R4).
5. **`db:verify`**: nombre con marca UTC; `REVOKE CONNECT, TEMPORARY … FROM PUBLIC` antes de
   cargar; limpieza previa de huérfanas (patrón exacto, sin conexiones, más de 6 h o formato
   anterior) con `DROP` sin `FORCE`; recuento en el informe (R5).
6. **Imagen y repositorio**: `HEALTHCHECK` con una sonda en Node sobre la vista pública de
   `/health`; base fijada por digest con un `ARG` común; `packageManager` con hash; `.npmrc` con
   `save-exact`; `onlyBuiltDependencies` con `argon2` y `esbuild`; `.gitignore` con
   `*.pem`/`*.key`/`*.p12` (R6–R8).
7. **Guía**: receta de producción en la §2.5, con cada paso comprobable, y cambios en las §2.3,
   §2.4, §5 y §8 (R10).

## Technical Context

**Language/Version**: TypeScript 5.x (strict) sobre Node.js 22 LTS (heredado).

**Primary Dependencies**: las existentes. `pg` 8.23 con `pg-connection-string` 2.14, que ya
interpreta `sslmode=verify-full` y `sslrootcert`. Además `node:net` para normalizar IP, `fetch`
de Node para la sonda, Fastify 5 y Zod 4. **Sin dependencias nuevas.**

**Storage**: PostgreSQL 16, una BD por instancia. **Sin migración ni cambios de esquema**; no sube
`formatVersion`. En el servidor de verificación cambian solo el nombre y los permisos de las bases
temporales.

**Testing**: Vitest.
- `unit`:
  - tabla de `classifyDatabaseUrl`;
  - reglas de `instance:check` por perfil, con paridad texto/JSON y sin valores en la salida;
  - `instance:db` sin conexión cuando la URL no tiene TLS verificado; `--sslrootcert`;
  - nombres y selección de huérfanas con reloj falso;
  - `describeDatabaseError`;
  - sonda de salud contra un servidor HTTP de prueba;
  - pruebas estáticas de `Dockerfile`, `package.json`, `.npmrc` y `.gitignore`.
- `integration` (Testcontainers):
  - PostgreSQL con TLS y autoridad propia generada con `openssl` en el contenedor; `verify-full`
    en pool, salud, migraciones, copia, restauración y verificación;
  - nombre que no coincide con el certificado y autoridad ilegible, con mensajes sin datos;
  - limpieza de huérfanas: antigua, reciente, en uso, nombres ajenos, formato anterior, otro
    dueño y listado imposible; `REVOKE` efectivo frente a un usuario sin privilegios.
- Sin pruebas de contrato HTTP nuevas: `/health` no cambia.
- Sin `eval`: la conversación no cambia.

**Target Platform**: servidor Linux (contenedor `node:22-slim` fijado por digest) detrás de un
proxy inverso con TLS. `instance:check` e `instance:db` se ejecutan en el equipo del operador.

**Project Type**: servicio web (monolito modular). Cambios en `src/config`, `src/provisioning`,
`src/backup`, `src/cli`, `src/startup.ts` y `src/server.ts`, más `Dockerfile`, `package.json`,
`.npmrc`, `.gitignore` y `docs/`.

**Performance Goals**:
- `instance:check` sigue siendo instantáneo: sin E/S nueva y sin leer el fichero de autoridad;
- la limpieza de huérfanas es una consulta más un `DROP` por huérfana;
- con BD, la instancia está sana en menos de 2 min; sin ella, enferma en menos de 3 min tras la
  gracia (SC-004).

**Constraints**:
- ningún mensaje muestra una URL, una parte de ella, una ruta de certificado ni los nombres del
  certificado (FR-006, SC-002);
- la regla de TLS no se aplica al arrancar;
- la limpieza nunca toca una base fuera del patrón exacto ni una en uso (FR-011);
- la sonda no depende de curl ni wget y respeta el límite de `/health` (30 por minuto);
- nada de sectores ni clientes en `src/`; textos en español.

**Scale/Scope**: decenas de instancias en el inventario; un servidor de verificación compartido
por varias; copias de decenas de MB.

No quedan incógnitas técnicas: los criterios de host local y de TLS, el plazo de las huérfanas
(6 h), los parámetros del `HEALTHCHECK` y la lista de scripts autorizados están fijados en el
research.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio / regla | Evaluación |
|---|---|
| I. Base común única | **Cumple.** Reglas, imagen y receta son genéricas. La receta no nombra proveedor, cliente ni sector (FR-021). Ningún nombre ni rama de sector en `src/`. |
| II. Configuración antes que código | **Cumple.** El TLS y la autoridad de cada instancia se configuran en su URL (`sslmode`, `sslrootcert`), sin código por instancia. No toca la configuración del negocio. |
| III. Personalizaciones aisladas | **No aplica**: sin extensiones ni puntos de extensión nuevos. |
| IV. Solo información registrada | **No aplica**: la cadena de respuesta y el prompt no cambian. |
| V. Siempre hay salida a una persona | **No aplica**: la conversación no cambia. La comprobación de salud solo informa a la plataforma y no reinicia ni bloquea nada. |
| VI. El operador registra la información | **Cumple.** Todas las herramientas son del operador. El negocio no gana acceso a nada. |
| Aislamiento entre instancias | **Cumple y se refuerza.** Las bases temporales de verificación ya no admiten conexiones de otros usuarios (FR-009). La limpieza solo borra lo que sigue el patrón exacto y no está en uso, así que una instancia no puede borrar la verificación en curso de otra ni ninguna base de instancia (`chatbot_<id>`). El TLS verificado protege los datos y la credencial de cada instancia en tránsito. |
| Flujo de desarrollo (convenciones) | Spec de núcleo declarada. Sin migraciones. El módulo nuevo `src/config/database-url.ts` es puro y sin HTTP; las órdenes viven en `src/cli` y `src/provisioning`. Las marcas de tiempo de las bases temporales van en UTC porque son instantes técnicos, no horarios del negocio (research R5). Duraciones en segundos o horas donde las mide la máquina. Al cerrar se actualizan, avisando antes al usuario, `README.md` y `docs/operacion-multicliente.md`: §9.1 con fecha, §9.2, P9 hecha, y §2.3, §2.4, §2.5, §5 y §8. |
| Pruebas de IV y V | No hacen falta pruebas nuevas: la feature no afecta a la conversación. Las existentes siguen pasando. |

**Resultado: sin violaciones; Complexity Tracking vacío.**

**Re-evaluación tras el diseño (Phase 1)**: el diseño no añade tablas ni rutas HTTP, no cambia la
conversación y no amplía lo que el negocio puede hacer. Las reglas nuevas solo son más estrictas
(error donde antes había advertencia; negativa a conectar sin TLS). Sin cambios en la evaluación.

## Project Structure

### Documentation (this feature)

```text
specs/013-secure-deployment/
├── plan.md                          # Este fichero
├── research.md                      # Phase 0 (R1–R10)
├── data-model.md                    # Phase 1
├── quickstart.md                    # Phase 1
├── contracts/
│   ├── check-rules.md               # instance:check e instance:db: códigos, perfiles, textos
│   ├── database-tls.md              # verify-full, sslrootcert, errores de conexión sin datos
│   ├── verify-cleanup.md            # nombre, REVOKE, huérfanas, informe y registro
│   ├── image-and-repo.md            # HEALTHCHECK y sonda, digest, packageManager, .npmrc, .gitignore
│   └── production-recipe.md         # índice de la §2.5 y demás secciones de la guía
├── checklists/requirements.md
└── tasks.md                         # Phase 2 (/speckit-tasks; no lo crea /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── config/
│   └── database-url.ts              # NUEVO — classifyDatabaseUrl, assertCaReadable, describeDatabaseError, DatabaseConfigError
├── provisioning/
│   ├── check.ts                     # trust_proxy_empty como error; database_tls_required; database_url_invalid
│   ├── messages.ts                  # textos nuevos y modificados; admin_url_tls_required
│   └── database.ts                  # parseAdminUrl con la clasificación común; sslrootcert en probeUrl y buildDatabaseUrl
├── backup/
│   ├── service.ts                   # verifyBackup: nombre con marca, REVOKE, limpieza, orphans en el informe
│   ├── verify-names.ts              # NUEVO — nombre, patrones y selección de huérfanas (puro)
│   ├── errors.ts · log.ts           # db_ca_unreadable, db_tls_untrusted, db_tls_unsupported; campos orphans* en verify_completed
├── cli/
│   ├── instance.ts                  # instance:db: negativa sin TLS, --sslrootcert, verify-full por defecto
│   ├── verify.ts · backup-common.ts # línea de huérfanas; motivos TLS; assertCaReadable
│   ├── backup.ts · restore.ts       # assertCaReadable
│   └── healthcheck.ts               # NUEVO — sonda de la imagen
├── db/migrate.ts                    # assertCaReadable en la orden db:migrate
├── startup.ts                       # assertCaReadable antes del cerrojo
└── server.ts                        # mensaje de error sin datos (describeDatabaseError)

tests/
├── unit/config/database-url.test.ts
├── unit/provisioning/check.test.ts · database.test.ts      # reglas nuevas, instance:db
├── unit/backup/verify-names.test.ts
├── unit/cli/healthcheck.test.ts
├── unit/scripts/image-pinning.test.ts · repo-hygiene.test.ts  # Dockerfile, package.json, .npmrc, .gitignore
├── integration/db/tls.test.ts                              # verify-full en cada camino; errores sin datos
├── integration/backup/verify-cleanup.test.ts               # huérfanas y REVOKE
└── integration/provisioning/                               # instance:db con URL remota sin TLS

Dockerfile                           # ARG NODE_IMAGE con digest; .npmrc; HEALTHCHECK
package.json                         # packageManager con hash; pnpm.onlyBuiltDependencies
.npmrc                               # NUEVO — save-exact=true
.gitignore                           # *.pem, *.key, *.p12
docs/operacion-multicliente.md       # §2.3, §2.4, §2.5 (receta), §5, §8; al cerrar §9.1, §9.2 y P9
README.md                            # estado de la feature 013
```

**Structure Decision**: monolito modular existente. La clasificación de URL vive en `src/config`
porque la usan el arranque, las copias y el aprovisionamiento, y el aprovisionamiento no debe ser
una dependencia del arranque (mismo criterio que `secret-rules.ts` en la 012). La lógica de los
nombres de verificación es pura y va aparte (`src/backup/verify-names.ts`) para probarla con un
reloj falso. La sonda es una orden más de `src/cli`, compilada con el resto, para que la imagen
la incluya sin ficheros extra.

## Complexity Tracking

> Sin violaciones de la constitución que justificar.
