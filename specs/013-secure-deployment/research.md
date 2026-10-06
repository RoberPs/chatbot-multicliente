# Research: Requisitos de despliegue seguro

**Feature**: 013-secure-deployment · **Fecha**: 2026-10-06 · **Spec**: [spec.md](spec.md)

Decisiones de diseño que resuelven lo que la spec deja al plan. Cada una dice qué se elige, por
qué y qué se descartó. Se parte del código actual: `src/provisioning/check.ts` (reglas de
`instance:check`), `src/provisioning/database.ts` y `src/cli/instance.ts` (`instance:db`),
`src/backup/service.ts` (`verifyBackup`), `src/startup.ts` y `src/server.ts` (arranque),
`Dockerfile` y la configuración de pnpm.

---

## R1. Clasificación de una URL de base de datos (host local o remoto, TLS pedido)

**Decision**: módulo puro nuevo `src/config/database-url.ts`, compartido por `instance:check`,
`instance:db`, el arranque y las órdenes de copias:

```text
classifyDatabaseUrl(url) →
  | { kind: 'invalid' }
  | { kind: 'ok', local: boolean, verifiedTls: boolean, caFile: string | null }
```

- **Local** (FR-004, definición de la spec): `localhost`; cualquier IPv4 de `127.0.0.0/8`; `::1`
  (también entre corchetes y en formas IPv6 equivalentes, normalizadas con `node:net`); un
  socket local: host vacío en la URL con el parámetro `host=` que empieza por `/`, o el propio
  host que empieza por `/` (codificado `%2F`). Cualquier otro valor, incluidas IP privadas y
  nombres de una red interna, es **remoto**.
- **TLS verificado**: hay **un solo** parámetro `sslmode` y vale exactamente `verify-full`.
  `require`, `verify-ca`, `prefer`, `allow`, `disable`, `ssl=true`, `sslmode` repetido o con
  mayúsculas cuentan como no verificado. Las variables `PG*` del entorno no cuentan
  (caso límite de la spec): la regla mira solo la URL.
- `caFile` = valor de `sslrootcert` si existe (para la comprobación de lectura de R4); nunca se
  muestra.
- `invalid`: no se puede interpretar como `postgres:`/`postgresql:` o no tiene host ni socket.

**Rationale**: hoy hay tres listas de hosts locales distintas (`check.ts`, `env.ts`,
`database.ts`) y ninguna cubre `127.0.0.0/8` ni los sockets. Una sola función pura evita que
`instance:check` e `instance:db` den respuestas distintas para la misma URL (FR-007: "la misma
regla") y se prueba con una tabla.

**Alternatives considered**: usar `pg-connection-string` para leer la URL. Se descartó porque lee
el fichero de `sslrootcert` al interpretar la URL (lanza con la ruta en el mensaje) y porque
`instance:check` se ejecuta en el equipo del operador, donde esa ruta del contenedor no existe.

---

## R2. Reglas nuevas de `instance:check`

**Decision**:

| Código | Variable | Producción | Pruebas | Cuándo |
|---|---|---|---|---|
| `trust_proxy_empty` (se mantiene el código; pasa a error) | `TRUST_PROXY` | error | advertencia | `PUBLIC_BASE_URL` es `https:` y `TRUST_PROXY` está ausente, vacío o vale `false` |
| `missing` (sin cambios) | `PUBLIC_BASE_URL` | error | — | falta |
| `database_tls_required` (nuevo) | `DATABASE_URL`, `BACKUP_VERIFY_URL`, `INSTANCE_DB_ADMIN_URL` | error | advertencia | host remoto y sin TLS verificado (R1); uno por variable |
| `database_url_invalid` (nuevo) | `BACKUP_VERIFY_URL`, `INSTANCE_DB_ADMIN_URL` | error | error | presente pero `invalid` (R1). `DATABASE_URL` mal formada ya da su error del esquema del arranque y no se duplica |
| `database_localhost` (sin cambios) | `DATABASE_URL` | advertencia | — | host local en producción (FR-004) |

- `BACKUP_VERIFY_URL` e `INSTANCE_DB_ADMIN_URL` se comprueban solo si están en el fichero y no
  vacías; sin `BACKUP_VERIFY_URL` no se repite el error de `DATABASE_URL` (caso límite).
- Se conserva el código `trust_proxy_empty` en lugar de inventar otro: los scripts que ya leen la
  salida `--json` lo encuentran ahora en `errors`. Cambian su mensaje y su acción (contrato).
- En pruebas, con `PUBLIC_BASE_URL` en https y sin `TRUST_PROXY`, aparece la advertencia (hoy no
  sale nada en ese perfil).
- Los mensajes nombran la variable y el valor esperado (`sslmode=verify-full`), nunca la URL ni
  sus partes (FR-006, SC-002). El de TLS dice además que las variables `PG*` no cuentan.

**Rationale**: reutiliza `Findings` y el catálogo cerrado `CHECK_CATALOG` (mismo mecanismo que la
012 para los secretos: error en `production`, aviso en `testing`). La paridad texto/JSON ya la
garantiza `checkResultJson`.

**Alternatives considered**: código nuevo `trust_proxy_required`, descartado porque rompería los
filtros existentes sin ganar nada. Dejar la regla de TLS solo para `DATABASE_URL`, descartado: por
`BACKUP_VERIFY_URL` viajan datos reales al restaurar.

---

## R3. `instance:db` y la URL de administración

**Decision**:

1. Con la URL de administración ya leída (de `INSTANCE_DB_ADMIN_URL` o pedida sin eco) y **antes
   de abrir el inventario o conectar**, se clasifica con R1. Si es remota y sin TLS verificado,
   la orden termina con el error `admin_url_tls_required` (código de salida 1). El error explica
   cómo corregirlo y propone `--print-sql` como alternativa. Es igual en cualquier perfil
   y no hay opción para saltárselo (aclaración de la sesión 2026-10-06).
2. `--print-sql` no lee ninguna URL y no cambia.
3. La `DATABASE_URL` que escribe `instance:db`:
   - copia `sslmode` de la URL de administración (será `verify-full` si el servidor es remoto);
   - con `--print-sql` y `--host` remoto sin más indicación, lleva `sslmode=verify-full` por
     defecto, para que el entorno pase `instance:check` sin editarlo;
   - opción nueva `--sslrootcert <ruta>`: añade `sslrootcert=<ruta>` a la `DATABASE_URL`
     generada. La ruta es la del fichero **dentro del contenedor**. El `sslrootcert` de la URL de
     administración no se copia, porque es una ruta del equipo del operador.
4. La conexión de prueba con el usuario nuevo (`probeUrl`) usa el `sslmode` **y** el
   `sslrootcert` de la URL de administración: se ejecuta en el equipo del operador.

**Rationale**: por la URL de administración viaja la credencial de superusuario del servidor
(aclaración Q3). El valor por defecto `verify-full` con `--print-sql` evita que la herramienta
genere un entorno que su propia comprobación rechaza.

**Alternatives considered**: copiar `sslrootcert` tal cual, descartado porque la ruta casi nunca
coincide entre el equipo del operador y el contenedor.

---

## R4. TLS en las conexiones de la instancia y mensajes sin datos (FR-008)

**Decision**:

- **Ninguna conexión cambia**: `pg` 8.23 (`pg-connection-string` 2.14) ya interpreta
  `sslmode=verify-full` como `ssl: {}`, que verifica el certificado y el nombre con las
  autoridades de Node. También interpreta `sslrootcert=<ruta>` como `ssl.ca` (fichero leído). El
  pool principal, el público, el de la salud, las copias, la restauración, la verificación, las
  migraciones y el cerrojo usan `connectionString` y no pasan otro `ssl`, así que lo que dice la
  URL se aplica igual en todas. Una prueba de integración lo demuestra en cada camino (R9).
- **Lectura previa del fichero de la autoridad**: nueva `assertCaReadable(url, variable)` en
  `src/config/database-url.ts`. Si la URL lleva `sslrootcert` y el fichero no existe o no se
  puede leer, lanza `DatabaseConfigError('ca_unreadable', variable)`, cuyo mensaje nombra la
  variable sin la ruta. Se llama antes de crear ningún cliente en el arranque (`startInstance`,
  antes del cerrojo), en `db:migrate` y en `db:backup`, `db:restore` y `db:verify`. Hace falta
  porque `pg` lee el fichero de forma síncrona al construir el cliente, y su error lleva la ruta.
- **Errores de conexión traducidos**: nueva `describeDatabaseError(error, variable)`, que clasifica
  por `code` y nunca por el texto:
  - `tls_untrusted`: códigos de verificación de Node (`ERR_TLS_CERT_ALTNAME_INVALID`,
    `SELF_SIGNED_CERT_IN_CHAIN`, `DEPTH_ZERO_SELF_SIGNED_CERT`,
    `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `CERT_HAS_EXPIRED`,
    `CERT_NOT_YET_VALID`).
  - `tls_unsupported`: el servidor no acepta TLS.
  - `unreachable`: cualquier otro fallo al conectar.

  `src/server.ts` deja de imprimir `error.message` tal cual. Muestra el mensaje de los errores
  propios del arranque (`InstanceBusyError`, `DatabaseConfigError`, los de las migraciones con
  copia previa, que ya no llevan datos) y, para cualquier otro, el texto fijo de
  `describeDatabaseError`. El mensaje de `ERR_TLS_CERT_ALTNAME_INVALID` incluye el host y los
  nombres del certificado, así que nunca se imprime.
- **Órdenes de copias**: `restoreFailureReasons` y los textos de `backup-common.ts` ganan
  `db_ca_unreadable`, `db_tls_untrusted` y `db_tls_unsupported`, con el mismo criterio;
  `unreachable` sigue siendo `db_error` (o `verify_db_unavailable`), como hoy.
- **Sin regla de TLS al arrancar** (Assumptions de la spec): el arranque no rechaza una URL remota
  sin `verify-full`; solo traduce los errores.

**Rationale**: no hace falta tocar cómo se crean las conexiones, solo lo que se muestra cuando
fallan. Clasificar por `code` sigue el criterio de la 012 (FR-032: "el tipo y el código, nunca el
mensaje").

**Alternatives considered**: leer el fichero de la autoridad nosotros y pasar `ssl.ca` en cada
`new pg.Client`, descartado porque `pg` da prioridad a lo que dice la URL y habría dos fuentes de
verdad. `NODE_EXTRA_CA_CERTS`, descartado en la aclaración Q2.

---

## R5. Bases temporales de verificación: nombre, permisos y limpieza

**Decision**:

- **Nombre** (aclaración Q1): `verify_<yyyymmddhhmmss>_<16 hex>`, con la marca en UTC tomada del
  reloj inyectable de `verifyBackup` y 8 bytes aleatorios. Patrón exacto:
  `^verify_(\d{14})_([0-9a-f]{16})$`, con la marca validada como fecha y hora reales. Formato
  anterior: `^verify_[0-9a-f]{16}$`. Ningún otro nombre se considera nunca (FR-011).
  La marca va en UTC aunque la convención del proyecto es la hora local: no es un horario del
  negocio sino un instante técnico, comparado con el reloj del proceso.
- **Permisos** (FR-009): justo después de `CREATE DATABASE` y en la misma conexión de
  mantenimiento, `REVOKE CONNECT, TEMPORARY ON DATABASE <temporal> FROM PUBLIC`, antes de abrir
  la conexión que carga la copia. Si el `REVOKE` falla, se borra la base y la verificación
  termina con `verify_db_unavailable`. El dueño (el usuario de `BACKUP_VERIFY_URL`) conserva su
  acceso. Un superusuario siempre puede entrar, y queda fuera del escenario 2.4.
- **Plazo máximo de una verificación**: `VERIFY_MAX_AGE_HOURS = 6`. La copia más grande que se
  espera (decenas de miles de mensajes al mes, 30 días de retención) se restaura en minutos, así
  que 6 h dejan mucho margen sin mantener datos reales un día entero.
- **Limpieza** (FR-010–FR-012), antes de crear la temporal, en la conexión de mantenimiento:
  1. `select d.datname, count(a.pid) from pg_database d left join pg_stat_activity a on
     a.datname = d.datname where d.datname like 'verify\_%' group by d.datname`. Esto es legible
     para cualquier usuario: `pg_stat_activity` muestra `datname` de todas las sesiones.
  2. Es candidata la base que cumple el patrón exacto, no tiene conexiones y, además: en el
     formato nuevo, tiene una marca anterior a "ahora − 6 h" (una marca en el futuro no cuenta);
     en el formato anterior, basta con no tener conexiones (Q1).
  3. `DROP DATABASE <nombre>` **sin** `WITH (FORCE)`, de modo que si alguien se conecta entre el
     paso 1 y el 3, PostgreSQL rechaza el borrado (`55006`) y la base se respeta sin contarla
     como fallo. `42501` (no es el dueño) o cualquier otro error cuentan como "no borrada".
  4. Si falla el paso 1, la limpieza queda `listed: false` y la verificación sigue (FR-012).
- **Informe**: `VerifyReport.orphans = { listed: boolean, removed: number, failed: number }`, en
  texto y JSON, sin nombres. El evento `verify_completed` del registro de copias lleva los mismos
  tres campos.
- **Dos instancias en el mismo servidor de verificación** (caso límite): la base de una
  verificación en curso tiene conexiones o tiene menos de 6 h, así que nadie la toca. Si cada
  instancia usa su propio usuario, las huérfanas de otra salen como `failed` por permisos. La
  receta recomienda un único usuario de verificación por servidor.

**Rationale**: `DROP` sin `FORCE` hace atómica la condición "sin conexiones" y elimina la carrera
con una verificación que arranca. El patrón exacto y el formato fijo hacen imposible borrar una
base de una instancia (que se llama `chatbot_<id>`, 007).

**Alternatives considered**: `COMMENT ON DATABASE` con la fecha y `pg_stat_file` sobre el
directorio, descartados en la aclaración Q1 y porque `pg_stat_file` exige superusuario. Limpiar
también al terminar con un `finally` más agresivo, descartado porque el `finally` ya borra la
propia base y el problema es la interrupción del proceso.

---

## R6. Comprobación de salud de la imagen (FR-013, FR-014, SC-004)

**Decision**:

```dockerfile
HEALTHCHECK --start-period=120s --start-interval=5s --interval=30s --timeout=5s --retries=3 \
  CMD ["node", "dist/src/cli/healthcheck.js"]
```

- `src/cli/healthcheck.ts` (compilado con el resto) hace `fetch` a
  `http://127.0.0.1:${PORT ?? 3000}/health` sin cabecera `Authorization` y con
  `AbortSignal.timeout(4000)`. Sale con 0 solo si la respuesta es 200 y el cuerpo es
  `{"status":"ok"}`; con cualquier otra cosa (`not_ready`, `degraded`, 429, error de red o plazo
  agotado) sale con 1. No escribe nada en la salida, para no llenar el estado de Docker con
  detalles. Usa `fetch` de Node 22, porque la imagen no trae curl ni wget.
- **Periodo de gracia**: 120 s. Las migraciones con copia previa de una instancia pequeña tardan
  segundos, y el servidor no escucha hasta terminarlas (`startInstance`). Los fallos en ese
  periodo no cuentan (escenario 3.1), y el primer éxito marca la instancia como sana.
- **SC-004**: con BD disponible, la instancia está sana unos 5 s después de empezar a escuchar
  (`--start-interval`). Sin BD después de la gracia, pasa a enferma en ≤ 3 × 30 s + 5 s ≈ 95 s,
  por debajo de los 3 min exigidos.
- **Límite de `/health`** (30 por minuto y dirección, 009): 12 por minuto durante la gracia y 2
  por minuto después. La petición llega desde `127.0.0.1` sin `X-Forwarded-For`, así que con
  cualquier `TRUST_PROXY` su clave es la de bucle local, distinta de la de los clientes.
- `--start-interval` necesita Docker Engine 25 o posterior. Un motor anterior lo ignora y sondea
  cada 30 s también en la gracia, lo que sigue cumpliendo SC-004 en el caso sano (≤ 2 min). La
  receta lo dice.

**Rationale**: la vista pública de `/health` (sin secreto) basta para saber si está sana, y así el
secreto no aparece en la configuración del contenedor.

**Alternatives considered**: `node -e "fetch(...)"` en línea, descartado porque se prueba peor y
el JSON del Dockerfile se vuelve ilegible. Usar el informe completo con `HEALTH_SECRET`,
descartado porque expondría el secreto en `docker inspect`.

---

## R7. Imagen base fijada y gestor de paquetes con hash (FR-015, FR-016, SC-005)

**Decision**:

- Un `ARG` global antes del primer `FROM` fija la base para las dos etapas:
  ```dockerfile
  ARG NODE_IMAGE=node:22-slim@sha256:<digest del índice multiplataforma>
  FROM ${NODE_IMAGE} AS build
  …
  FROM ${NODE_IMAGE}
  ```
  El digest es el del índice (`docker buildx imagetools inspect node:22-slim`, campo `Digest`),
  no el de una plataforma, para que sirva en amd64 y en arm64. Se obtiene al implementar y se
  actualiza con el procedimiento que la guía documenta (§5 y receta).
- `package.json`: `"packageManager": "pnpm@9.15.0+sha512.<hash>"`, escrito con
  `corepack use pnpm@9.15.0`. Corepack (incluido en Node 22) comprueba el hash al descargar pnpm
  en `RUN corepack enable` y en `pnpm install`.
- Prueba unitaria estática (`tests/unit/scripts/image-pinning.test.ts`): toda línea `FROM` usa la
  base fijada con `@sha256:[0-9a-f]{64}` y conserva la etiqueta, y `packageManager` cumple
  `^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$`.

**Rationale**: con un solo `ARG`, las dos etapas no pueden quedar con bases distintas, y la
actualización es un único cambio.

**Alternatives considered**: Renovate o Dependabot para el digest, descartados porque aún no hay
remoto ni proveedor (Assumptions), aunque la receta de CI los menciona como mejora.

---

## R8. Configuración de pnpm: versiones exactas y scripts autorizados (FR-017)

**Decision**:

- `.npmrc` nuevo con `save-exact=true`.
- `package.json`: `"pnpm": { "onlyBuiltDependencies": ["argon2", "esbuild"] }`. Inventario
  actual de dependencias con scripts de instalación:

  | Paquete | Script | ¿Se autoriza? | Por qué |
  |---|---|---|---|
  | `argon2` | `node-gyp-build` | sí | Producción: elige o compila el binario nativo del hash del operador |
  | `esbuild` | `postinstall` | sí | Desarrollo (`tsx`, `vitest`, `drizzle-kit`): coloca el binario de la plataforma |
  | `ssh2`, `cpu-features` | `install` (compilación nativa opcional) | no | Desarrollo (Testcontainers); funcionan sin la parte nativa |
  | `protobufjs` | `postinstall` (aviso de versión) | no | Desarrollo; no hace falta |

- El `Dockerfile` copia `.npmrc` en la etapa de construcción junto a `package.json` y
  `pnpm-lock.yaml`. `pnpm install --frozen-lockfile` ya instala exactamente el lockfile.
- Prueba estática: `onlyBuiltDependencies` es exactamente esa lista y `.npmrc` contiene
  `save-exact=true`. El escenario 3.5 (una dependencia nueva con script no autorizado no lo
  ejecuta) se comprueba a mano en el quickstart, porque depende del comportamiento de pnpm y no
  del código.
- Las versiones con `^` ya presentes en `package.json` **no** se cambian ahora. El lockfile ya fija
  lo que se instala, y `save-exact` se aplica a lo que se añada desde ahora.

**Rationale**: en pnpm 9, `onlyBuiltDependencies` es la lista de paquetes autorizados. Lo que no
está en ella no ejecuta scripts.

**Alternatives considered**: `ignore-scripts=true`, descartado porque rompe `argon2` y `esbuild`.
Fijar a mano todas las versiones de `package.json`, descartado porque no lo pide la spec y no
añade nada al lockfile congelado.

---

## R9. Pruebas

**Decision**:

- **Unitarias**:
  - tabla de `classifyDatabaseUrl`: locales (`localhost`, `127.0.0.5`, `::1`, `[::1]`,
    `0:0:0:0:0:0:0:1`, sockets) y remotas (`10.0.0.5`, `192.168.1.10`, nombres);
  - cada `sslmode`, `sslmode` repetido, `ssl=true` y URL no válidas;
  - reglas de `instance:check` en los dos perfiles, con paridad texto/JSON y ningún valor ni
    parte de URL en la salida (SC-001, SC-002, SC-007);
  - `instance:db` con URL remota sin TLS (no conecta, salida 1, sin la URL);
  - `--sslrootcert` y el `verify-full` por defecto con `--print-sql`;
  - nombres de verificación: generación, patrón exacto y fechas imposibles;
  - selección de huérfanas con reloj falso;
  - `describeDatabaseError` por código;
  - `healthcheck` contra un servidor HTTP de prueba con 200/`ok`, 503, 429, cuerpo inesperado,
    servidor que no responde y puerto cerrado;
  - pruebas estáticas de la imagen y de pnpm (R7, R8);
  - `git check-ignore` de `x.pem`, `x.key` y `x.p12`, y ningún fichero rastreado que coincida
    (FR-018).
- **Integración** (Testcontainers):
  - PostgreSQL con TLS: el certificado lo genera `openssl` dentro del propio contenedor `postgres`
    (autoridad propia y servidor con SAN `DNS:localhost`). Se conectan con
    `sslmode=verify-full&sslrootcert=<ca>` el pool principal, la salud, las migraciones, la copia,
    la restauración y la verificación. Con `127.0.0.1` como host (fuera del SAN), la conexión
    falla con `tls_untrusted` y un mensaje sin host; con una ruta de autoridad inexistente, falla
    con `ca_unreadable` y un mensaje sin ruta;
  - `db:verify`: huérfana antigua borrada; huérfana reciente respetada; base con conexión
    respetada; base con otro nombre (`verify_x`, `chatbot_a`, `verify_<hex>_extra`) respetada;
    huérfana del formato anterior borrada; huérfana de otro dueño contada como `failed`; un
    usuario sin privilegios no se conecta a la temporal durante la verificación (gancho de
    prueba en la carga); listado imposible con verificación correcta.
- **Manual (quickstart)**: construcción doble con la misma base, estados de salud de Docker con y
  sin BD, script de una dependencia no autorizada, receta en una máquina limpia (SC-006).

---

## R10. Receta de producción (FR-019–FR-021) y documentación

**Decision**: la §2.5 de `docs/operacion-multicliente.md` pasa a ser una lista numerada. Cada
paso trae un ejemplo y una **comprobación** ejecutable o visible (contrato en
[contracts/production-recipe.md](contracts/production-recipe.md)). Herramientas de ejemplo,
genéricas y sustituibles (FR-021):

- proxy: nginx (`proxy_set_header X-Forwarded-For $remote_addr;`, que **sustituye** la cabecera);
- contenedor: `docker run`;
- escaneo de la imagen: Trivy (`trivy image --severity HIGH,CRITICAL --ignore-unfixed`).

La integración continua se describe como pasos y criterios de bloqueo enlazados a la §11.4, sin
fichero de CI (Assumptions):

| Paso | Bloquea si encuentra |
|---|---|
| `pnpm audit --prod` | alta o crítica |
| `osv-scanner` | lo mismo, en dependencias de producción |
| `gitleaks` | cualquier hallazgo sin revisar |
| `semgrep` | severidad `ERROR` |
| Trivy | alta o crítica con corrección disponible |

Además cambian:

- **§2.3**: `--sslrootcert` y la negativa sin TLS verificado.
- **§2.4**: tabla de variables con `TRUST_PROXY` obligatorio con https y TLS verificado en las URL
  remotas, incluidas `BACKUP_VERIFY_URL` e `INSTANCE_DB_ADMIN_URL` (FR-022).
- **§5**: aviso de NO APTO nuevo y cómo actualizar el digest (FR-023).
- **§8**: limpieza de huérfanas en `db:verify`.
- **Al cerrar** (convención del proyecto, avisando antes al usuario): §9.1, §9.2, P9 marcada como
  hecha, y `README.md`.

**Rationale**: la receta es la parte que el código no puede comprobar. Que cada punto lleve su
comprobación es lo que permite medir SC-006.

**Alternatives considered**: Caddy como proxy de ejemplo, descartado porque su manejo de
`X-Forwarded-For` depende de `trusted_proxies` y la receta quiere un ejemplo en el que la
sustitución se vea en una sola línea.
