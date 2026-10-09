# Implementation Plan: Resistencia a los cortes de la base de datos y verificación de copias por socket

**Branch**: `016-db-outage-resilience` | **Date**: 2026-10-09 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/016-db-outage-resilience/spec.md`

**Ámbito**: Núcleo (corrección; afecta a todas las instancias)

## Summary

Corregir dos fallos del núcleo descubiertos en la fase 9 del despliegue, los dos del mismo
origen: qué hace el programa cuando la base de datos no está. El primero deja al cliente final
sin ninguna respuesta —el proceso muere antes de poder darla— e incumple en la práctica el
Principio V. El segundo ha impedido comprobar las copias de seguridad en producción desde el
primer día.

Enfoque técnico (detalle en [research.md](research.md)):

1. **El pool no tumba el proceso** (R1). `createDb` registra `pool.on('error', …)`, que es lo que
   le faltaba y lo que el pool del sondeo de salud ya tenía escrito desde la 009. Con eso, toda la
   resistencia a fallos de la 012 —que ya está escrita— empieza a ejecutarse. Se completa el
   inventario de los ocho puntos que abren conexiones, con una prueba estática que lo vigila.
2. **Clasificar «la base no está»** (R2). `isDbUnavailable(error)`, pura, junto a `isPoolBusy`:
   por código (red de Node, SQLSTATE clase 08, `57P0x`), nunca por texto.
3. **Registro acotado del corte** (R3). `src/db/outage.ts`: un vigilante de dos estados que
   anota el inicio una vez, un resumen cada 5 min y la recuperación una vez, detectada por un
   sondeo propio cada 10 s. Un corte de una hora deja 13 líneas, no una por petición.
4. **`/health` deja de parecer un motivo de reinicio** (R4). Valor nuevo `db_unavailable` con
   **HTTP 200**: la base no contesta, pero el proceso vive y sirve. `degraded` (503) queda para
   lo que necesita al operador: esquema vacío, desconocido o distinto del esperado. Arrastra la
   sonda de la imagen y `instance:versions`.
5. **Respuesta por todos los canales** (R5). El chat web ya responde con contacto en su propio
   503; lo que falta es WhatsApp, cuya maquinaria de disculpa (012) necesita la base de datos para
   funcionar. Módulo nuevo `src/conversation/degraded-reply.ts` que, cuando guardar falla por
   indisponibilidad, envía la disculpa con el teléfono de emergencia **sin tocar la base**, una
   sola vez por cliente y corte, y vuelve a lanzar para que Meta reintente. Esa cadencia —cada
   petición en los canales sincrónicos, al menos una vez por cliente y corte en los
   asincrónicos— es la que fija FR-002: repetir el aviso con cada reintento de Meta convertiría
   la disculpa en una ráfaga de mensajes salientes.
6. **Una sola forma de reconstruir una dirección de BD** (R6). `withDatabaseName` en
   `src/config/database-url.ts`, que admite las tres formas. Sustituye al `new URL` de
   `src/backup/service.ts:721`. La auditoría de FR-007 destapa dos comprobaciones de seguridad
   que en producción nunca se han ejecutado: la calidad de la contraseña de la BD y la regla que
   prohíbe el usuario `postgres`, las dos silenciadas por el mismo `new URL`.
7. **Motivos que no mienten en `db:verify`** (R7). `verify_db_unavailable` se divide en
   `verify_url_invalid`, `verify_db_unavailable` (conexión) y `verify_db_create_failed`.
8. **La interfaz del chat no se queda colgada** (R8). Caso final explícito en `send()` y el
   contacto viajando en la página desde que se carga.
9. **Una prueba que corta la base de verdad** (R9). Contenedor propio en el que se para
   PostgreSQL **por dentro** con `pg_ctl`, para no perder el puerto publicado y poder comprobar
   también la recuperación. Dentro de `pnpm test`.

## Technical Context

**Language/Version**: TypeScript 5.x (strict) sobre Node.js 22 LTS (heredado).

**Primary Dependencies**: las existentes. `pg` 8.23 (eventos `error` de `Pool` y `Client`,
códigos SQLSTATE), Drizzle ORM, Fastify 5, Eta, Zod 4, `@testcontainers/postgresql`.
**Sin dependencias nuevas.**

**Storage**: PostgreSQL 16, una BD por instancia. **Sin migración ni cambios de esquema**; no sube
`formatVersion` (R10). El estado del corte vive en memoria y nunca se guarda.

**Testing**: Vitest.

- `unit`:
  - `withDatabaseName` con las tres formas de dirección: nombre de servidor, autoridad vacía con
    el servidor en un parámetro y ruta de socket Unix (FR-011, SC-007); las tres son texto, así
    que esta prueba no necesita base de datos y corre en cualquier sistema operativo;
  - `isDbUnavailable`: tabla de códigos, cadena de causas y los errores que **no** son de
    disponibilidad;
  - vigilante de cortes con reloj y sondeo falsos: una anotación de inicio, resúmenes espaciados,
    una de recuperación, y el recuento de un corte de una hora (FR-014, SC-008);
  - `buildHealthReport`: `db_unavailable` ante sondeo caído o fuera de plazo; `degraded` ante
    esquema vacío, desconocido o distinto;
  - `probeHealth` sale con 0 con `ok` y con `db_unavailable`, y con 1 con el resto;
  - `urlPassword`, `databaseIdentity` y `databasePassword` con dirección por socket;
  - motivos y textos de `db:verify` (los tres códigos, sin mezclar con los de la copia);
  - respuesta degradada: plantilla, contacto de emergencia, una sola vez por cliente y corte;
  - prueba estática del inventario de conexiones: ninguna construcción de `pg.Pool`/`pg.Client`
    en `src/` sin su oyente de `error` (FR-005).
- `contract` (`fastify.inject`):
  - `/health` responde 200 con `db_unavailable` en los dos niveles;
  - `/chat/frame` lleva el contacto en la página, con negocio legible y sin él (FR-013).
- `integration` (Testcontainers):
  - **el corte real** (FR-010): contenedor propio, PostgreSQL parado con `pg_ctl` y la instancia
    levantada por `startInstance`. Verifica FR-001 a FR-004 y SC-001 a SC-003: respuesta con
    contacto por chat web y por WhatsApp, proceso vivo, `/health` 200 `db_unavailable`,
    recuperación sin reinicio con la sesión del panel intacta y registro acotado;
  - `db:verify` con la dirección **sin nombre de servidor** (FR-006), con copia válida, copia
    dañada y clave ajena, más el caso de servidor inalcanzable (FR-008). El caso con **ruta de
    socket Unix literal** va en el mismo fichero y se salta en Windows con una razón visible;
    como no hay integración continua en Linux, su verificación obligatoria es el escenario de
    producción de SC-004 (T051).
- Sin `eval`: la conversación no cambia de contenido; las plantillas que se usan ya existen.

**Target Platform**: servidor Linux (contenedor `node:22-slim` fijado por digest) con PostgreSQL
alcanzado por socket Unix, detrás de un proxy inverso con TLS. Desarrollo y pruebas con
PostgreSQL por TCP.

**Project Type**: servicio web (monolito modular). Cambios en `src/db`, `src/config`,
`src/health`, `src/channels`, `src/conversation`, `src/backup`, `src/cli`, `src/provisioning` y
`src/startup.ts`, más `package.json` (versión 0.1.1) y `docs/`.

**Performance Goals**:

- respuesta con contacto al cliente final en menos de 10 s desde el envío, con la base parada
  (SC-001);
- servicio normal recuperado en menos de 30 s desde que la base vuelve (SC-003): el sondeo del
  vigilante va cada 10 s;
- el oyente del pool y `isDbUnavailable` no añaden trabajo medible al camino normal: solo se
  ejecutan ante un fallo;
- `withDatabaseName` es pura y se llama una vez por comprobación de copia.

**Constraints**:

- el arranque sin base de datos **sigue terminando el proceso**: lo que cambia es el
  comportamiento de una instancia ya en marcha;
- ningún mensaje, registro ni salida nueva lleva credenciales, direcciones de base de datos ni
  partes de ellas, host, usuario o ruta de socket (FR-012);
- ninguna escritura a medias se da por hecha: un corte en mitad de una escritura falla y se
  informa;
- el volumen del registro no crece con el número de peticiones ni con la duración del corte
  (FR-014);
- la prueba del corte usa su propio contenedor, para que pararlo no altere las demás pruebas
  (FR-010);
- `pnpm test` sigue siendo la orden que lo ejecuta todo;
- nada de sectores ni clientes en `src/`; specs, comentarios y mensajes, en español.

**Scale/Scope**: las dos instancias desplegadas y las decenas del inventario. Cortes de segundos
a horas. Copias de decenas de MB.

No quedan incógnitas técnicas: el criterio de «base no disponible», el nombre y el código HTTP del
estado nuevo, la política de la respuesta por WhatsApp, los tres motivos de `db:verify`, las
cadencias del registro y la técnica de la prueba del corte están fijados en el research.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio / regla | Evaluación |
|---|---|
| I. Base común única | **Cumple.** Todo es genérico: el oyente del pool, la clasificación de errores, el estado de salud, la reconstrucción de direcciones y la respuesta degradada no saben de sectores ni de clientes. Ningún nombre ni rama de sector en `src/`. |
| II. Configuración antes que código | **Cumple y no toca configuración.** No se añade ni se cambia ninguna variable de entorno ni ningún dato del negocio; las dos instancias desplegadas no modifican sus ficheros. Los fallos eran de código. |
| III. Personalizaciones aisladas | **No aplica**: sin extensiones ni puntos de extensión nuevos. |
| IV. Solo información registrada | **Cumple.** Durante el corte el bot no afirma nada del negocio: dice que no puede atender y da el contacto. Es el caso extremo del principio —sin información registrada, se reconoce la falta y se ofrece contacto— y usa las plantillas fijas que ya existen (`errorReply`, `emergencyContact`), sin inventar ni estimar nada. |
| V. Siempre hay salida a una persona | **Cumple, y es la razón de ser de la feature.** Hoy el principio está incumplido en la práctica: el cliente final se queda en «escribiendo…» para siempre, sin aviso ni teléfono. FR-002 lo restablece en **todos** los canales del núcleo, FR-009 y FR-013 lo garantizan en la interfaz incluso cuando el servidor no contesta, y FR-013 hace que el contacto viaje en la página para que no dependa de ninguna petición. |
| VI. El operador registra la información | **Cumple.** El negocio no gana acceso a nada. Las órdenes afectadas (`db:verify`, `instance:versions`, `instance:check`) son del operador, y dos reglas de seguridad suyas que estaban silenciadas en producción vuelven a aplicarse (R6). `instance:check` no se modifica: hereda la corrección a través de `databaseIdentity` (`src/provisioning/fingerprint.ts`), de quien depende su regla del usuario `postgres`. |
| Aislamiento entre instancias | **Cumple.** `withDatabaseName` conserva servidor y parámetros, así que la base temporal de verificación sigue creándose en el servidor de verificación y no en el de producción. El vigilante de cortes y la memoria del aviso degradado viven en el proceso de una instancia y no se comparten. |
| Flujo de desarrollo (convenciones) | Spec de núcleo declarada. Sin migraciones y sin subida de `formatVersion`. El dominio (`src/conversation/degraded-reply.ts`) no depende de HTTP; la clasificación de direcciones sigue en `src/config`; el adaptador de canal y el envoltorio de la recepción se conectan en `src/app.ts`. Duraciones del vigilante en minutos y segundos, medidas por la máquina, no horarios del negocio. Al cerrar se actualizan, **avisando antes al usuario**, `README.md` y `docs/operacion-multicliente.md` (§9.1 con fecha, §9.2, la propuesta que cubre y las secciones de operación de `/health` y `db:verify`). |
| Pruebas de IV y V | **Obligatorias aquí y cubiertas.** La prueba del corte real verifica la salida a una persona por los dos canales con la base de datos parada (FR-010), y las de contrato verifican el contacto en la página y el fin del «escribiendo…». Son, además, las pruebas que hoy no existen y que dejaron pasar el fallo. |

**Resultado: sin violaciones; Complexity Tracking vacío.**

**Re-evaluación tras el diseño (Phase 1)**: el diseño no añade tablas, ni rutas HTTP, ni
dependencias, ni configuración; añade un valor a un enumerado, dos códigos de error, una función
pura y un módulo en memoria. Refuerza los Principios IV y V en lugar de tensarlos, y devuelve
dos comprobaciones de seguridad del operador que estaban silenciadas. Sin cambios en la
evaluación.

## Project Structure

### Documentation (this feature)

```text
specs/016-db-outage-resilience/
├── plan.md                          # Este fichero
├── research.md                      # Phase 0 (R1–R10)
├── data-model.md                    # Phase 1 — sin cambios de BD; entidades en memoria y tipos
├── quickstart.md                    # Phase 1 — validación de punta a punta
├── contracts/
│   ├── db-outage.md                 # Pools, registro, respuesta por canal, /health, recuperación
│   ├── backup-verify-socket.md      # withDatabaseName, db:verify por socket, motivos, FR-007
│   └── web-chat-degraded.md         # Contacto en la página y fin del «escribiendo…»
├── spec.md
└── tasks.md                         # Phase 2 (/speckit-tasks; no lo crea /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── db/
│   ├── client.ts                    # pool.on('error'); isDbUnavailable junto a isPoolBusy
│   ├── outage.ts                    # NUEVO — vigilante del corte: estado, registro y sondeo
│   └── migrate.ts                   # client.on('error') en inspect
├── config/
│   ├── database-url.ts              # withDatabaseName (las tres formas de dirección)
│   └── secret-rules.ts              # urlPassword con el parseo tolerante
├── health/
│   └── report.ts                    # HealthStatus db_unavailable; regla y vistas; aviso al vigilante
├── channels/
│   ├── health/routes.ts             # 200 con db_unavailable
│   └── web/
│       ├── routes.ts                # el contacto viaja en la vista del frame (FR-013)
│       ├── api.ts                   # avisa al vigilante en su manejador de errores
│       ├── views/frame.eta          # atributo de datos con el contacto
│       └── assets/frame.js          # caso final explícito; contacto desde la página (FR-009)
├── conversation/
│   ├── degraded-reply.ts            # NUEVO — disculpa con contacto sin tocar la BD (FR-002)
│   ├── activity-log.ts              # eventos db_outage_* y db_degraded_reply_*
│   └── processor.ts                 # failed() avisa al vigilante
├── backup/
│   ├── service.ts                   # withDatabaseName; los tres motivos; create sin tragarse el error
│   ├── locks.ts                     # oyente de error al construir el cliente
│   └── errors.ts                    # verify_url_invalid, verify_db_create_failed
├── cli/
│   ├── backup-common.ts             # motivos y mensajes de los tres códigos
│   └── healthcheck.ts               # sale con 0 también con db_unavailable
├── provisioning/
│   ├── versions.ts                  # statusSchema, codeMatches y etiquetas con db_unavailable
│   ├── fingerprint.ts               # parsePgUrl tolerante: identidad y contraseña con socket
│   └── database.ts                  # comentarios: parseAdminUrl y buildUrl rechazan socket a propósito
├── app.ts                           # BotHttp expone el remitente; onInbound con el envoltorio degradado
└── startup.ts                       # engancha el vigilante al registro de la instancia

tests/
├── helpers/own-postgres.ts          # NUEVO — contenedor propio con pg_ctl stop/start
├── helpers/db.ts                    # las tres formas de dirección para las pruebas
├── unit/db/outage.test.ts · client-unavailable.test.ts · pool-listeners.test.ts
├── unit/config/database-url.test.ts · secret-rules.test.ts
├── unit/health/report.test.ts · unit/cli/healthcheck.test.ts
├── unit/provisioning/fingerprint.test.ts · versions.test.ts · check.test.ts
├── unit/conversation/degraded-reply.test.ts
├── unit/backup/verify-failures.test.ts
├── unit/channels/frame-degraded.test.ts
├── contract/health.test.ts · contract/web-chat-frame.test.ts
├── integration/db/outage.test.ts            # FR-010: el corte real
└── integration/backup/verify-socket.test.ts # FR-006, FR-008

package.json                         # versión 0.1.1 (R10)
docs/operacion-multicliente.md       # /health con db_unavailable; motivos de db:verify; §9.1, §9.2
README.md                            # estado de la feature 016
```

**Structure Decision**: monolito modular existente. El vigilante del corte vive en `src/db`
porque su materia es la conexión, lo alimentan los pools y no debe depender de HTTP ni del canal.
La reconstrucción de direcciones va a `src/config/database-url.ts`, que desde la 013 es la única
autoridad sobre las direcciones de base de datos, y así las copias dejan de tener su propia
versión del problema. La respuesta degradada es dominio (`src/conversation`), porque es una
decisión de conversación —qué se le dice al cliente y con qué contacto— y debe valer para
cualquier canal; quien la conecta al webhook es `src/app.ts`, que es donde ya se conectan los
canales.

## Complexity Tracking

> Sin violaciones de la constitución que justificar.
