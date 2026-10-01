# Research: Versión visible y actualización escalonada

Decisiones técnicas de la feature 009. Cada una indica qué se decide, por qué y qué se descartó.
Las cifras que la spec delegaba al plan (códigos, tiempos, límites, formato) se fijan aquí.

## R1. Endpoint `GET /health`: forma, códigos y nivel de acceso

**Decisión**: ruta `GET /health` fuera de `/admin` (sin sesión ni CSRF), en
`src/channels/health/routes.ts`. Respuesta siempre JSON, `Cache-Control: no-store`.

| Situación | Código | Cuerpo |
|---|---|---|
| Sin credencial, estado correcto | 200 | `{"status":"ok"}` |
| Sin credencial, degradado / no listo | 503 | `{"status":"degraded"}` / `{"status":"not_ready"}` |
| Credencial correcta, correcto | 200 | informe completo |
| Credencial correcta, degradado / no listo | 503 | informe completo |
| Credencial incorrecta | 401 | `{"error":"unauthorized"}` + `WWW-Authenticate: Bearer` |
| Demasiadas peticiones | 429 | el del plugin de límite |
| Credencial enviada pero la instancia no tiene secreto | como sin credencial | solo `{status}` (FR-001b) |

El informe completo se define en [contracts/health-endpoint.md](contracts/health-endpoint.md). El
estado también va en el código (FR-003): 200 solo con `ok`.

**Razón**: un balanceador o monitor externo basta con el código y con el nivel público; solo quien
tiene el secreto ve versiones e identificador (clarificación 2026-10-01). El 401 distingue "secreto
rechazado" de "caída" para la orden del inventario (escenario 4 de la US1). Un secreto enviado a una
instancia sin secreto no debe dar 401: no se revela si el secreto existe.

**Descartado**: `/healthz` o `/status` (el nombre `/health` es el que fija la spec y la propuesta
P6); `200` con estado en el cuerpo (obliga a interpretar el contenido, FR-003); `403` para el
secreto incorrecto (el 401 con `WWW-Authenticate` es lo estándar y la orden lo distingue igual);
nivel único protegido (impide el sondeo básico de un balanceador).

## R2. Secreto de salud: `HEALTH_SECRET`

**Decisión**: variable de entorno **opcional** en el núcleo, 32 bytes aleatorios en hexadecimal
(mismo formato y comprobación de aleatoriedad que `SESSION_SECRET` y `BACKUP_KEY`). Se envía en la
cabecera `Authorization: Bearer <secreto>`, **nunca** en la URL. Reglas en `loadEnv`:
distinta de `SESSION_SECRET` y de `BACKUP_KEY` (regla propia con `params.rule`, como las demás).
La comparación (`src/health/secret.ts`) calcula SHA-256 de ambos valores y usa
`crypto.timingSafeEqual`: longitud fija y tiempo constante, sin fugas por la forma de comparar
(FR-001b).

En el aprovisionamiento (007): `instance:new` genera el secreto con `generateHexSecret`; `instance:check`
lo exige (error `missing` si falta; es la forma de obligar a las instancias existentes a añadirlo) y
detecta que coincida con el de otra instancia con las huellas ya existentes (se añade
`HEALTH_SECRET` a `SECRET_VARIABLES` y a las variables hexadecimales de `normalize`); `instance:sync`
guarda su huella, nunca el valor (FR-009b). Para instancias anteriores a la feature se añade la
suborden `instance:health-secret <id>`: genera el secreto, lo escribe en el entorno de la instancia
(sin sobrescribir uno existente salvo `--rotate`) y no lo imprime.

**Razón**: no se hace obligatoria en el arranque (`loadEnv`) porque una instancia ya desplegada
dejaría de arrancar al actualizar la imagen; la obligatoriedad vive en `instance:check`, que es lo que
el operador ejecuta antes de desplegar. Es opcional en el arranque y su ausencia solo degrada la
funcionalidad al nivel público (FR-001b).

**Descartado**: reutilizar `SESSION_SECRET` o `BACKUP_KEY` (rompe "distinto de cualquier otro
secreto"); contraseña del operador (la tendría que guardar la herramienta); secreto en query string
(acaba en registros y proxies); un secreto compartido para todo el parque (una filtración compromete
a todos y viola el aislamiento); firma HMAC de la petición (complejidad sin ganancia: el secreto solo
da acceso a un informe sin datos sensibles).

## R3. Estados y cálculo del informe

**Decisión**: `buildHealthReport` (en `src/health/report.ts`) devuelve el estado y, para el nivel
completo, las versiones. Reglas, en orden:

1. **`not_ready`**: el ciclo de vida no es `ready` (`starting` hasta que `startInstance` termina de
   arrancar el bot y las tareas; `stopping` desde que empieza `stop()`). No se consulta la BD.
2. **`degraded`**: la BD no responde en 2 s, o el esquema aplicado no es el esperado por el núcleo
   (`installedSchema()`): índice, etiqueta o hash distintos, o migración desconocida para este núcleo
   (esquema más nuevo tras volver atrás, escenario 6), o BD vacía.
3. **`ok`**: BD responde y esquema aplicado = esperado.

El esquema aplicado se lee con `databaseSchema` de `src/backup/schema-version.ts` (misma regla que el
migrador: cruce por `created_at`). Si la BD contiene una migración que este núcleo no conoce, esa
función lanza; el informe lo traduce a `applied.tag = null` con `applied.index` = (número de filas de
`drizzle.__drizzle_migrations`) − 1, de modo que el operador ve que el esquema está **por delante**
sin que el núcleo pueda nombrarlo. Ningún mensaje de error de la BD llega al cuerpo ni a los
registros (FR-002).

**Razón**: reutilizar la fuente de verdad de la 006 evita una segunda definición de "versión del
esquema"; comparar también el hash detecta una migración editada (que la 006 prohíbe).

**Sobre "arranque o migración en curso" (edge case de la spec)**: el arranque actual (006) migra
**antes** de escuchar, de modo que durante la migración el puerto está cerrado y no hay respuesta:
la orden del inventario lo muestra como "no responde" (nunca como correcto, SC-004) y el
procedimiento indica esperar y mirar `migration_blocked`/`migration_failed` en los registros. El
estado `not_ready` cubre la ventana tras escuchar y antes de terminar de arrancar, y el cierre
ordenado. No se reordena el arranque (escuchar antes de migrar cambiaría el contrato de la 006:
"ninguna conversación caducada es visible al escuchar"). Se documenta esta limitación; la
distinción completa "migrando" frente a "caída" quedaría para una mejora futura si hiciera falta.

**Descartado**: abrir un puerto de salud temprano (superficie y ordenamiento nuevos para un caso que
el procedimiento ya cubre); considerar `degraded` un esquema anterior sin más (una migración
pendiente no puede ocurrir con la instancia escuchando, porque migra antes: un esquema anterior en
una instancia viva es una anomalía, y `degraded` es correcto).

## R4. Versión del núcleo: única fuente fijada en la construcción

**Decisión**: la versión es el campo `version` de `package.json` (semántica `MAYOR.MENOR.PARCHE` con
sufijo prerelease opcional). `src/health/version.ts` la lee una vez al arrancar (sube directorios
desde el módulo hasta el primer `package.json` con `name: "chatbotasesor"`; en la imagen está en
`/app/package.json`, ya copiado) y la valida. Si no se puede leer o no es semántica, el arranque
falla con un mensaje claro: nunca se inventa una versión (edge case de la spec).

Coincidencia con la etiqueta (FR-005): el `Dockerfile` recibe `ARG CORE_VERSION` obligatorio y, en la
etapa de construcción, ejecuta `node scripts/check-version.mjs "$CORE_VERSION"`, que falla si
`CORE_VERSION` está vacío, no es semántica o no es igual a la de `package.json`. La imagen se
construye con `docker build --build-arg CORE_VERSION=1.4.0 -t chatbot:1.4.0 .` y lleva la etiqueta
`org.opencontainers.image.version`. La publicación empieza con subir `version` en `package.json`
(commit y etiqueta Git `v1.4.0`); así hay **una sola fuente** (`package.json`) y la imagen no se
puede construir con una etiqueta distinta de la versión que declara.

**Razón**: `package.json` ya viaja en la imagen y es lo que el equipo ya versiona; no hace falta
`.git` ni variables extra en tiempo de ejecución. El control está en la construcción, que es donde se
decide la etiqueta.

**Descartado**: `ENV CORE_VERSION` inyectado en el build y leído en ejecución (dos fuentes que
pueden divergir); `git describe` (no hay `.git` en la imagen); generar `src/version.ts` en el build
(un fichero más que mantener y que puede quedar obsoleto en local); versión fija en código.

## R5. Orden `pnpm instance:versions`

**Decisión**: suborden `versions` de `src/cli/instance.ts`, con la lógica en
`src/provisioning/versions.ts` (puro salvo la petición HTTP, que se inyecta como `fetch`). Contrato
en [contracts/instance-versions-command.md](contracts/instance-versions-command.md).

- **Qué consulta**: todas las instancias del inventario salvo las de baja (`retired`) (FR-009).
  Sin `publicUrl` o con URL no `https` se informa y no se consulta (FR-015); `--allow-insecure`
  permite `http` solo para `localhost`, `127.0.0.1` y `::1` (entorno local de pruebas).
- **Secreto**: lee `HEALTH_SECRET` del entorno de la instancia, por defecto
  `<carpeta del inventario>/envs/<id>.env` (la ruta que ya usa `instance:new`); `--envs-dir` la
  cambia. Solo ese valor, solo en memoria, nunca se muestra ni se escribe (FR-009b, FR-014). Sin
  fichero o sin variable: fila "sin secreto de salud" y consulta del nivel público.
- **Petición**: `GET <publicUrl>/health` con `Authorization: Bearer`, `redirect: 'manual'` (un
  redireccionamiento nunca recibe el secreto), tiempo límite de 5 s por instancia
  (`AbortSignal.timeout`, `--timeout`), cuerpo limitado a 4 KiB y concurrencia 8.
  10 instancias con 3 caídas tardan como mucho 2 tandas × 5 s ≈ 10 s (SC-002 con holgura).
- **Clasificación** (primera que cumpla): `not_queried` (sin URL o no segura) → `unreachable` (red,
  DNS, TLS o tiempo) → `no_health` (404: instancia anterior a esta feature, "sin información de
  versión") → `auth_failed` (401) → `rate_limited` (429) → `invalid_response` (no es JSON, tamaño
  excesivo o no cumple el esquema) → `status_only` (solo estado: sin secreto, o instancia sin
  secreto configurado) → `identity_mismatch` (`instanceId` ≠ `id` del inventario; la versión no se
  atribuye, FR-014) → `ok` / `degraded` / `not_ready` con versiones.
- **Coincidencia con lo anotado**: se extrae la primera versión semántica del texto de
  `imageVersion` (`chatbot:1.4.0` → `1.4.0`) y se compara con la observada; sin anotación = "sin
  anotar" (a revisar), sin versión semántica en la anotación = discrepancia.
- **Salida y código**: tabla para personas, `--json` para máquinas. Código 0 si todas las consultadas
  están `ok` y coinciden con lo anotado; 1 si hay algo que revisar (FR-013); 2 por argumentos,
  inventario ilegible/bloqueado o clave incorrecta (como el resto de órdenes `instance:*`).
- **Solo lectura**: no escribe nada salvo con `--annotate` (R6). No adquiere el bloqueo del
  inventario si no anota; para listar basta `loadInventoryForUse`.

**Razón**: reutiliza el inventario, la clave y la lectura de entornos de la 007 sin duplicar nada. La
clasificación cerrada permite que cada caso de la spec (no responde, no válida, degradada,
discrepancia, identidad cruzada, sin información) tenga su fila y su prueba.

**Descartado**: guardar la ruta del entorno en el inventario (cambiaría su formato y acopla el
inventario a una máquina); guardar el secreto de salud en el inventario (FR-009b lo prohíbe);
seguir redirecciones (fuga del secreto a otro host); reintentos automáticos (ocultan caídas y
alargan el informe; el operador repite la orden).

## R6. Anotar la versión observada (`--annotate`)

**Decisión**: con `--annotate`, tras la tabla, la orden muestra "instancia: anotada → observada" solo
para las filas con identidad correcta y versión observada distinta de la anotada, pide confirmación
(`--yes` la omite; sin terminal y sin `--yes`, se niega con código 2) y escribe en `imageVersion` la
versión semántica observada (sin prefijo) usando la misma ruta que `instance:update --image`:
bajo `withInventoryLock`, releyendo y validando antes, con escritura atómica
(`updateInstance`/`writeInventory` de la 007). Una instancia que cambió en el inventario entre la
consulta y la escritura no se pisa: se compara de nuevo la anotación vista.

**Razón**: el inventario es la fuente de lo "esperado"; actualizarlo es una acción deliberada
(FR-012) y debe pasar por las mismas protecciones de escritura (FR-031 de la 007).

**Descartado**: anotar siempre (el informe de una instancia degradada o cruzada corrompería el
inventario); un campo nuevo `observedVersion` (cambia el formato del inventario; `imageVersion` ya
es "lo que el operador dice haber desplegado", y la orden lo contrasta con la realidad).

## R7. Versión en el panel

**Decisión**: `renderPage` (`src/admin/render.ts`) añade `layout.version` con el informe del núcleo
y del esquema (mismo `buildHealthReport`, sin credencial porque el operador ya está dentro) y
`layout.eta` pinta una línea fija al pie: «Núcleo 1.4.0 · Esquema 0005_config_transfer», con un
distintivo "Esquema distinto del esperado" si el estado no es `ok`. Si el informe falla, se pinta
«Versión no disponible» y la página se sirve igualmente. Sin caché (se calcula en cada
página, como los avisos): dos consultas de solo lectura por página del panel.

**Razón**: "lugar fijo visible tras iniciar sesión" (FR-007) y mismo dato que el endpoint, sin
duplicar la lógica.

**Descartado**: pantalla propia "Acerca de" (no está en un lugar fijo); cachear el esquema (se
quedaría obsoleto tras una restauración).

## R8. Límite de peticiones y registros de `/health`

**Decisión**: `config: { rateLimit: { max: 30, timeWindow: '1 minute' } }` por IP (el plugin ya está
registrado con `global: false`; respeta `TRUST_PROXY`), sobre la ruta `/health`. La ruta usa
`logLevel: 'warn'` para no inundar los registros con las sondas de un balanceador; la serialización
de peticiones ya omite IP y cabeceras sensibles y `Authorization` ya está en `redact`. El secreto no
se registra en ningún caso (FR-002). Para no competir con la atención a clientes finales (FR-006), el
sondeo usa un **pool propio de una conexión** (`max: 1`, `connectionTimeoutMillis` y
`statement_timeout` de 2 s) y una transacción de solo lectura; se cierra con `app.addHook('onClose')`.

**Razón**: protege al bot de sondeos abusivos y acota la respuesta aunque la BD esté colgada.

**Descartado**: bloqueo progresivo tras fallos de credencial (el secreto de 256 bits no es
adivinable y un bloqueo permitiría dejar fuera a la orden del operador); usar el pool del bot (un
sondeo lento le quitaría conexiones).

## R9. Cobertura de pruebas y entorno de las integraciones

**Decisión**: tres niveles como en la 008 (ver Technical Context del plan). Las pruebas de la orden
levantan servidores Fastify reales en puertos locales con `--allow-insecure` y un inventario
temporal creado con las funciones de la 007 (sin Docker más allá del Testcontainers ya existente
para la BD). La comprobación de privacidad (SC-003) recorre el cuerpo de todas las respuestas en
todos los estados buscando los valores prohibidos de un estado sembrado con datos de prueba
(teléfono, nombre de negocio, conversación, secretos). La cobertura de variables de
`.env.example` ↔ `loadEnv` ya existente se mantiene (se añade `HEALTH_SECRET` a ambos).

## R10. Procedimiento de publicación

**Decisión**: la sección 5 de `docs/operacion-multicliente.md` se reescribe como procedimiento por
etapas (previas → pruebas → tandas → comprobación → cierre → vuelta atrás), cada una con orden o
pantalla, resultado esperado y criterio de continuar o parar. El contenido normativo está en
[contracts/release-procedure.md](contracts/release-procedure.md); el ensayo con operador externo
(SC-006) es la validación de la guía, no una automatización (fuera de alcance).

**Razón**: es documentación comprobable (US3). Las órdenes que cita ya existen o las crea esta
feature.
