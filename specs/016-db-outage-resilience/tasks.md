---

description: "Lista de tareas de la feature 016: resistencia a los cortes de la base de datos y verificación de copias por socket"
---

# Tasks: Resistencia a los cortes de la base de datos y verificación de copias por socket

**Input**: documentos de diseño de `/specs/016-db-outage-resilience/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md) (R1–R10),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Ámbito**: núcleo (corrección; afecta a todas las instancias).

**Tests**: sí, y son el corazón de esta corrección. La spec los exige por escrito (FR-010,
FR-011, SC-006, SC-007) y la constitución los exige para los Principios IV y V. El plan pide
pruebas `unit`, `contract` e `integration` (Testcontainers); sin `eval`, porque la conversación no
cambia de contenido. Dentro de cada fase, **los tests se escriben primero y deben fallar antes de
implementar**.

**Organización**: por historia de usuario (spec.md), en orden de prioridad: US1 y US2 (P1), US3 y
US4 (P2). Lo que comparten US1, US2 y US4 —clasificar un error de BD, el vigilante del corte y la
reconstrucción de direcciones— va en la fase 2, que las bloquea.

## Formato: `[ID] [P?] [Story] Descripción`

- **[P]**: se puede hacer en paralelo (ficheros distintos, sin dependencias pendientes)
- **[Story]**: historia a la que pertenece (US1…US4)
- Cada tarea indica la ruta exacta del fichero

## Convenciones del proyecto que afectan a todas las tareas

- Specs, comentarios, mensajes y textos, en español.
- **Sin migración ni cambios de esquema**: `formatVersion` de `src/config-transfer/format.ts`
  **no sube** y no hay actualizador nuevo (R10).
- **Sin variables de entorno nuevas ni cambios de configuración**: las dos instancias desplegadas
  no tocan sus ficheros.
- Los errores de `pg` y de Node se clasifican **por código** siempre que lo tengan. Las dos
  comparaciones de texto que ya existían (`isPoolBusy` y `PG_NO_SSL`) se mantienen.
  **Corregido durante la implementación**: hubo que añadir una tercera excepción, por el mismo
  motivo que las dos anteriores —`pg` no da código—. Al reutilizar del pool una conexión ociosa
  que el servidor ya cerró, `pg` lanza un `Error` plano con el texto
  `Connection terminated unexpectedly` y **sin `code`**, que es exactamente como llega el fallo
  en producción; se añade también
  `Client has encountered a connection error and is not queryable`. Los dos son constantes de
  `pg` y no llevan nada de la dirección ni de las credenciales (FR-012). Lo destapó la prueba del
  corte real (T010), no las unitarias: es la segunda vez en esta feature que la prueba de verdad
  encuentra lo que la simulada no.
- Ningún mensaje, informe, registro ni salida de prueba muestra una dirección de base de datos ni
  parte de ella (usuario, contraseña, host, base), ni una ruta de socket (FR-012).
- El **arranque sin base de datos sigue terminando el proceso**: todo lo de aquí cambia el
  comportamiento de una instancia **ya en marcha**.
- El dominio (`src/conversation`, `src/knowledge`, `src/webchat`) no importa Fastify;
  `src/config/database-url.ts` sigue siendo puro (sin `pg` ni HTTP).
- El registro de actividad es un catálogo cerrado sin texto libre: los eventos nuevos tampoco lo
  tienen.
- `frame.js` nunca construye HTML a partir de texto: todo con `textContent` (garantía 9 de la 004).
- En `src/` no puede haber nombres ni lógica de un sector o cliente.

---

## Phase 1: Setup (infraestructura de pruebas compartida)

**Purpose**: los dos ayudantes de prueba que hacen posible comprobar los fallos de verdad, en
lugar de simularlos donde el código los espera.

- [x] T001 Crear `tests/helpers/own-postgres.ts`: contenedor PostgreSQL 16 **propio** (nunca el de `tests/helpers/global-setup.ts`), con `stopServer()` y `startServer()` que ejecutan `pg_ctl -m fast stop` y `pg_ctl start` **dentro** del contenedor vía `container.exec`, para que el puerto publicado no cambie (research R9); expone `url(db)`, `adminUrl` y `stop()`
- [x] T002 [P] Añadir a `tests/helpers/db.ts` las **tres** formas de dirección de las Key Entities de la spec: la normal (con servidor), la **de autoridad vacía** (`postgres://u:c@/base?host=localhost&port=<puerto>`), que es la que rompe `new URL` y funciona en cualquier sistema operativo, y la de **ruta de socket Unix** (`host=/var/run/postgresql`), que solo se puede conectar donde haya sockets Unix pero sí se puede construir y parsear en todas partes; documentar en el fichero por qué la de autoridad vacía reproduce el fallo de producción sin necesitar un socket

**Checkpoint**: se puede parar y arrancar PostgreSQL desde una prueba y construir las tres formas de dirección.

---

## Phase 2: Foundational (prerrequisitos que bloquean todas las historias)

**Purpose**: las tres piezas compartidas: reconocer que la base no está, registrar el corte una
sola vez y reconstruir una dirección de base de datos sin romperse.

**⚠️ CRITICAL**: ninguna historia puede empezar hasta que esta fase esté completa.

### Tests de la fase 2

- [x] T003 [P] Escribir `tests/unit/db/client-unavailable.test.ts`: tabla de `isDbUnavailable` con los códigos de red de Node (`ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `EHOSTUNREACH`, `ENETUNREACH`, `ETIMEDOUT`, `EPIPE`, `ENOENT`), la clase SQLSTATE 08 y `57P01`/`57P02`/`57P03`; el caso de `isPoolBusy`; la cadena de `cause` a varios niveles (envoltorio de Drizzle); y los errores que **no** son de disponibilidad (sintaxis SQL, violación de unicidad, error sin código)
- [x] T004 [P] Escribir `tests/unit/config/database-url.test.ts` (ampliando el existente): tabla de `withDatabaseName` con las **tres** formas de dirección —con servidor, con autoridad vacía y con ruta de socket Unix; las tres son texto, así que esta prueba corre en cualquier sistema operativo— comprobando que conserva usuario, contraseña, puerto y **todos** los parámetros (`host`, `sslmode`, `sslrootcert`) en su orden, que es idempotente con el mismo nombre de base y que devuelve `null` —sin lanzar— con protocolo ajeno o texto no interpretable (**FR-011**, SC-007)
- [x] T005 [P] Escribir `tests/unit/db/outage.test.ts`: con reloj y sondeo falsos, el vigilante registra **una** anotación de inicio, una de recuperación con `durationMs` y `failures`, y un resumen cada 5 min; cien fallos durante el corte no añaden anotaciones; un corte de una hora deja exactamente 13; un error que no es de disponibilidad no abre corte; al recuperar se vacía la memoria de avisos; y, alimentando el vigilante con un error que **sí** lleva la dirección de la base de datos en su mensaje, ninguna de las anotaciones (inicio, resumen, recuperación) contiene usuario, contraseña, servidor, nombre de base ni ruta de socket (**FR-014**, **FR-012**, SC-008)

### Implementación de la fase 2

- [x] T006 Implementar `isDbUnavailable(error)` en `src/db/client.ts`, junto a `isPoolBusy` y con su mismo recorrido de `cause` (hasta 5 niveles), clasificando solo por código (research R2)
- [x] T007 [P] Implementar `withDatabaseName(url, database)` en `src/config/database-url.ts` reutilizando el `parse()` tolerante que ya existe en el fichero (el que rodea la limitación de `new URL`); devuelve `string | null` y nunca lanza (research R6, [contracts/backup-verify-socket.md](contracts/backup-verify-socket.md) §1)
- [x] T008 Crear `src/db/outage.ts` con el vigilante del corte: estados `up`/`down`, `note(error)`, sondeo `select 1` cada 10 s mientras está caída, resumen cada 5 min, memoria de avisos por `channelUserId`, y `attachLogger()` para que el arranque le dé el registro de la instancia; por omisión silencioso, para que las órdenes de `src/cli` no escriban nada inesperado ([data-model.md](data-model.md) §1)
- [x] T009 Añadir al catálogo cerrado de `src/conversation/activity-log.ts` los eventos `db_outage_started`, `db_outage_ongoing` (`elapsedMs`, `failures`), `db_outage_recovered` (`durationMs`, `failures`), `db_degraded_reply_sent` (`channel`, `customer` seudónimo) y `db_degraded_reply_skipped` (`channel`, `reason`), sin ningún campo de texto libre

**Checkpoint**: las tres piezas compartidas existen y están probadas; US1, US2 y US4 pueden empezar.

---

## Phase 3: User Story 1 - El cliente final recibe una respuesta aunque la base de datos no esté (Priority: P1) 🎯 MVP

**Goal**: que una instancia ya arrancada sobreviva al corte, siga respondiendo por **los dos
canales** con el aviso y el contacto, informe de su estado degradado sin dar motivo de reinicio, y
se recupere sola cuando la base vuelva.

**Independent Test**: cortar la base de datos con el chat abierto y comprobar que llega respuesta
con contacto, que el proceso sigue vivo, que `/health` responde 200 con `db_unavailable` y que al
volver la base se atiende con normalidad sin reiniciar.

### Tests de la US1 ⚠️ primero, y deben fallar

- [x] T010 [US1] Escribir `tests/integration/db/outage.test.ts` con el contenedor propio de T001 y la instancia real de `startInstance`: (a) con PostgreSQL parado, `POST /chat/api/messages` responde en menos de 10 s con el aviso y el **teléfono de emergencia**; (b) el proceso sigue vivo y atiende la petición siguiente; (c) `GET /health` responde **200** con `db_unavailable`; (d) un entrante de WhatsApp provoca el envío de la disculpa con contacto por un remitente de prueba, y solo una vez aunque el cliente insista o Meta reintente, que es la cadencia que FR-002 fija para los canales asincrónicos; (e) al arrancar PostgreSQL la instancia vuelve a atender **sin reiniciar** y la sesión del panel abierta antes del corte sigue valiendo; (f) el registro tiene exactamente una anotación de inicio y una de recuperación; (g) el corte abarca al menos dos ciclos del sondeo de salud y una petición de cada canal, que es el umbral comprobable de SC-002 (**FR-010**, FR-001–FR-004, FR-014, SC-001–SC-003)
- [x] T010b [US1] Añadir al mismo fichero el caso de la **escritura a medias** del edge case de la spec: parar PostgreSQL con una escritura en vuelo (una derivación o un mensaje entrante) y comprobar que la operación falla, que se informa al cliente, que no queda ningún registro a medias cuando la base vuelve y que el proceso sigue vivo
- [x] T011 [P] [US1] Escribir en `tests/unit/health/report.test.ts` los casos de la regla nueva: sondeo que falla por indisponibilidad → `db_unavailable`; sondeo fuera de plazo → `db_unavailable`; esquema vacío, migración desconocida y esquema distinto → `degraded`; esquema esperado → `ok`; durante el corte `schema.applied` y `spendCap` son `null`; y el informe con `db_unavailable`, en los dos niveles, no lleva ninguna parte de la dirección de la base de datos (**FR-012**) ([data-model.md](data-model.md) §3)
- [x] T012 [P] [US1] Escribir en `tests/contract/health.test.ts` los casos HTTP del estado nuevo: nivel sin credencial devuelve **200** con `{"status":"db_unavailable"}`; nivel con `Bearer` devuelve 200 con el informe completo; `degraded` y `not_ready` siguen en 503; se mantienen `Cache-Control: no-store` y el 401 indistinguible
- [x] T013 [P] [US1] Escribir en `tests/unit/cli/healthcheck.test.ts` que `probeHealth` sale con **0** con 200 + `db_unavailable` y con 200 + `ok`, y con 1 con 503, con un cuerpo que no es JSON y con un fallo de red
- [x] T014 [P] [US1] Escribir en `tests/unit/provisioning/versions.test.ts` que una instancia que responde 200 con `db_unavailable` se lee como ese estado (no como `invalid_response`) en los dos niveles, y que la tabla de etiquetas lo muestra
- [x] T015 [P] [US1] Escribir `tests/unit/conversation/degraded-reply.test.ts`: con un fallo de indisponibilidad se envía `errorReply('tu')` + `emergencyContact(teléfono)` por el remitente del canal; **una sola vez** por `channelUserId` y corte; se vuelve a lanzar el error para que el webhook responda 503; sin teléfono de emergencia o sin remitente no se envía nada y se registra `db_degraded_reply_skipped`; un fallo que **no** es de indisponibilidad pasa de largo sin enviar nada; tras la recuperación se vuelve a avisar; el cliente que insiste durante el mismo corte no provoca ningún mensaje saliente más (**FR-002**, cadencia de los canales asincrónicos, US1-6); y las anotaciones `db_degraded_reply_*` no llevan ninguna parte de la dirección de la base de datos (**FR-012**)

### Implementación de la US1

- [x] T016 [US1] Registrar `pool.on('error', …)` en `createDb` de `src/db/client.ts`, entregando el error al vigilante y **sin volver a lanzar**; comentar en el fichero por qué (un pool que emite `error` sin oyentes termina el proceso) y que las consultas en vuelo siguen rechazándose como siempre (**FR-001**, research R1)
- [x] T017 [US1] En `src/startup.ts`, enganchar el vigilante al registro de la instancia en cuanto exista (`attachLogger`) y cerrarlo en `stop()`, sin cambiar el orden del arranque ni convertir el arranque sin base de datos en un arranque degradado
- [x] T018 [P] [US1] Añadir el valor `db_unavailable` a `HealthStatus` y la regla nueva de `buildHealthReport` en `src/health/report.ts` (no contesta → `db_unavailable`; contesta mal → `degraded`), incluirlo en `publicView` y `fullView`, y hacer que el oyente del pool del sondeo avise también al vigilante (**FR-003**, [contracts/db-outage.md](contracts/db-outage.md) §4)
- [x] T019 [US1] En `src/channels/health/routes.ts`, devolver **200** con `ok` y con `db_unavailable`, y 503 con `degraded` y `not_ready`; actualizar el comentario de cabecera, que hoy dice «200 solo con `ok`»
- [x] T020 [P] [US1] En `src/cli/healthcheck.ts`, salir con 0 también con `db_unavailable`, para que un corte de la base **no** deje el contenedor `unhealthy` y ninguna política de reinicio tenga motivo (SC-002)
- [x] T021 [P] [US1] En `src/provisioning/versions.ts`, añadir `db_unavailable` a `statusSchema`, a `InstanceStatus`, a `codeMatches` (200, como `ok`) y a las tablas de etiquetas de `instance:versions`
- [x] T022 [US1] Crear `src/conversation/degraded-reply.ts` (dominio, sin HTTP): envuelve la recepción de cualquier canal, y ante un fallo con `isDbUnavailable` avisa al vigilante, envía la disculpa con el contacto de emergencia una sola vez por cliente y corte usando las plantillas existentes `errorReply` y `emergencyContact`, registra el envío con el seudónimo del cliente y **vuelve a lanzar** (**FR-002**, research R5)
- [x] T023 [US1] En `src/app.ts`, exponer en `BotHttp` el remitente del canal necesario para la respuesta degradada y envolver `onInbound` con `degraded-reply`, dejando el webhook de WhatsApp tal cual (sigue respondiendo 503 para que Meta reintente)
- [x] T024 [P] [US1] En `src/channels/web/api.ts`, avisar al vigilante desde el manejador de errores cuando el fallo sea de indisponibilidad, sin cambiar ninguna respuesta: el 503 con `unavailable` y el contacto de emergencia ya es el correcto y no se toca
- [x] T025 [P] [US1] En `src/conversation/processor.ts`, avisar al vigilante desde `failed()` cuando el fallo del lote sea de indisponibilidad, sin cambiar la espera creciente ni el abandono de la 012

**Checkpoint**: una instancia sobrevive al corte, responde con contacto por los dos canales, informa de su estado sin dar motivo de reinicio y se recupera sola. El Principio V vuelve a cumplirse en la práctica.

---

## Phase 4: User Story 2 - El operador puede comprobar que sus copias de seguridad sirven (Priority: P1)

**Goal**: que `pnpm db:verify` funcione con la forma de dirección del despliegue real y que, cuando
falle, el motivo señale la capa que falló.

**Independent Test**: comprobar una copia recién hecha con una dirección de verificación sin
nombre de servidor y ver «restaurable» con sus recuentos y la base temporal borrada.

### Tests de la US2 ⚠️ primero, y deben fallar

- [x] T026 [P] [US2] Escribir `tests/integration/backup/verify-socket.test.ts`: con una `BACKUP_VERIFY_URL` **de autoridad sin servidor** (T002) y un PostgreSQL real, (a) una copia válida da **restaurable** con sus recuentos por tabla y la base temporal borrada; (b) una copia dañada da `corrupted` y una con otra clave, `wrong_key`, **distinguibles de un problema de conexión** (US2-2, FR-008); (c) con una dirección con nombre de servidor todo sigue igual que antes (US2-3)
- [x] T027 [US2] Añadir al mismo fichero el caso con una **ruta de socket Unix real**, montando el directorio del socket del contenedor en el equipo, y saltarlo con una razón visible cuando el sistema no admite sockets Unix (`process.platform === 'win32'`). La razón del salto MUST decir que la forma literal de producción se verifica en T051 (SC-004), porque **no hay integración continua en Linux** y en Windows este caso nunca se ejecuta: la puerta obligatoria es el escenario de producción, no esta prueba (FR-006)
- [x] T028 [P] [US2] Escribir `tests/unit/backup/verify-failures.test.ts`: los tres motivos nuevos salen cada uno de su capa (dirección ininterpretable, conexión imposible, creación imposible), los motivos **de la copia** no se mezclan con ellos, los de TLS de la 013 conservan su código, y ningún texto lleva dirección, host, usuario ni ruta ([contracts/backup-verify-socket.md](contracts/backup-verify-socket.md) §3)

### Implementación de la US2

- [x] T029 [P] [US2] En `src/backup/errors.ts`, añadir a `RestoreFailureCode` los códigos `verify_url_invalid` y `verify_db_create_failed`, y estrechar el significado de `verify_db_unavailable` a «no se pudo conectar» ([data-model.md](data-model.md) §5)
- [x] T030 [US2] En `src/backup/service.ts`, sustituir `withDatabase` (el `new URL` de la línea 721) por `withDatabaseName`: si devuelve `null`, el motivo es `verify_url_invalid`; dejar `verify_db_unavailable` solo para el fallo de conexión con el servidor de verificación, y clasificar con `connectFailure` el fallo de `create database`/`revoke` como `verify_db_create_failed`, de modo que un fallo de TLS siga teniendo su código propio (**FR-006**, **FR-008**, research R6 y R7)
- [x] T031 [US2] En `src/cli/backup-common.ts`, añadir los motivos cortos y los mensajes largos de los tres códigos con los textos del contrato, corrigiendo el actual «no se pudo crear la base de datos temporal» para que solo aparezca cuando la creación es lo que falló

**Checkpoint**: las copias se pueden comprobar con la forma de dirección de producción y los motivos de fallo dicen la verdad.

---

## Phase 5: User Story 3 - La interfaz del chat no se queda colgada ante un fallo inesperado (Priority: P2)

**Goal**: que el «escribiendo…» termine siempre en una respuesta o en un aviso con contacto, sea
cual sea el fallo y aunque el servidor no conteste.

**Independent Test**: provocar desde el servidor una respuesta de error a un envío y comprobar que
la interfaz deja de indicar espera y ofrece contacto.

### Tests de la US3 ⚠️ primero, y deben fallar

- [x] T032 [P] [US3] Escribir `tests/contract/web-chat-frame.test.ts`: `GET /chat/frame` lleva el contacto en la página con el negocio legible (el del negocio), con el negocio ilegible (el **teléfono de emergencia**) y sin ninguno de los dos (`null`); el valor va escapado y la página no lleva nada más de la instancia (**FR-013**, FR-012)
- [x] T033 [P] [US3] Escribir `tests/unit/channels/frame-degraded.test.ts`: ante una respuesta 500, 502 o un cuerpo que no es JSON, la interfaz deja de indicar espera y añade el aviso con el contacto **de la página**; el formulario **no** se esconde, así que se puede volver a escribir y la conversación sigue; el aviso no se repite en bucle; los casos conocidos (202, 400, 401, 429, `unavailable`) se comportan igual que antes (**FR-009**, SC-005)

### Implementación de la US3

- [x] T034 [US3] En `src/channels/web/routes.ts`, pasar el contacto a la vista del frame usando el `lastContact` que ya se calcula (el del negocio si se pudo leer el snapshot; el de emergencia si no), también en la rama «no disponible»
- [x] T035 [P] [US3] En `src/channels/web/views/frame.eta`, añadir el contacto como atributo de datos en `<html>`, escapado por la plantilla, junto a los atributos del tema
- [x] T036 [US3] En `src/channels/web/assets/frame.js`, leer el contacto de `document.documentElement.dataset` al arrancar y antes de cualquier petición, y añadir en `send()` el caso final explícito que retira la indicación de espera y añade el aviso con `addNotice` —**no** con `showUnavailable`, para no esconder el formulario—, compartiendo la función de aviso con el abandono de `poll()` a los 45 s ([contracts/web-chat-degraded.md](contracts/web-chat-degraded.md) §2)

**Checkpoint**: no queda ningún camino en el que el chat se quede indicando espera indefinidamente.

---

## Phase 6: User Story 4 - Ningún otro punto del sistema tiene el mismo defecto (Priority: P2)

**Goal**: cerrar los dos descuidos sistemáticos en **todos** los puntos donde pueden darse, no
solo donde se vieron, y dejar una prueba que lo vigile.

**Independent Test**: revisar el código y las pruebas con el criterio comprobable de FR-005 y
FR-007 y ver que ninguna búsqueda devuelve un punto sin tratar.

### Tests de la US4 ⚠️ primero, y deben fallar

- [x] T037 [P] [US4] Escribir `tests/unit/db/pool-listeners.test.ts`: prueba estática sobre los ficheros de `src/` que comprueba que **ninguna** construcción de `pg.Pool` ni de `pg.Client` queda sin su oyente de `error`, con la lista de los ocho puntos del inventario de research R1 como referencia y un mensaje de fallo que nombre el fichero y la línea del descuido (criterio verificable de **FR-005**)
- [x] T038 [P] [US4] Escribir en `tests/unit/config/secret-rules.test.ts` y `tests/unit/provisioning/fingerprint.test.ts` los casos con dirección **de autoridad sin servidor y con ruta de socket**: `urlPassword` devuelve la contraseña (y por tanto la regla de calidad se aplica), y `databaseIdentity`/`databasePassword` devuelven identidad y contraseña, con `host` igual a la ruta del socket y `port` 5432 (**FR-007**, SC-007)
- [x] T039 [P] [US4] Escribir en `tests/unit/provisioning/check.test.ts` que la regla que prohíbe el usuario `postgres` **se aplica** con una `DATABASE_URL` por socket, que es la forma en la que hoy se salta sin avisar

### Implementación de la US4

- [x] T040 [P] [US4] En `src/config/secret-rules.ts`, hacer que `urlPassword` use el parseo tolerante de `src/config/database-url.ts` en lugar de `new URL`, documentando en el comentario que con la forma de producción la regla no se aplicaba
- [x] T041 [P] [US4] En `src/provisioning/fingerprint.ts`, hacer que `parsePgUrl` use el parseo tolerante, de modo que `databaseIdentity` y `databasePassword` funcionen con socket; comprobar que la identidad solo viaja al inventario cifrado y que `instance:list` no la imprime (FR-012). Esta tarea es también la que hace pasar T039: la regla del usuario `postgres` de `src/provisioning/check.ts` se apoya en `databaseIdentity`, así que `instance:check` hereda la corrección sin tocar su fichero
- [x] T042 [P] [US4] En `src/backup/locks.ts`, mover `client.on('error', …)` a justo después de construir el cliente, antes de `connect()` y de la consulta del cerrojo, para que no quede ventana sin oyente
- [x] T043 [P] [US4] En `src/db/migrate.ts`, registrar `client.on('error', …)` en el cliente de `inspect`
- [x] T044 [US4] En `src/provisioning/database.ts`, dejar `parseAdminUrl` (línea 116) y el constructor de direcciones (línea 151) como están y ampliar sus comentarios para que digan explícitamente que **a propósito** solo trabajan con direcciones con nombre de servidor (`instance:db` necesita un servidor para construir la `DATABASE_URL`), y no por el descuido que se corrige en esta feature; así los dos quedan justificados en la auditoría de FR-007 en lugar de parecer puntos pendientes

**Checkpoint**: los dos descuidos están cerrados en todos sus puntos y hay una prueba que impide que vuelvan.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: versión, documentación y las dos casillas que quedaron bloqueadas en la fase 9.

- [x] T045 Subir la versión del núcleo de `0.1.0` a `0.1.1` en `package.json` (R10); comprobar que `readCoreVersion` y `/health` la reflejan y que no hace falta tocar `formatVersion`
- [x] T046 Ejecutar `pnpm lint && pnpm typecheck && pnpm test` y dejar todo verde
- [x] T047 Comprobar **SC-006** a mano: quitar el oyente de `error` del pool y ver que `tests/integration/db/outage.test.ts` falla por muerte del proceso; devolver `new URL` a la reconstrucción de direcciones y ver que falla la prueba de T004; restaurar las dos correcciones
  - **Hecho el 2026-10-09, los dos.** Sin el oyente del pool, `tests/integration/db/outage.test.ts`
    sale con **código 1** y siete errores `57P01` **no capturados** (`terminating connection due to
    administrator command`): en un proceso real, cada uno de esos es lo que lo mata; bajo Vitest
    quedan como errores del fichero y hacen fallar la corrida. Devolviendo `new URL` a
    `withDatabaseName`, caen **10 casos** de `tests/unit/config/database-url.test.ts` y **2** de
    `tests/integration/backup/verify-socket.test.ts`. Las dos correcciones restauradas y la suite
    de nuevo en verde.
- [ ] T048 Recorrer [quickstart.md](quickstart.md) de punta a punta en local (escenarios 1 a 5), incluido el corte a mano con `docker compose stop db`
- [x] T049 [P] Actualizar `docs/operacion-multicliente.md`: el estado `db_unavailable` de `/health` y qué significa para la sonda y para el reinicio; los tres motivos de `db:verify`; la §9.1 con la feature 016 y su fecha; la §9.2 con el orden de las propuestas pendientes; y marcar como hecha la propuesta que cubre
- [x] T050 **Avisar al usuario antes** y luego actualizar `README.md` con el estado de la feature 016 y la versión 0.1.1 (convención de CLAUDE.md)
- [x] T051 Desplegar la 0.1.1 en las dos instancias y repetir las dos casillas bloqueadas de la fase 9 (escenario 6 del quickstart): `db:verify` da **restaurable** en las dos (**SC-004**) y, con PostgreSQL parado al menos 5 minutos con la sonda del contenedor activa (umbral de SC-002), las dos siguen en `Up`, `/health` responde 200 con `db_unavailable` y el bot da el teléfono de emergencia por los dos canales. **Puerta obligatoria**: es la única verificación de la forma de dirección por socket Unix literal, porque no hay integración continua en Linux y T027 se salta en Windows (FR-006, SC-007)
- [x] T052 Anotar el resultado en `docs/plan-despliegue-produccion.md`: las dos casillas de la fase 9 desbloqueadas y el ciclo de actualización probado por primera vez sobre instancias en producción

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (fase 1)**: sin dependencias; se puede empezar ya.
- **Foundational (fase 2)**: **sin dependencias de la fase 1** —ninguna de sus tareas necesita contenedor: T003, T004 y T005 son puras y T006–T009 también—, así que las fases 1 y 2 pueden ir en paralelo. T001 solo lo necesitan las pruebas de integración de las fases 3 y 4. **Bloquea todas las historias.**
- **US1 (fase 3)** y **US2 (fase 4)**: las dos son P1 y dependen solo de la fase 2. US1 necesita además T001.
- **US3 (fase 5)**: depende de la fase 2 solo nominalmente; es la historia más independiente (vive en el frame y en su vista). Se puede sacar antes si estorba lo demás, como dice la assumption de la spec.
- **US4 (fase 6)**: depende de T007 (el parseo tolerante que reutiliza) y de que US1 haya fijado el criterio del oyente de `error`.
- **Polish (fase 7)**: depende de que las cuatro historias estén terminadas. T051 y T052 exigen además acceso al servidor de producción.

### User Story Dependencies

- **US1 (P1)**: sin dependencias de otras historias.
- **US2 (P1)**: sin dependencias de otras historias; comparte con ellas `withDatabaseName` (T007).
- **US3 (P2)**: independiente; es un defecto distinto que se arregla aquí para que el síntoma visible no vuelva por otro camino.
- **US4 (P2)**: generaliza lo que US1 y US2 corrigen en su punto concreto; va después por eso, no por una dependencia técnica.

### Within Each User Story

- Los tests se escriben primero y deben fallar antes de implementar.
- Clasificación y piezas puras antes de los módulos que las usan.
- Módulos de dominio antes de su conexión en `src/app.ts`.
- La historia se cierra antes de pasar a la siguiente prioridad.

### Parallel Opportunities

- T002 en paralelo con T001.
- Los tres tests de la fase 2 (T003, T004, T005) en paralelo entre sí.
- T007 en paralelo con T006 y T008 (fichero distinto).
- En la US1: T011–T015 en paralelo entre sí; luego T018, T020, T021, T024 y T025 en paralelo (ficheros distintos), mientras T016→T017 y T022→T023 van en cadena.
- En la US2: T026 y T028 en paralelo; T029 en paralelo con los tests.
- En la US3: T032 y T033 en paralelo; T035 en paralelo con T034.
- En la US4: T037, T038 y T039 en paralelo; después T040, T041, T042 y T043 en paralelo (cuatro ficheros distintos).
- US2 y US3 se pueden llevar en paralelo con US1 por personas distintas: no comparten ningún fichero.

---

## Parallel Example: User Story 1

```bash
# Primero, los tests de la US1 que no comparten fichero:
Task: "Casos de la regla nueva en tests/unit/health/report.test.ts"
Task: "Casos HTTP del estado nuevo en tests/contract/health.test.ts"
Task: "probeHealth con db_unavailable en tests/unit/cli/healthcheck.test.ts"
Task: "instance:versions con db_unavailable en tests/unit/provisioning/versions.test.ts"
Task: "Respuesta degradada en tests/unit/conversation/degraded-reply.test.ts"

# Después, la implementación que no comparte fichero:
Task: "db_unavailable y regla nueva en src/health/report.ts"
Task: "Salida 0 con db_unavailable en src/cli/healthcheck.ts"
Task: "statusSchema y etiquetas en src/provisioning/versions.ts"
Task: "Aviso al vigilante en src/channels/web/api.ts"
Task: "Aviso al vigilante en src/conversation/processor.ts"
```

---

## Implementation Strategy

### MVP First (US1)

1. Fase 1: los dos ayudantes de prueba.
2. Fase 2: clasificación, vigilante y reconstrucción de direcciones (**bloquea todo**).
3. Fase 3: US1.
4. **PARAR Y VALIDAR**: escenario 2 del quickstart. Si el chat responde con contacto, el proceso
   no se reinicia y `/health` da 200 con `db_unavailable`, el fallo grave está corregido y el
   Principio V vuelve a cumplirse.

### Entrega incremental

1. Fases 1 y 2 → base lista.
2. US1 → validar → **la caída total del servicio deja de ocurrir** (MVP).
3. US2 → validar → el operador puede confiar en sus copias; se desbloquea la casilla de la fase 9.
4. US3 → validar → el síntoma visible no volverá por otro camino.
5. US4 → validar → los dos descuidos quedan cerrados en todos sus puntos.
6. Fase 7 → 0.1.1, documentación y las dos casillas de producción.

### Si hay que recortar

US3 es la única candidata: la spec la mantiene en P2 «para que pueda separarse si estorba». US1,
US2 y US4 no se pueden separar sin dejar el fallo abierto en algún punto.

---

## Notes

- Las tareas [P] son ficheros distintos sin dependencias pendientes.
- La etiqueta [Story] traza cada tarea a su historia.
- Hay que ver cada test fallar antes de implementar: es lo que distingue estas pruebas de las que
  dejaron pasar los dos fallos, que simulaban el fallo justo donde el código lo esperaba.
- Commit por tarea o por grupo lógico.
- Se puede parar en cualquier checkpoint y validar la historia por separado.
