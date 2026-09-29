# Research: Copias de seguridad y restauración por instancia

**Feature**: `006-instance-backup-restore` | **Plan**: [plan.md](plan.md) | **Spec**: [spec.md](spec.md)

Decisiones técnicas para copiar, restaurar, comprobar y caducar la base de datos de una instancia.
Parte del código actual: `runMigrations` (`src/db/migrate.ts`) aplica las migraciones de Drizzle al
arrancar el servidor y con `pnpm db:migrate`; `createRetention` (`src/conversation/retention.ts`)
borra las conversaciones de más de 30 días al arrancar el bot y cada hora; la imagen es
`node:22-slim`, sin cliente de PostgreSQL; el desarrollo se hace también en Windows y las pruebas
de integración usan Testcontainers. Cada decisión sigue el formato Decisión / Motivo /
Alternativas.

---

## R1. Cómo se vuelca la base de datos: volcado lógico de datos en Node, esquema desde las migraciones

**Decisión**: la copia guarda **solo los datos** de todas las tablas de los esquemas `public` y
`drizzle`, con `COPY … TO STDOUT` en formato texto (dependencia nueva: **`pg-copy-streams`**, del
mismo autor que `pg`), más los valores de las secuencias y la **versión del esquema**. No guarda
DDL. Al restaurar, el esquema se reconstruye aplicando las migraciones del propio núcleo hasta la
versión de la copia (R5) y después se cargan los datos con `COPY … FROM STDIN`.

**Motivo**:

- Sin binarios externos: funciona igual en la imagen `node:22-slim`, en Windows y con
  Testcontainers (el runner no tiene `pg_dump`).
- El esquema restaurado es exactamente el que producen las migraciones del núcleo para esa
  versión, así que la instancia arranca después con las migraciones normales (US2-3) sin objetos
  sobrantes.
- `COPY` en texto reproduce sin pérdidas `jsonb`, `enum`, `timestamptz`, `time`, arrays y `bytea`,
  a diferencia de un `SELECT` convertido a JSON.
- Todo el ciclo de restauración cabe en **una transacción** de una única conexión de `pg`
  (FR-011), sin coordinar un proceso externo.
- Las copias no llevan propietarios ni permisos, así que se pueden restaurar en otra instancia o
  en una BD temporal con otro usuario (FR-010, FR-021).

**Alternativas**:

- `pg_dump`/`pg_restore` por `child_process`: robusto y estándar, pero exige instalar
  `postgresql-client-16` (repositorio PGDG) en la imagen y en cada equipo de desarrollo, versión
  del cliente ≥ servidor, y la atomicidad de la restauración con `--clean` deja objetos de
  versiones posteriores sin borrar. Descartado por el coste en Windows y en Testcontainers.
- `pg_dump` ejecutado dentro del contenedor de la BD (`docker exec`): acopla el núcleo al
  despliegue; en un PostgreSQL gestionado no existe.
- Instantáneas del proveedor: no son del núcleo ni iguales para todas las instancias (FR-023);
  quedan como complemento de la plataforma (Assumptions).

---

## R2. Coherencia de un único instante y recuento en la misma foto

**Decisión**: la copia abre una transacción `REPEATABLE READ READ ONLY` y dentro de ella lee la
versión del esquema, cuenta las filas de cada tabla, lee las secuencias y hace un `COPY` por tabla.
Todo sale de la misma instantánea MVCC (FR-002), sin bloquear escrituras del bot (solo toma
`ACCESS SHARE`).

**Motivo**: es el mismo mecanismo que usa `pg_dump`; ya se usa en el núcleo para leer el snapshot
del conocimiento (`withReadSnapshot`). El bot sigue atendiendo durante la copia (US1-2, SC-001).

**Alternativas**: `SERIALIZABLE READ ONLY DEFERRABLE` (puede esperar sin necesidad); tabla por
tabla en transacciones separadas (incoherente).

---

## R3. Cifrado: AES-256-GCM por bloques con cabecera autenticada

**Decisión**: formato propio `CBAK` versión 1 ([contracts/backup-file-format.md](contracts/backup-file-format.md)):

- `BACKUP_KEY`: 32 bytes aleatorios en hex, distinta por instancia y distinta de `SESSION_SECRET`.
- Por fichero, una sal aleatoria de 16 bytes; clave del fichero = HKDF-SHA256(`BACKUP_KEY`, sal,
  `"chatbot-backup/v1/data"`). Un `keyId` = 8 primeros bytes de HKDF(`BACKUP_KEY`, sin sal,
  `"chatbot-backup/v1/key-id"`) permite decir "la clave no corresponde a esta copia" sin revelarla.
- Cabecera en claro (JSON): formato, instancia, versión del esquema, versión del núcleo, fecha,
  motivo, recuento por tabla, sal y `keyId`. Sin datos personales.
- Contenido: el volcado de R1 comprimido con gzip, partido en bloques de 64 KiB; cada bloque va
  cifrado con AES-256-GCM, nonce = contador de 11 bytes + 1 byte de "último bloque", y AAD =
  SHA-256 de la cabecera. Así la cabecera queda protegida contra manipulación (FR-005), cualquier
  cambio de un bloque se detecta en ese bloque y un fichero truncado o con bloques reordenados se
  rechaza (falta el bloque final o no cuadra el contador).

**Motivo**: GCM en un único flujo solo verifica la etiqueta al final, cuando ya se ha entregado
texto sin autenticar; por bloques cada fragmento se verifica antes de usarse. La cabecera en claro
permite a la retención (R8) identificar las copias propias sin la clave; su autenticidad se
comprueba descifrando el primer bloque. Todo con `node:crypto` y `node:zlib`, sin dependencias.

**Alternativas**: `age`/`gpg` (binarios externos, R1); libsodium `secretstream` (dependencia
nativa para lo mismo); cifrar el fichero entero en memoria (válido hoy por tamaño, pero sin margen
y con todo el texto en claro en memoria).

---

## R4. Clave nueva y claves anteriores

**Decisión**: `BACKUP_KEY` cifra siempre las copias nuevas. `BACKUP_KEYS_PREVIOUS` (opcional,
lista separada por comas) solo se usa para **leer**: restaurar y comprobar prueban la clave cuyo
`keyId` coincide con la cabecera. Sin ninguna clave que coincida, el error dice "la copia se hizo
con otra clave" y el `keyId` de la cabecera, nunca la clave.

**Motivo**: cubre el caso límite "se cambia la clave" (las copias antiguas siguen necesitando la
anterior hasta que caducan, como mucho 30 días) sin recifrar nada.

**Alternativas**: recifrar las copias al rotar (más código y riesgo para algo que caduca solo);
exigir que el operador pase la clave antigua por argumento (acabaría en el historial del shell).

---

## R5. Versión del esquema y migraciones hasta una versión concreta

**Decisión**: la versión del esquema es la **última migración aplicada**, identificada por su
índice y etiqueta del journal de Drizzle (`0004_handoff`) y su hash. Se lee de
`drizzle.__drizzle_migrations` (`created_at` = `folderMillis` del journal, como hace el migrador de
Drizzle) y se cruza con `readMigrationFiles()` de `drizzle-orm/migrator`.

Un módulo `src/backup/schema-version.ts` ofrece:

- `installedSchema()`: última migración del núcleo instalado.
- `databaseSchema(tx)`: última aplicada en la BD, o `empty` si no existe la tabla de migraciones o
  no tiene filas.
- `pendingMigrations(tx)`: las del journal con `folderMillis` mayor que la última aplicada (misma
  regla que `PgDialect.migrate`).
- `applyMigrationsUpTo(tx, index)`: ejecuta en la transacción recibida los SQL de las migraciones
  `0..index` e inserta sus filas en `drizzle.__drizzle_migrations` con el mismo hash y
  `created_at` que escribiría Drizzle, de modo que al arrancar el migrador normal solo aplica las
  siguientes.

Al restaurar se exige que la migración de índice N de la copia exista en el núcleo instalado
**con el mismo hash**; si el índice es mayor que el último instalado, se rechaza e indica la
versión del núcleo de la copia (US2-4); si el hash no coincide, se rechaza como "copia de un núcleo
con migraciones distintas".

**Motivo**: las migraciones son de solo añadir (docs/operacion-multicliente.md §5), así que
cualquier versión igual o posterior del núcleo puede reconstruir el esquema de una copia anterior,
y la versión anterior del núcleo puede reconstruir el de su copia previa a la migración (FR-017).
Reutilizar `readMigrationFiles` garantiza los mismos hashes que Drizzle.

**Alternativas**: número de versión propio en una tabla nueva (duplicaría lo que Drizzle ya
guarda); comparar solo el número de migraciones (no detecta ramas distintas).

---

## R6. Restauración total o nula

**Decisión**: `restoreBackup` hace dos pasadas sobre el fichero:

1. **Comprobación previa** (sin tocar la BD): cabecera válida, clave que coincide, todos los
   bloques descifran y el volcado se puede leer entero hasta el registro final; instancia de
   origen (R7) y versión del esquema (R5) aceptables. Cualquier fallo termina aquí (FR-009,
   US2-6).
2. **Restauración** en **una transacción** sobre una conexión:
   - `SET LOCAL lock_timeout = '5s'`.
   - Vacía los esquemas `public` y `drizzle` (borra tablas, secuencias y tipos que contienen, sin
     borrar los esquemas, para no depender de su propietario).
   - `applyMigrationsUpTo(tx, N)` y comprueba que las tablas del esquema reconstruido son las de la
     cabecera.
   - Carga cada tabla con `COPY FROM STDIN` en orden de dependencias (calculado del catálogo
     `pg_constraint`) y fija las secuencias con `setval`.
   - Comprueba que el recuento por tabla coincide con la cabecera.
   - `COMMIT`. Ante cualquier error, incluido un bloque dañado en la segunda pasada, `ROLLBACK`
     (FR-011, US2-7, SC-008).

**Nota de implementación**: en lugar de ordenar la carga por dependencias (el volcado va en
orden alfabético y reordenarlo exigiría leer el fichero varias veces o guardarlo en memoria), la
transacción quita las claves ajenas de `public` y `drizzle` antes de cargar y las vuelve a crear
con su definición exacta (`pg_get_constraintdef`) al final, lo que las **valida** contra los datos
cargados. Es lo que hace `pg_restore` (restricciones en la fase posterior a los datos). Tras
reconstruir el esquema se vacían también las filas que insertan las propias migraciones
(`web_chat_settings`, `handoff_alerts`, `__drizzle_migrations`) para cargar las de la copia.

La restauración **no** aplica migraciones posteriores ni cambia el estado del negocio o de los
canales (FR-013): la instancia queda con el esquema de la copia y las migraciones pendientes se
aplican al arrancar, con su copia previa (US2-3). Tampoco pasa por la escritura protegida
(FR-032): no recalcula avisos ni revierte por un aviso crítico; ver plan, Consecuencias.

**Motivo**: en PostgreSQL el DDL es transaccional, así que vaciar, reconstruir y cargar en una
transacción es todo o nada. La primera pasada evita empezar con una copia que se sabe mala.

**Alternativas**: restaurar en una BD nueva y renombrarla (exige `CREATEDB` y desconectar a todos,
y cambia la BD a la que apunta `DATABASE_URL`); `TRUNCATE` + carga sin reconstruir el esquema (no
sirve para copias de un esquema anterior).

---

## R7. Instancia parada, una operación a la vez y copia de otra instancia

**Decisión**: bloqueos consultivos (`pg_try_advisory_lock`) de sesión en la BD de la instancia, con
dos claves constantes del núcleo:

- **Instancia en marcha**: el servidor lo toma al arrancar, antes de migrar, en una conexión
  propia que mantiene mientras vive. `pnpm db:restore` intenta tomarlo; si no puede, responde "la
  instancia está en marcha: párala antes de restaurar" (FR-008). Mientras restaura lo mantiene,
  así que un servidor que arranque a la vez se detiene con "restauración en curso".
- **Copia en curso**: lo toma cada copia (bajo demanda, previa o periódica). Si otra copia lo
  tiene, la nueva se rechaza con "ya hay una copia en curso" (caso límite); la periódica lo
  registra y lo reintenta en la siguiente pasada del programador (R10).

Restaurar una copia cuya cabecera tiene otro `instanceId` exige `--from-instance <id>` con el
mismo identificador que la cabecera (FR-010); sin él, o con otro valor, se rechaza en la
comprobación previa.

**Motivo**: los bloqueos consultivos son por base de datos (por instancia), los ve cualquier
proceso que se conecte (servidor y comandos) y se liberan solos si el proceso muere.

**Alternativas**: fichero de bloqueo en disco (no lo ve un servidor en otra máquina con la misma
BD y queda huérfano si el proceso muere); comprobar `pg_stat_activity` (depende del
`application_name` y de permisos).

---

## R8. Nombre, escritura atómica y retención

**Decisión**:

- Nombre: `<instancia>__<esquema>__<AAAAMMDDTHHMMSSZ>__<motivo>.cbak`, p. ej.
  `demo-01__0004_handoff__20260929T101500Z__manual.cbak`. La fecha del nombre va en UTC (marca
  técnica, como `updated_at`; no es un horario del negocio). Motivos: `manual`, `premigration`,
  `daily` (FR-004).
- Escritura atómica: se escribe `.<nombre>.partial` en el mismo directorio, `fsync`, y se
  renombra al nombre final solo al terminar bien. Si falla, se borra el parcial; un parcial
  huérfano nunca coincide con el patrón de copia (FR-006) y la siguiente copia de la misma
  instancia borra los suyos de más de 1 hora.
- Retención (`applyRetention`): lista el directorio, se queda con los ficheros que cumplen el
  patrón **y** cuya cabecera se lee y tiene el `instanceId` de la instancia (FR-020; un fichero
  ajeno o con nombre parecido se ignora). La antigüedad se toma de la fecha de la cabecera, no del
  nombre ni de `mtime`. Borra las de más de `BACKUP_RETENTION_DAYS` días salvo la más reciente
  **válida** (cabecera autenticada con alguna clave configurada; FR-019). Se aplica tras cada copia
  que termina bien y en cada pasada diaria del programador (R10). Las previas a migración siguen
  la misma regla (US4-4).

**Motivo**: el nombre sirve al operador; la cabecera, al código (FR-005). Renombrar en el mismo
sistema de ficheros es atómico.

**Alternativas**: índice de copias en la BD de la instancia (se restauraría con la propia copia y
quedaría desfasado); borrar por `mtime` (cambia al copiar el directorio a otro sitio).

---

## R9. Copia previa a las migraciones

**Decisión**: `runMigrations` recibe un `BackupGuard` opcional. Antes de llamar a `migrate()`:

1. Lee `databaseSchema` y `pendingMigrations`.
2. BD vacía (sin tabla de migraciones o sin filas) o sin pendientes → migra como hasta ahora, sin
   copia (FR-016).
3. Con datos y pendientes → hace una copia con motivo `premigration` y la versión actual del
   esquema. Si no hay `BackupGuard` (configuración de copias incompleta) o la copia falla, lanza
   `MigrationBlockedError` con el motivo, sin migrar (FR-015). El servidor registra el evento, sale
   con código ≠ 0 y no escucha; `pnpm db:migrate` igual.
4. Tras la copia, `migrate()` aplica todas las pendientes en una transacción (comportamiento de
   Drizzle). Si falla, el error lleva el nombre de la copia previa para restaurarla con la versión
   anterior del núcleo (US3-5).

El servidor toma el bloqueo de "instancia en marcha" (R7) antes de todo esto.

**Motivo**: es el único punto por el que pasan todas las migraciones; la plantilla de tests
(BD vacía) sigue migrando sin configuración de copias.

**Alternativas**: un paso aparte del despliegue (`pnpm db:backup && node server`) — se olvida y
no bloquea; copia en cada arranque (FR-016 lo prohíbe y gasta disco).

---

## R10. Copia diaria: programador en el servidor

**Decisión**: `createBackupScheduler` en el servidor (independiente de que haya bot), que al
arrancar y cada 60 s decide con una función pura `dueDailyBackup(now, timezone, dailyTime,
lastDaily, failedOn)`:

- La zona horaria es la del negocio (`business.timezone`, leída en cada pasada); la hora,
  `BACKUP_DAILY_TIME` (`HH:MM`, por defecto `03:00`) en hora local, sin pasar a UTC.
- Toca copia si la hora local ya ha pasado la hora configurada y no hay en el directorio una copia
  `daily` de la instancia cuya fecha de cabecera caiga en el día local de hoy. Cubre el arranque
  tardío (FR-027) y garantiza como mucho una al día; el directorio es la única fuente de verdad.
- Si falla, registra `backup_failed` (sin datos personales) y marca el día local en memoria para no
  reintentar hasta el día siguiente, que es "la siguiente ocasión prevista" (US6-3, FR-028).
  **Excepción: si falla con `busy` (otra copia en curso, R7), no marca el día y se reintenta en la
  siguiente pasada (60 s).** Un reinicio ese mismo día vuelve a intentarlo, porque cuenta como
  arranque tardío.
- Tras cada copia diaria correcta y en la pasada de la hora configurada, aplica la retención.
  Aunque la copia falle, la pasada aplica la retención, para liberar espacio cuando el fallo es
  `no_space`.
- Días de cambio de hora: si la hora configurada no existe ese día (salto de primavera), la copia
  se hace en el primer minuto posterior; si se repite (otoño), la regla "una al día" evita dos.

**Motivo**: mismo patrón que la retención de conversaciones y el barrido de derivaciones (temporizador
en proceso, parado en el cierre ordenado). La copia no bloquea el bucle de eventos: todo es
flujo asíncrono de `COPY`, gzip y cifrado por bloques.

**Alternativas**: cron del sistema o de la plataforma (no es igual en todas las instancias ni lo
controla el núcleo); guardar la última copia en la BD (se restauraría con la copia).

---

## R11. Conversaciones caducadas tras restaurar

**Decisión**: el servidor, antes de `app.listen`, ejecuta y **espera** una pasada del borrado de
conversaciones de 30 días (`createRetention(...).purge()`), haya o no bot configurado. El
temporizador horario sigue como hasta ahora. `pnpm db:restore` informa además de cuántas
conversaciones restauradas superan ya los 30 días y se borrarán al arrancar.

**Motivo**: la restauración deja el esquema de la copia, que puede ser anterior al del núcleo;
borrar con las consultas del núcleo antes de migrar no es seguro. Tras migrar, el servidor aún no
escucha: ni el bot ni el panel pueden ver esas conversaciones (FR-012, SC-005). Además cubre una
instancia parada más de 30 días, que hoy podría atender unos segundos con conversaciones caducadas.

**Alternativas**: borrar dentro de la transacción de restauración con SQL escrito para cada versión
del esquema (acoplado a columnas antiguas); dejarlo al temporizador horario (el procesador empieza
antes de la primera pasada).

---

## R12. Comprobación en un espacio temporal

**Decisión**: `pnpm db:verify <fichero>` crea una base de datos temporal `verify_<16 hex>` en el
servidor PostgreSQL de `BACKUP_VERIFY_URL` (por defecto, el de `DATABASE_URL`), restaura en ella con
el mismo código de R6, cuenta las filas, comprueba que coinciden con la cabecera y la borra en un
`finally` (también si falla). Nunca abre conexión con la BD de la instancia salvo para crear y
borrar la temporal desde la BD de mantenimiento indicada en la URL. El informe
([contracts/backup-commands.md](contracts/backup-commands.md)) dice restaurable o no y por qué, con
versión del esquema, fecha y elementos por tabla (FR-021).

Requiere un usuario con `CREATEDB` en ese servidor. En producción no se concede a la instancia: el
operador comprueba desde su instancia de pruebas o su equipo (Docker Compose local) con el
fichero y la clave, que es además el ciclo de la guía de validación (FR-022).

**Motivo**: restaurar de verdad es la única forma de saber que se puede restaurar; una BD separada
no bloquea ni toca la instancia en producción (US5-3).

**Alternativas**: restaurar en la BD de la instancia dentro de una transacción que se revierte
(bloquea todas las tablas durante la prueba); comprobar solo el descifrado (no prueba la carga).

---

## R13. Configuración y fallos

**Decisión**: variables nuevas de la instancia ([data-model.md](data-model.md#configuración-de-copias)):
`INSTANCE_ID`, `BACKUP_DIR`, `BACKUP_KEY`, `BACKUP_KEYS_PREVIOUS`, `BACKUP_RETENTION_DAYS`
(1–30, por defecto 7; fuera de rango se rechaza al arrancar y al pedir una copia), `BACKUP_DAILY_TIME`
(por defecto `03:00`) y `BACKUP_VERIFY_URL`.

- `NODE_ENV=production`: `INSTANCE_ID`, `BACKUP_DIR` y `BACKUP_KEY` son obligatorias; la instancia
  no arranca sin ellas.
- `development`/`test`: opcionales; sin ellas no hay copia diaria (se registra una vez
  `backup_disabled`) y una migración pendiente con datos bloquea el arranque con "falta la
  configuración de copias" (fail-closed, FR-015).
- Antes de escribir, la copia comprueba que el directorio existe, es un directorio y es escribible
  (FR-025). Los errores de sistema se traducen a códigos cerrados: `key_missing`, `key_invalid`,
  `dir_missing`, `dir_not_writable`, `no_space`, `busy`, `db_error`, `io_error`.

**Motivo**: las mismas reglas de Zod de `src/config/env.ts`; en producción la red es obligatoria,
en desarrollo no obliga a crear claves para trabajar con BD vacías.

**Alternativas**: obligatorias siempre (rompe los tests y el primer arranque local sin aportar
nada); configurables en el panel (el operador no las debe ver en el navegador y la clave no puede
vivir en la BD que cifra).

---

## R14. Registros técnicos

**Decisión**: catálogo cerrado nuevo en `src/backup/log.ts` (eventos `backup_*`, `restore_*`,
`verify_*`, `migration_blocked`), sin campos de texto libre, con el mismo `LoggerLike` que el
registro del bot ([contracts/backup-log.md](contracts/backup-log.md)). Llevan el motivo como
código, tamaños, duraciones, versión del esquema y recuentos; nunca rutas completas, textos,
teléfonos, nombres, la clave ni fragmentos del volcado (FR-024). Los mensajes de error de
PostgreSQL no se registran: pueden incluir valores de filas.

**Motivo**: la misma garantía que ya tienen los registros del bot (FR-030a de la 002, FR-022 de la
005).

**Alternativas**: reutilizar `ActivityLog` (es el catálogo del bot; estas operaciones existen sin
bot).

---

## Resumen de cifras que fija el plan

| Cifra | Valor | Dónde |
|-------|-------|-------|
| Tamaño de bloque cifrado | 64 KiB de texto en claro | R3 |
| Sal por fichero / `keyId` | 16 bytes / 8 bytes | R3 |
| Espera de bloqueos en la restauración | 5 s | R6 |
| Pasada del programador diario | 60 s | R10 |
| Parciales huérfanos que se limpian | de más de 1 h | R8 |
| Retención | 7 días por defecto, 1–30 | R13 (spec) |
| Hora de la copia diaria | 03:00 local por defecto | R10 (spec) |

No quedan incógnitas técnicas.
