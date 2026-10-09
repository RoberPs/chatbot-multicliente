# Research: Resistencia a los cortes de la base de datos y verificación por socket

**Feature**: 016-db-outage-resilience · **Fecha**: 2026-10-09 · **Spec**: [spec.md](spec.md)

Todas las incógnitas quedan resueltas aquí. Cada decisión cita el código real que la motiva.

---

## R1 · Por qué un corte de la base de datos mata el proceso

**Hallazgo.** `createDb` (`src/db/client.ts:38`) crea el `pg.Pool` y **no registra ningún
oyente de `error`**. Un `pg.Pool` reemite como evento `error` el fallo de cualquier conexión
**ociosa** (las que no están atendiendo una consulta, y por tanto no tienen a quién rechazar la
promesa). En Node, un `EventEmitter` que emite `error` sin oyentes lanza la excepción: nadie la
recoge y el proceso termina. El arranque vuelve, no puede migrar, y se repite: bucle de reinicio.

La prueba de que es exactamente eso: el pool del sondeo de salud —escrito en la 009— **sí** lo
registra, con el comentario «Una conexión inactiva que se cae (BD parada) no debe tumbar el
proceso» (`src/health/report.ts:139`). La lección se aplicó allí y no en el pool del bot.

**Decisión.** `createDb` registra siempre `pool.on('error', …)`. El oyente no vuelve a lanzar:
entrega el error al vigilante de cortes (R3) y devuelve. Es un oyente del *pool*, no de la
consulta: quien tenga una consulta en vuelo sigue recibiendo su rechazo por la vía normal, que es
la que ya usan `isPoolBusy`, la 012 y el chat web.

**Alternativas descartadas.**

- `process.on('uncaughtException')` global: tapa cualquier fallo, no solo el de la BD, y deja el
  proceso en estado desconocido. Se rechaza por principio.
- Registrar el oyente en cada punto de uso (`startup`, CLI, migraciones): se olvida en el
  siguiente sitio, que es justo el error que se está corrigiendo (FR-005).

**Inventario completo de puntos que abren conexiones (criterio verificable de FR-005).**

| Punto | Hoy | Acción |
|---|---|---|
| `src/db/client.ts:39` `createDb` (pools principal, público y de migraciones) | **sin oyente** | añadir `pool.on('error')` → FR-001 |
| `src/health/report.ts:139` `createSchemaProbe` | con oyente | además, avisa al vigilante (R3) |
| `src/backup/locks.ts:21` `tryAdvisoryLock` | con oyente, pero **después** de `connect()` y de la consulta | mover el oyente justo tras construir el cliente |
| `src/backup/service.ts:91` `connect` | con oyente | sin cambios |
| `src/backup/service.ts:834` administración de `db:verify` | con oyente | sin cambios |
| `src/cli/backup-common.ts:152` `businessTimezone` | con oyente | sin cambios |
| `src/provisioning/database.ts:200` `connectPg` | con oyente | sin cambios |
| `src/db/migrate.ts:44` `inspect` | **sin oyente** | añadir `client.on('error')` |

La prueba de regresión del inventario es estática: una búsqueda de `new pg.Pool(` y
`new pg.Client(` en `src/` no devuelve ninguna construcción sin su oyente en las líneas
siguientes (test en `tests/unit/db/`).

---

## R2 · Cómo se reconoce «la base de datos no está»

**Decisión.** Función pura nueva `isDbUnavailable(error)` junto a `isPoolBusy`, que recorre la
cadena de causas igual que ella (hasta 5 niveles, por el envoltorio de Drizzle) y decide **por
código**, nunca por texto:

- errores de red de Node: `ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `EHOSTUNREACH`,
  `ENETUNREACH`, `ETIMEDOUT`, `EPIPE`, `ENOENT` (el socket local que ya no existe);
- SQLSTATE de la clase 08 (fallo de conexión): `08000`, `08001`, `08003`, `08004`, `08006`,
  `08007`, `08P01`;
- SQLSTATE `57P01` (`admin_shutdown`), `57P02` (`crash_shutdown`), `57P03`
  (`cannot_connect_now`): lo que manda PostgreSQL al pararse o mientras arranca;
- además, `isPoolBusy(error)`: el pool no dio conexión a tiempo, que durante un corte es el
  síntoma habitual desde el chat web.

**Rationale.** Es el mismo criterio que ya aplica `describeDatabaseError` (013): clasificar por
código y no por mensaje, para que el texto de PostgreSQL —que puede llevar host o base— no entre
nunca en una comparación ni en una salida (FR-012).

**Alternativa descartada.** Reutilizar `describeDatabaseError(...).reason === 'unreachable'`: ese
`unreachable` es el *caso por defecto* de la clasificación de TLS, así que devolvería «no
disponible» ante cualquier error desconocido. Aquí hace falta lo contrario: una lista cerrada.

---

## R3 · Registro del corte sin inundar el log (FR-014, SC-008)

**Decisión.** Módulo nuevo `src/db/outage.ts` con un vigilante de dos estados (`up`, `down`):

- `note(error)`: si `isDbUnavailable(error)` y el estado es `up`, pasa a `down` y registra
  **una vez** `db_outage_started`. Si ya está `down`, solo incrementa el contador del intervalo.
- Mientras está `down`, sondea `select 1` cada **10 s** sobre el pool principal. Al primer
  acierto vuelve a `up` y registra **una vez** `db_outage_recovered` con `durationMs` y
  `failures`.
- Cada **5 min** de corte registra un resumen `db_outage_ongoing` con `elapsedMs` y `failures`.

Cuentas: un corte de una hora deja 1 + 11 + 1 = **13 anotaciones**, no una por petición fallida
(SC-008). El sondeo cada 10 s encaja con los 30 s de SC-003.

**Quién lo alimenta.** Los tres oyentes de `error` de los pools (principal, público y del sondeo
de salud) y los puntos que ya capturan fallos de BD y responden degradado: el manejador de
errores del chat web (`src/channels/web/api.ts:126`), el camino degradado de la recepción (R5) y
`failed()` del procesador (`src/conversation/processor.ts:844`). No hace falta envolver cada
consulta: durante un corte real el pool emite el fallo de sus conexiones ociosas de inmediato.

**Eventos.** Se añaden al catálogo cerrado del registro de actividad, sin texto libre y sin URL
ni credenciales (FR-012). `logger` y reloj se inyectan; por defecto, silencioso, para que las
órdenes de `src/cli` que crean un pool no escriban nada inesperado.

**Alternativa descartada.** Deducir la recuperación de la primera consulta que vuelva a
funcionar: durante un corte largo puede no llegar ninguna petición, y entonces el registro nunca
diría que el servicio volvió. El sondeo propio da un instante de recuperación cierto y acotado.

---

## R4 · Qué responde `/health` durante el corte (FR-003)

**Hallazgo.** Hoy un corte da `status: 'degraded'` y **HTTP 503**
(`src/channels/health/routes.ts:63`), que es exactamente lo que dice una instancia con el esquema
equivocado. La sonda de la imagen (`src/cli/healthcheck.ts:31`) solo sale con 0 ante un 200, así
que el contenedor queda `unhealthy`. Docker no reinicia por `unhealthy` —está documentado en
`docs/operacion-multicliente.md`, paso 10 de la receta—, pero el resultado confunde dos
situaciones muy distintas y cualquier vigilante que se añada después sí reiniciaría.

**Decisión.** Valor nuevo de `HealthStatus`: **`db_unavailable`**, que responde **HTTP 200**.
La regla pasa a ser:

1. `not_ready` (503) si la instancia no está lista: arranque o cierre, como hasta ahora;
2. `db_unavailable` (**200**) si la base de datos **no contesta**: conexión imposible o sondeo
   fuera de plazo. El proceso vive y sirve; su base está caída y eso no es culpa suya;
3. `degraded` (503) si la base de datos **contesta pero mal**: vacía, con una migración
   desconocida o con un esquema distinto del esperado. Eso necesita al operador;
4. `ok` (200) en el resto.

Es la lectura de la clarificación: «responde correctamente (proceso vivo, no reiniciable) e
informa del estado degradado de la base de datos en su contenido». Durante el corte
`schema.applied` sigue siendo `null` y `spendCap`, `null`, como hoy.

**Lo que arrastra.** El valor nuevo toca cuatro ficheros y dos contratos: `src/health/report.ts`
(regla y vistas), `src/channels/health/routes.ts` (el código 200), `src/cli/healthcheck.ts` (sale
con 0 también con `db_unavailable`) y `src/provisioning/versions.ts`, cuyo esquema Zod es un
`enum` estricto con `codeMatches` (`ok` → 200) y una tabla de etiquetas; sin tocarlo,
`instance:versions` daría `invalid_response` en toda instancia con la base caída.

**Alternativa descartada.** Mantener `status: 'ok'` y añadir un campo `database`. El nivel
público se valida con `z.strictObject({ status })` en `versions.ts`, así que también habría que
cambiarlo, y además una instancia sin base de datos no está «ok»: le diría a un vigilante que
todo va bien.

**FR-012.** El nivel sin credencial pasa de decir `degraded` a decir `db_unavailable`: es un
grado más de detalle sobre un estado que ya era público, y no lleva host, base ni credencial.

---

## R5 · Respuesta al cliente final durante el corte, canal por canal (FR-002)

**Chat web: ya está escrito y nunca se ejecuta.** `POST /chat/api/messages` envuelve la recepción
y, si falla, responde **503 con el objeto `unavailable`** y el contacto de emergencia
(`src/channels/web/api.ts:302-305`); `frame.js` lo pinta porque su último caso es «si la
respuesta trae `unavailable`, muéstralo». El cliente final no lo ve solo porque el proceso muere
antes (R1). No hay que escribir respuesta nueva: hay que **probarla con la base de datos
realmente parada** (R9).

**WhatsApp: falta el camino.** `onInbound` es `channel.intake.handle` (`src/app.ts:364`); si
guardar falla, el error sube, el webhook responde 503 (`src/channels/whatsapp/webhook.ts:106`) y
Meta reintenta. El cliente **no recibe nada**. Y toda la maquinaria de la 012 que daría la
disculpa —`failed()`, `abandon()`, `deliver()`— necesita la base de datos para contar intentos,
leer pendientes y registrar el saliente: con la base caída no puede dar ni un paso.

**Decisión.** Módulo nuevo de dominio `src/conversation/degraded-reply.ts`, sin HTTP, que
envuelve la recepción de cualquier canal:

1. intenta `intake.handle(events)`;
2. si lanza y `isDbUnavailable(error)`, avisa al vigilante (R3) y, por cada cliente del lote que
   no haya recibido ya el aviso en este corte, envía por el remitente del canal
   `errorReply(form)` + `emergencyContact(phone)` —las plantillas que ya existen
   (`src/conversation/templates.ts:116` y `:152`)— con `form = 'tu'`, porque sin base de datos no
   hay `addressForm` y ese es el valor por omisión documentado;
3. registra el envío con el seudónimo del cliente, nunca su número;
4. **vuelve a lanzar**, para que el webhook siga respondiendo 503 y Meta reintente: si la base
   vuelve dentro de la ventana de reintentos, el mensaje se procesa y se responde de verdad.

La memoria del aviso es un conjunto en memoria por `channelUserId`, que se vacía al registrar la
recuperación. Así no se repite el aviso en cada reintento de Meta ni en cada mensaje del corte
(FR-014), y si el corte vuelve más tarde, se avisa otra vez.

Si la instancia no tiene teléfono de emergencia configurado o el canal no tiene remitente, no hay
nada que enviar: se registra y se sigue. El chat web no pasa por este envoltorio, porque su
respuesta viaja en el 503 de su propia petición.

**Alternativa descartada.** Responder 200 al webhook tras enviar la disculpa. Meta no
reintentaría y el mensaje del cliente se perdería para siempre: se cambiaría una pérdida de datos
por una disculpa, cuando se pueden tener las dos cosas.

---

## R6 · Reconstruir una dirección de base de datos por socket (FR-006, FR-007)

**Hallazgo.** `withDatabase` (`src/backup/service.ts:721`) hace `new URL(url)` y le cambia el
`pathname`. Con la forma de producción —`postgres://usuario:clave@/base?host=/var/run/postgresql`,
sin nombre de servidor— `new URL` **lanza**. La excepción salta dentro del `try` del paso
siguiente y se traduce a `verify_db_unavailable` (`src/backup/service.ts:858`), cuyo texto es «no
se pudo crear la base de datos temporal»: justo el paso que **sí** había funcionado. De ahí el
mensaje que despista, y el rastro se borra porque el `finally` borra la base temporal.

El propio núcleo ya conoce la limitación y la rodea en `src/config/database-url.ts:32-45`, donde
`parse()` reintenta con un servidor ficticio. El código de las copias se quedó fuera.

**Decisión.** Función pura nueva en `src/config/database-url.ts` —el módulo que ya es la única
autoridad sobre las direcciones de base de datos—:

```text
withDatabaseName(url: string, database: string): string | null
```

Devuelve la misma dirección con otra base, conservando credenciales, servidor (o su ausencia),
puerto y **todos** los parámetros, incluidos `host`, `sslmode` y `sslrootcert`; `null` si la
dirección no se puede interpretar. `verifyBackup` la usa y, si devuelve `null`, el motivo es el de
dirección inválida (R7), no el de crear la base.

**Auditoría de los demás puntos que interpretan una dirección (criterio de FR-007).**

| Punto | Comportamiento con socket | Acción |
|---|---|---|
| `src/backup/service.ts:721` `withDatabase` | **lanza** | sustituir por `withDatabaseName` |
| `src/config/secret-rules.ts:113` `urlPassword` | `new URL` lanza → `null`: **la regla de calidad de la contraseña no se aplica nunca en producción** | usar el parseo tolerante |
| `src/provisioning/fingerprint.ts:74` `parsePgUrl` → `databaseIdentity`, `databasePassword` | `null`: la identidad y la huella de la BD quedan vacías y, con ellas, la regla de `instance:check` que prohíbe el usuario `postgres` (`check.ts:181`) | usar el parseo tolerante; con socket, `host` es la ruta del socket y `port`, 5432 |
| `src/provisioning/database.ts:116` `parseAdminUrl` | `null` **a propósito**: `instance:db` necesita un servidor para construir la `DATABASE_URL` | se mantiene, con su comentario |
| `src/config/env.ts:31` `publicOrigin`, `:266` `isSmtpUrl` | no son direcciones de base de datos | sin cambios |
| `tests/helpers/global-setup.ts:20`, `tests/helpers/db.ts:24` | solo direcciones con servidor | sin cambios |

Los dos hallazgos del medio no son cosméticos: son dos comprobaciones de seguridad que en el
despliegue real nunca se han ejecutado. Ninguna salida nueva muestra la ruta del socket (FR-012):
la identidad de la base de datos solo viaja al inventario, que está cifrado.

---

## R7 · Motivos distinguibles en `db:verify` (FR-008)

**Decisión.** `verify_db_unavailable` se divide en tres códigos de `RestoreFailureCode`, cada uno
con su texto en `src/cli/backup-common.ts`:

| Código | Cuándo | Texto corto |
|---|---|---|
| `verify_url_invalid` | `BACKUP_VERIFY_URL` no se puede interpretar o `withDatabaseName` devuelve `null` | `BACKUP_VERIFY_URL no se puede interpretar` |
| `verify_db_unavailable` | no se puede **conectar** con el servidor de verificación | `no se pudo conectar con el servidor de verificación` |
| `verify_db_create_failed` | se conecta, pero falla `create database` o el `revoke` | `no se pudo crear la base de datos temporal` |

Además, el `catch` que hoy convierte cualquier fallo del `create` en `verify_db_unavailable`
(`src/backup/service.ts:851`) deja de tragarse el error: se clasifica con `connectFailure`, igual
que los demás, para que un fallo de TLS siga teniendo su código propio (013). Un fallo **de la
copia** (dañada, clave ajena, recuentos que no cuadran) conserva sus códigos y no se mezcla con
ninguno de los tres: eso es lo que pide FR-008 y lo que comprueba el escenario US2-2.

---

## R8 · El chat web no se queda colgado (FR-009, FR-013)

**Hallazgo 1.** `send()` pone «escribiendo…» antes de enviar (`frame.js:413`) y su cadena de
casos termina en `if (res.data && res.data.unavailable) showUnavailable(...)`. Ante un 500 de la
instancia o un 502 del proxy —cuerpo que no es JSON, así que `res.data` es `{}`— no entra en
ningún caso: el indicador se queda puesto para siempre. El `.catch` del `submit` solo cubre un
fallo de red, no una respuesta de error.

**Hallazgo 2.** El contacto que pinta la interfaz vive en `state.contact`, que se rellena desde
`GET /state` (`frame.js:214`). Si el servidor no contesta, no hay contacto que enseñar.

**Decisiones.**

1. **Caso final explícito** en `send()`: cualquier respuesta que no encaje en los casos conocidos
   deja de indicar espera y añade el aviso con el contacto. Se usa `addNotice`, **no**
   `showUnavailable`, para no esconder el formulario: así el cliente puede volver a escribir
   cuando el servicio vuelva (US3-2). El aviso se da una vez por fallo, sin repetirse en bucle.
2. **Plazo de guardia.** `poll()` ya abandona a los 45 s (`GIVE_UP_MS`) con el mismo aviso; se
   mantiene y pasa a compartir la función de aviso con el caso nuevo.
3. **El contacto viaja en la página** (FR-013). `/chat/frame` ya calcula el contacto que
   corresponde —`lastContact`, que es el del negocio si se pudo leer el snapshot y el teléfono de
   emergencia si no (`src/channels/web/routes.ts:102-107`)—. Se añade a la vista como atributo de
   datos en `<html>`, escapado por Eta, y `frame.js` lo lee de `document.documentElement.dataset`
   al arrancar, antes de cualquier petición. `GET /state` sigue pudiendo refinarlo; si no
   contesta, el de la página sirve.

`frame.js` no construye HTML en ningún caso: el aviso se pinta con `textContent`, como todo lo
demás (garantía 9 de la 004).

---

## R9 · La prueba que corta la base de datos de verdad (FR-010)

**Problema.** Parar el contenedor de Testcontainers y volver a arrancarlo **cambia el puerto
publicado en el equipo**, así que la dirección de la instancia dejaría de valer y la prueba no
podría comprobar la recuperación (FR-004) con el mismo proceso.

**Decisión.** El contenedor **no se para**: se para PostgreSQL **dentro** de él.

```text
container.exec(['su', '-c', 'pg_ctl -D /var/lib/postgresql/data -m fast stop', 'postgres'])
…
container.exec(['su', '-c', 'pg_ctl -D /var/lib/postgresql/data start', 'postgres'])
```

Cumple FR-010 al pie de la letra —es el servidor el que deja de estar, no un error inyectado en
la capa de datos—, mantiene puerto y dirección, y es casi instantáneo en los dos sentidos.

**Aislamiento.** Contenedor propio, levantado y parado por la propia prueba
(`tests/helpers/own-postgres.ts`, al estilo de `tests/helpers/tls-postgres.ts`), nunca el de
`global-setup.ts`, que comparten las demás pruebas. Va en `tests/integration/`, con lo que entra
en `pnpm test` como pide la clarificación. El proyecto `integration` ya tiene
`fileParallelism: false`, así que no hay riesgo de cruce.

**Qué comprueba** (FR-001 a FR-004 y SC-001 a SC-003), con la instancia real levantada por
`startInstance`:

1. con la base parada, `POST /chat/api/messages` responde con aviso y contacto en menos de 10 s;
2. el proceso sigue vivo: la misma instancia responde a la petición siguiente;
3. `GET /health` responde **200** con `db_unavailable`;
4. un mensaje de WhatsApp durante el corte provoca el envío de la disculpa con contacto por el
   remitente de prueba;
5. al arrancar PostgreSQL, la instancia vuelve a atender **sin reiniciar** y la sesión del panel
   abierta antes del corte sigue valiendo;
6. el registro tiene exactamente una anotación de inicio y una de recuperación.

**SC-006** (que las pruebas sirvan de verdad) se comprueba revirtiendo cada corrección: sin el
oyente de `error` del pool, la prueba del corte cae por muerte del proceso; con `new URL` de
vuelta en `withDatabase`, cae la prueba unitaria de socket de FR-011, que no necesita base de
datos.

---

## R10 · Versión, despliegue y alcance

- **Sale la 0.1.1**: `package.json` pasa de `0.1.0` a `0.1.1`, imagen nueva y actualización de
  las dos instancias desplegadas. Es la primera prueba real del ciclo de actualización.
- **Sin migración**: no cambia el esquema, así que `formatVersion`
  (`src/config-transfer/format.ts`) **no sube** y no hay actualizador nuevo.
- **Sin cambios de configuración**: ninguna instancia desplegada toca su fichero de entorno.
- **Al cerrar** se repiten las dos casillas bloqueadas de la fase 9 (comprobación de copias y
  teléfono de emergencia mostrado por el bot) y se actualizan `README.md` y
  `docs/operacion-multicliente.md` (§9.1 con fecha, §9.2, y las secciones de operación que
  cambian: el estado `db_unavailable` de `/health` y los motivos de `db:verify`).
