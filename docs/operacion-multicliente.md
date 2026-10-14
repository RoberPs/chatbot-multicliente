# Operación multicliente: cómo se reutiliza el chatbot con seguridad

Guía para el desarrollador y operador del producto. Explica qué es común y qué es de cada cliente,
cómo se da de alta un cliente nuevo, cómo se actualiza el núcleo sin romper a nadie, qué specs
faltan para que todo esto deje de hacerse a mano y cómo se audita la seguridad antes de publicar.

Documentos de referencia: [constitución](../.specify/memory/constitution.md) (reglas de producto) y
[README](../README.md) (estado, variables de entorno y comandos).

---

## 1. Modelo mental

El producto no se "configura en local y se sube". **Lo único que viaja de tu máquina a producción es
el código**, y es el mismo para todos los clientes. La información de cada negocio vive en la base de
datos de su instancia y se registra en el panel `/admin` de esa instancia, ya en producción.

| Pieza | Qué contiene | ¿Común o por cliente? |
|---|---|---|
| **Imagen Docker del núcleo** (`Dockerfile`) | Todo `src/`, compilado | Común: una sola imagen, etiquetada por versión |
| **Variables de entorno** | BD, credencial del operador, `SESSION_SECRET`, clave de Anthropic, WhatsApp, `PUBLIC_BASE_URL`… | Por cliente |
| **Base de datos PostgreSQL** | Datos del negocio, servicios, precios, horarios, FAQ, configuración del chat web, conversaciones | Por cliente (una BD por instancia, sin `tenant_id`) |
| **Extensiones** | Comportamiento que la configuración no cubre | Por cliente, con spec propia (Principio III) |

```text
                 ┌──────────────── tu máquina ────────────────┐
                 │ specs → código → pnpm test → docker build  │
                 └───────────────────────┬────────────────────┘
                                         │ imagen chatbot:X.Y.Z (igual para todos)
          ┌──────────────────────────────┼──────────────────────────────┐
          ▼                              ▼                              ▼
  instancia cliente A            instancia cliente B            instancia de pruebas (tuya)
  .env A + BD A                  .env B + BD B                  .env P + BD P (datos ficticios)
  a.tudominio.com/admin          b.tudominio.com/admin          staging.tudominio.com/admin
```

### Papeles

- **Desarrollador (tú)**: mejora el núcleo en local, siempre empezando por una spec, y publica
  versiones de la imagen.
- **Operador (tú)**: registra y mantiene la información de cada negocio en su panel. Según el
  Principio VI, el cliente **no** edita su propia configuración: te pide los cambios y los aplicas
  tú, sin desplegar nada.
- **Cliente (el negocio)**: recibe el fragmento del chat web para su web y/o conecta su número de
  WhatsApp. Paga el servicio y, según lo que acordéis, el consumo de la API.

### Para qué sirve tu localhost

- Desarrollar y probar el núcleo con los negocios de ejemplo de `tests/fixtures/` (los únicos
  sitios donde puede haber nombres de sector).
- `pnpm bot:chat`, "Probar el bot" y `pnpm test:eval` para comprobar calidad antes de publicar.
- Preparar y probar la configuración de un negocio (servicios, precios, horarios, preguntas) y
  llevarla a producción con el fichero de **Exportar e importar** (`/admin/config`, feature 008;
  ver [2.6](#26-configuración-del-negocio-en-el-panel-de-producción)). Nunca se llevan
  conversaciones ni datos de clientes finales: el fichero solo contiene configuración.

---

## 2. Alta de un cliente nuevo

Desde la feature 007 el alta se hace con las órdenes `pnpm instance:*`, en el equipo del
operador y con el repositorio del núcleo: `instance:new` genera el entorno con secretos nuevos,
`instance:db` crea la base de datos con su usuario, `instance:check` lo valida contra el resto de
instancias y un **inventario** local lleva la lista de instancias sin ningún secreto. Contrato de
las órdenes: [specs/007-instance-provisioning/contracts/instance-commands.md](../specs/007-instance-provisioning/contracts/instance-commands.md).

### 2.0 Inventario y su clave (una vez)

- **Dónde**: `~/.chatbotasesor/inventory.json` por defecto; otra ruta con `INSTANCE_INVENTORY` o
  `--inventory`. Nunca dentro del repositorio del núcleo (contiene nombres de clientes): las
  herramientas lo rechazan aunque la ruta esté en `.gitignore`.
- **Qué guarda**: cliente, URL, estado, versión de la imagen, workspace de Anthropic, dónde está
  la `BACKUP_KEY`, identidad de la BD (sin contraseña), fechas y última verificación de copia, y
  **huellas** HMAC de los secretos. Con las huellas se detecta un secreto repetido entre
  instancias sin poder recuperarlo.
- **Clave del inventario** (`INSTANCE_INVENTORY_KEY`, 64 hex): se crea con el inventario (la
  primera `instance:new` o `instance:register`, tras escribir `crear`) y se muestra **una sola
  vez**. Guárdala en el gestor de secretos, junto a los entornos, y expórtala en la terminal antes
  de usar las herramientas; nunca se pasa por argumento. Sin ella nada compara ni escribe y
  `instance:check` da "no apto". Si la pierdes: crea un inventario nuevo en otra ruta y vuelve a
  registrar cada instancia con `pnpm instance:register <entorno> --client "<nombre>"`.
- **Copia**: el inventario no tiene secretos, pero sí nombres de clientes; haz copia de él (por
  ejemplo en un repositorio privado tuyo) y de su clave.
- **Permisos en Windows**: el modo `0600` no aplica; el inventario y los entornos heredan la ACL
  del directorio (por defecto, tu perfil de usuario). No los pongas en carpetas compartidas.

### 2.1 Antes de tocar nada

- [ ] Contrato de encargo del tratamiento (RGPD, art. 28) firmado con el cliente, que mencione a
      los subencargados: Anthropic, Meta (si usa WhatsApp) y OpenAI (si se activan los audios).
- [ ] Enlace a la política de privacidad del cliente (el chat web no se activa sin él).
- [ ] Decidido quién paga la API de Anthropic (ver [sección 4](#4-coste-de-la-api)).
- [ ] Subdominio elegido, por ejemplo `nombrecliente.tudominio.com`, con certificado TLS.

### 2.2 Generar el entorno: `pnpm instance:new`

En una terminal (no redirijas la salida: muestra secretos una sola vez):

```bash
pnpm instance:new --id cliente-x --client "Nombre del cliente" --url https://cliente-x.tudominio.com \
  --timezone Europe/Madrid --region ES --currency EUR --emergency-phone "+34 600 000 000" [--whatsapp]
```

- Parte siempre de `.env.example` y genera **secretos nuevos**: `SESSION_SECRET`, `BACKUP_KEY`,
  `HEALTH_SECRET` (secreto de salud de la 009, distinto de los otros dos; no se muestra),
  la contraseña del operador (24 caracteres, se muestra **una sola vez**; el entorno solo lleva su
  hash Argon2id) y, con `--whatsapp`, `WHATSAPP_VERIFY_TOKEN`. No acepta contraseñas tecleadas.
- Escribe el entorno en `<dir. del inventario>/envs/<id>.env` (o `--out`), legible solo por tu
  usuario, y nunca sobrescribe un fichero. Dentro del repositorio solo acepta rutas excluidas por
  `git`.
- Deja vacías y marcadas con `# PENDIENTE:` las variables de terceros: `DATABASE_URL` (siguiente
  paso), `ANTHROPIC_API_KEY`, `WHATSAPP_*` y `SMTP_*`.
- Registra la instancia en el inventario en estado "en alta". Rechaza un `id` o una URL ya usados,
  también por instancias dadas de baja.

Después: guarda el fichero, la contraseña y la `BACKUP_KEY` en el gestor de secretos (la clave,
fuera de `BACKUP_DIR`) y anota dónde con `pnpm instance:update <id> --backup-key-location "<dónde>"`.

### 2.3 Crear la base de datos: `pnpm instance:db`

```bash
export INSTANCE_DB_ADMIN_URL='postgres://admin:…@servidor:5432/postgres?sslmode=verify-full'   # o se pide sin eco
pnpm instance:db cliente-x [--env <fichero>] [--host <servidor> --port <puerto>] [--sslrootcert <ruta>]
```

Crea una **BD nueva y vacía** `chatbot_<id>` y un **usuario propio** sin privilegios de
administración, con contraseña aleatoria enviada al servidor como verificador SCRAM (la contraseña
en claro no viaja), retira `CONNECT` a `PUBLIC`, comprueba que el usuario entra y escribe
`DATABASE_URL` en el entorno. Las credenciales de administración solo se usan en memoria. Si ya
existe una BD o un usuario con ese nombre, no toca nada. **Nunca borra una base de datos**: si
falla a mitad, retira solo el usuario recién creado o informa de lo que quedó creado y de las
órdenes para terminarlo a mano.

`--host`/`--port` indican cómo ve la instancia el servidor si no es igual que desde tu equipo (p.
ej. una red Docker). En un servidor gestionado sin permiso para crear bases de datos, usa
`--print-sql --host <servidor> --port <puerto>`: imprime el SQL exacto (sin la contraseña) para
ejecutarlo en la consola del proveedor, sin conectarse a nada.

**TLS verificado (013).** Por la URL de administración viaja la credencial de administración del
servidor, así que, si el servidor es **remoto** (cualquiera que no sea `localhost`, `127.0.0.0/8`,
`::1` o un socket local; también una IP privada), `instance:db` **se niega a conectar** sin
`sslmode=verify-full` en la propia URL, en cualquier perfil y sin opción para saltárselo:

```text
INSTANCE_DB_ADMIN_URL apunta a un servidor remoto sin TLS verificado: por esa conexión viaja la credencial de administración.
→ Añade sslmode=verify-full (y sslrootcert=<ruta> si la autoridad no es pública), o usa --print-sql --host <servidor> --port <puerto> y aplica el SQL tú mismo.
```

Sale con 1 al instante, sin abrir el inventario ni tocar el entorno. También se niega
(`admin_url_ip_host`) si la URL lleva `verify-full` pero el servidor es una **IP**: con una IP no se
comprueba que el certificado sea de ese servidor. Usa el nombre que figura en su certificado. Si la autoridad del
certificado no es pública, añade a la URL de administración `sslrootcert=<ruta en tu equipo>`: la
conexión de prueba con el usuario nuevo usa el mismo `sslmode` y `sslrootcert`.

La `DATABASE_URL` que escribe lleva el `sslmode` de la URL de administración; con `--print-sql` y
un `--host` remoto, `sslmode=verify-full` por defecto, para que el entorno pase `instance:check`
sin editarlo. `--sslrootcert <ruta>` añade `sslrootcert=<ruta>` a esa `DATABASE_URL`: es la ruta
del certificado **dentro del contenedor** (p. ej. `/etc/chatbot/db-ca.crt`, montado en solo
lectura; [2.5](#25-despliegue), paso 4), no la de tu equipo, y no se muestra en la salida.

**Limitación**: la comparación de bases de datos es por servidor, puerto y nombre tal como están
escritos; el mismo servidor con dos nombres (alias) no se detecta. Lo cubre el usuario propio de
cada base de datos.

### 2.4 Completar y validar: `pnpm instance:check`

1. Completa en el fichero los valores `PENDIENTE`: **clave de Anthropic propia** del cliente (en un
   workspace propio con límite de gasto), **WhatsApp** (las cinco variables o ninguna) y el correo
   de avisos (`SMTP_URL` y `SMTP_FROM`, o ninguna).
2. Revisa el resto de valores con la tabla de abajo (`TRUST_PROXY`, audios…).
3. Valida:

   ```bash
   pnpm instance:check <fichero> [--json]
   ```

   Da **APTO** / **NO APTO** con errores y advertencias por variable y la acción que lo corrige,
   sin mostrar nunca un valor. Aplica las mismas reglas que el arranque más las del alta
   (production, `https`, calidad de cada secreto) y compara con **todas** las instancias del
   inventario, también las dadas de baja: `INSTANCE_ID`, BD, usuario de BD, URL, número de
   WhatsApp y cualquier secreto (vigente o anterior, `HEALTH_SECRET` incluido) repetidos son error;
   desde la 009 también es error que falte `HEALTH_SECRET`, que sea débil o que sea igual a
   `SESSION_SECRET` o a `BACKUP_KEY`; `SMTP_URL` o
   `BACKUP_DIR` compartidos, advertencia. Desde la 013 también son error en producción
   `TRUST_PROXY` vacío con `PUBLIC_BASE_URL` en `https` (`trust_proxy_empty`) y una URL de base de
   datos remota sin `sslmode=verify-full` (`database_tls_required`); en una instancia de pruebas
   (`testing`) son advertencias. No escribe nada. Código de salida 0 apto, 1 no apto: se puede usar
   como paso de despliegue.

Pasa también por `instance:check` cualquier cambio posterior del entorno.

Referencia de variables del entorno:

| Variable | Valor para el cliente |
|---|---|
| `DATABASE_URL` | La escribe `instance:db` (2.3). Con un servidor **remoto** (todo lo que no sea `localhost`, `127.0.0.0/8`, `::1` o un socket local), `sslmode=verify-full` en la propia URL y, si la autoridad del certificado no es pública, `sslrootcert=<ruta en el contenedor>`; si no, error `database_tls_required` en producción. El servidor va por su **nombre**, el del certificado: con una IP y `verify-full`, error `database_tls_ip_host` (con una IP no se comprueba el certificado). Las variables `PG*` del entorno no cuentan |
| `BACKUP_VERIFY_URL` | Servidor donde `db:verify` crea sus bases temporales (por defecto, el de `DATABASE_URL`); usuario con `CREATEDB`, uno solo por servidor ([2.5](#25-despliegue), paso 8). Misma regla de TLS (`database_tls_required`); mal formada, `database_url_invalid` en los dos perfiles |
| `INSTANCE_DB_ADMIN_URL` | Solo en tu equipo, para `instance:db`; si aparece en un entorno, `instance:check` le aplica la misma regla de TLS y de formato que a `BACKUP_VERIFY_URL` |
| `OPERATOR_USER` · `OPERATOR_PASSWORD_HASH` | Credencial propia de esta instancia |
| `SESSION_SECRET` | Recién generado |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | Número de saltos del proxy (`1` si hay uno) o sus IP/CIDR; nunca `true`. **Obligatorio** con `PUBLIC_BASE_URL` en `https`: la instancia no termina TLS, así que hay un proxy delante y sin él todos los clientes parecen venir de la misma dirección (error `trust_proxy_empty` en producción, advertencia en pruebas). Comprueba la dirección que ve la instancia ([2.5](#25-despliegue), paso 7) |
| `PUBLIC_BASE_URL` | `https://nombrecliente.tudominio.com` |
| `DEFAULT_TIMEZONE` · `DEFAULT_PHONE_REGION` · `DEFAULT_CURRENCY` | Los del negocio |
| `EMERGENCY_CONTACT_PHONE` | Teléfono E.164 del negocio |
| `ANTHROPIC_API_KEY` | La clave de su workspace |
| `LLM_MODEL` · `LLM_EFFORT` | Los valores por defecto salvo motivo documentado |
| `WHATSAPP_*` | Las cinco, o ninguna. Ninguna salvo que el cliente lo haya contratado. Antes de activarlo en el primer cliente, revisa en desarrollo todo el canal con una app de pruebas de Meta: webhook (verificación y firma), envío y plazos, tope diario de WhatsApp, derivaciones con plantillas, audios si van incluidos y registros sin tokens (quickstart de la 012, escenarios 2, 3, 6 y 8) |
| `AUDIO_TRANSCRIPTION` · `STT_*` | `off` salvo que esté contratado y cubierto por el contrato. Antes de activarlo en el primer cliente, completa la evaluación de audios pendiente (tarea T083 de la 002: grabaciones y `pnpm test:eval audio`) |
| `INSTANCE_ID` | Identificador único de la instancia (minúsculas, cifras y guiones), p. ej. `cliente-x`. Va dentro de cada copia |
| `BACKUP_DIR` | Ruta absoluta del volumen persistente de copias, p. ej. `/var/lib/chatbot/backups` |
| `BACKUP_KEY` | `openssl rand -hex 32`, **distinta** de `SESSION_SECRET` y de la de otras instancias; guárdala también **fuera** de `BACKUP_DIR` |
| `BACKUP_RETENTION_DAYS` · `BACKUP_DAILY_TIME` | `7` y `03:00` (hora local del negocio) salvo acuerdo distinto; retención de 1 a 30 días |
| `HEALTH_SECRET` | Lo genera `instance:new` (o `instance:health-secret <id>` en instancias anteriores a la 009): 32 bytes en hex, **distinto** de `SESSION_SECRET`, `BACKUP_KEY` y del de otras instancias. Da acceso a la versión en `GET /health` ([sección 5](#5-actualizar-el-núcleo)); el inventario guarda solo su huella |

En `production` la instancia **no arranca** sin `INSTANCE_ID`, `BACKUP_DIR` y `BACKUP_KEY`. El
contenedor necesita un **volumen persistente** montado en `BACKUP_DIR` y escribible por el usuario
`node` (la imagen declara `/var/lib/chatbot/backups`). Si ese volumen está en la misma máquina que
la BD, activa las instantáneas o la réplica del proveedor, o sincroniza el directorio fuera:
perder la máquina haría perder las copias.

Guarda este fichero en un gestor de secretos (o en las variables cifradas de tu plataforma), no en
el repositorio. Sin `BACKUP_KEY` las copias de la instancia no se pueden restaurar.

**Rotar un secreto o cambiar la BD, la URL o el directorio de copias**: edita el entorno, pásalo
por `instance:check` y actualiza el inventario con `pnpm instance:sync <id> <fichero>`. Los valores
anteriores quedan como usados y nunca se podrán reutilizar.

**Si pierdes el fichero de entorno**: los secretos no se pueden recuperar del inventario y el `id`
no se puede volver a generar. Rehaz el fichero a partir de `.env.example` con secretos nuevos
(`openssl rand -hex 32`, `pnpm operator:hash-password`) y la misma `DATABASE_URL` si la conoces;
si conservas la `BACKUP_KEY` antigua en el gestor de secretos, ponla en `BACKUP_KEYS_PREVIOUS`
para poder restaurar las copias anteriores (sin ella no se pueden restaurar). Después,
`instance:check` y `instance:sync`.

**Instancia existente antes de la 009** (sin secreto de salud): `pnpm instance:health-secret <id>`
lo añade a su entorno sin mostrarlo (`--rotate` para cambiarlo); despliega el entorno y ejecuta
`pnpm instance:sync <id> <fichero>` para guardar su huella.

**Instancia existente antes de la 007**: regístrala con
`pnpm instance:register <entorno> --client "<nombre>" [--status testing]`. Si algún secreto no
cumple las reglas de calidad o coincide con otra instancia, `instance:check` lo dirá: rótalo y haz
`instance:sync`.

### 2.5 Despliegue

Receta de producción (013). Cada paso trae un ejemplo y una **comprobación**: si una comprobación
no da lo esperado, **no sigas**. Los ejemplos usan nginx, `docker run` y Trivy; son sustituibles
por herramientas equivalentes, siempre que se cumpla la comprobación. En los ejemplos, `operador`
es el usuario de la máquina que despliega y `cliente-x` el `id` de la instancia.

0. **Construir la imagen en el servidor** (si no la trae ya la integración continua del paso 11).
   Antes, en tu equipo, `pnpm lint && pnpm typecheck && pnpm test` en verde y la etiqueta Git
   `vX.Y.Z` creada ([5.1](#51-comprobaciones-previas-en-tu-equipo)). En el servidor, siempre desde
   la etiqueta y nunca desde una copia con cambios sin publicar:

   ```bash
   git clone <repositorio> /srv/chatbot/nucleo     # la primera vez; después: git fetch --tags
   cd /srv/chatbot/nucleo && git checkout vX.Y.Z
   docker build --build-arg CORE_VERSION=X.Y.Z -t chatbot:X.Y.Z .
   trivy image --severity HIGH,CRITICAL --ignore-unfixed chatbot:X.Y.Z
   ```

   - Docker Engine 25 o posterior (`docker version`), para el `--start-interval` del
     `HEALTHCHECK` (paso 9).
   - La construcción instala también las dependencias de desarrollo y compila: en un servidor con
     poca memoria, añade swap o construye con las instancias sin carga.
   - En la copia del repositorio del servidor **no** hay ficheros de entorno: los de las
     instancias viven fuera (paso 2), y `.gitignore` excluye `.env*` y las claves.
   - Si la construcción falla al descargar pnpm con «unable to verify the first certificate», algo
     intercepta HTTPS en esa máquina (un proxy o un antivirus): construye en otra sin
     interceptación; no se toca el `Dockerfile`.
   - Con varios servidores, construye una vez y súbela a un registro privado, para que todos usen
     exactamente la misma imagen.

   Comprobación: `docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.version" }}' chatbot:X.Y.Z`
   da `X.Y.Z`; `docker image inspect chatbot:X.Y.Z --format '{{json .Config.Healthcheck}}'` muestra
   `dist/src/cli/healthcheck.js`; y Trivy no da nada que bloquee (paso 11).

1. **`instance:check` APTO con el entorno definitivo.**

   ```bash
   pnpm instance:check cliente-x.env; echo "salida $?"
   ```

   Comprobación: `APTO para desplegar.` y `salida 0`. En producción son error, entre otros,
   `TRUST_PROXY` vacío con `PUBLIC_BASE_URL` en `https` (`trust_proxy_empty`) y cualquier URL de
   base de datos remota sin `sslmode=verify-full` (`database_tls_required`, o `database_tls_ip_host` si el servidor va por IP;
   [2.4](#24-completar-y-validar-pnpm-instancecheck)).

2. **Fichero de entorno con dueño el operador y modo `0600`**, pasado al contenedor con
   `--env-file` (nunca con `-e VARIABLE=valor`, que queda en el historial de la shell).

   ```bash
   chown operador: cliente-x.env && chmod 600 cliente-x.env
   ```

   Comprobación: `stat -c '%U %a' cliente-x.env` da `operador 600`.

3. **Volumen de copias con dueño UID 1000 (el usuario `node` de la imagen) y modo `0700`.**

   ```bash
   install -d -o 1000 -g 1000 -m 700 /srv/chatbot/cliente-x/backups
   ```

   Comprobación: `stat -c '%u %a' /srv/chatbot/cliente-x/backups` da `1000 700`.

4. **TLS verificado hacia PostgreSQL.** Si el servidor de base de datos no está en la misma
   máquina, `DATABASE_URL` y `BACKUP_VERIFY_URL` llevan `sslmode=verify-full`. Si el certificado
   del servidor lo firma una autoridad propia (no pública), monta su certificado en **solo
   lectura** y añade `sslrootcert` con la ruta **dentro del contenedor**:

   ```bash
   # en el entorno
   DATABASE_URL=postgres://chatbot_cliente_x:…@db.interna:5432/chatbot_cliente_x?sslmode=verify-full&sslrootcert=/etc/chatbot/db-ca.crt
   BACKUP_VERIFY_URL=postgres://verificador:…@verificacion.interna:5432/postgres?sslmode=verify-full&sslrootcert=/etc/chatbot/db-ca.crt
   # en docker run (paso 5)
   -v /srv/chatbot/db-ca.crt:/etc/chatbot/db-ca.crt:ro
   ```

   Pon en la URL el **nombre** del servidor tal como figura en su certificado, **nunca una IP**:
   con una IP, la librería de PostgreSQL no le pasa la dirección a TLS y el certificado se compara
   con `localhost`, así que la comprobación del nombre deja de proteger. Por eso `instance:check`
   da error `database_tls_ip_host` e `instance:db` se niega a conectar. Las variables `PG*` del
   entorno no cuentan: la regla mira solo la URL.

   Comprobación: `instance:check` sin `database_tls_required` y la instancia arranca. Si el
   certificado no vale, no arranca y muestra
   `DATABASE_URL: el certificado del servidor no es válido para ese nombre o no lo firma una autoridad de confianza.`;
   si el fichero no se puede leer,
   `DATABASE_URL: no se puede leer el certificado de la autoridad indicado en sslrootcert.`
   Ninguno de los dos muestra la URL ni la ruta.

5. **Contenedor endurecido**: raíz de solo lectura, `/tmp` en memoria, sin capacidades, sin
   escalada de privilegios y el puerto solo en local (paso 6).

   ```bash
   docker run -d --name cliente-x \
     --read-only --tmpfs /tmp \
     --cap-drop=ALL --security-opt no-new-privileges \
     -p 127.0.0.1:3000:3000 \
     --env-file cliente-x.env \
     -v /srv/chatbot/cliente-x/backups:/var/lib/chatbot/backups \
     -v /srv/chatbot/db-ca.crt:/etc/chatbot/db-ca.crt:ro \
     chatbot:X.Y.Z
   ```

   Usa la **misma imagen etiquetada** que el resto (`chatbot:X.Y.Z`, nunca `latest`). Al arrancar
   aplica las migraciones y crea el negocio vacío en "En preparación".

   **Si en vez de `docker run` despliegas con Docker Compose**, el `env_file` necesita
   `format: raw` (Compose ≥ 2.30):

   ```yaml
   env_file:
     - path: /srv/chatbot/cliente-x.env
       format: raw
   ```

   `docker run --env-file` pasa los valores tal cual, pero **Compose interpola los `$` que
   encuentra dentro del fichero** y los sustituye por cadena vacía. Le pasa siempre a
   `OPERATOR_PASSWORD_HASH`, que es `$argon2id$v=19$m=65536,…$sal$digest`: la instancia lo recibe
   destrozado, el esquema lo rechaza (`src/config/env.ts`, que exige el prefijo `$argon2id$`) y el
   contenedor se queda **`unhealthy`** reintentando. El síntoma previo son avisos
   `WARN[0000] The "argon2id" variable is not set` al levantar, que además **imprimen trozos del
   hash** en la terminal. Ponlo en **todos** los `env_file` del proyecto: cualquier contraseña
   futura puede llevar un `$`.

   A cambio, `format: raw` **tampoco quita las comillas**, así que los valores del fichero deben
   ir sin ellas. `instance:new` ya escribe así todo salvo los valores con espacios
   (`src/provisioning/env-file.ts`), que habría que desentrecomillar.

   Comprobación:

   ```bash
   docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}' cliente-x
   # true [ALL] [no-new-privileges]
   docker exec cliente-x node dist/src/cli/backup.js   # copia manual: «Copia creada: …»
   ```

   y el panel (`https://…/admin`) pide login con la cookie `Secure`.

6. **Puerto 3000 solo en `127.0.0.1`** (o en una red interna de Docker sin `-p`): solo el proxy
   inverso habla con la instancia.

   Comprobación: `ss -ltn | grep 3000` muestra `127.0.0.1:3000`, nunca `0.0.0.0:3000` ni `*:3000`;
   desde otra máquina, `curl -m 5 http://<ip-del-servidor>:3000/health` no conecta.

7. **Proxy inverso con TLS que sustituye la dirección de origen.** El proxy debe **reemplazar**
   `X-Forwarded-For` con la dirección real del cliente, no añadirla a la que mande el cliente; y
   `TRUST_PROXY` es el número real de saltos de proxy (`1` si solo está este). Ejemplo con nginx:

   ```nginx
   server {
     listen 443 ssl;
     server_name cliente-x.tudominio.com;
     # ssl_certificate y ssl_certificate_key del dominio
     location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-Proto https;
       proxy_set_header X-Forwarded-For $remote_addr;   # sustituye, no añade
     }
   }
   ```

   Comprobación, desde una máquina **externa**, 31 peticiones en menos de un minuto, cada una con un
   `X-Forwarded-For` falso distinto:

   ```bash
   for i in $(seq 31); do
     curl -s -o /dev/null -w '%{http_code}\n' -H "X-Forwarded-For: 10.9.8.$i" https://cliente-x.tudominio.com/health
   done
   ```

   La última da `429`: la instancia cuenta la dirección real y no la falsa (límite de `/health`: 30
   por minuto y dirección). Desde **otra** máquina, en ese mismo minuto, `/health` sigue dando `200`.
   Si las 31 dan `200`, el proxy añade en lugar de sustituir o `TRUST_PROXY` cuenta saltos de más:
   cualquiera podría saltarse los límites de abuso cambiando la cabecera.

8. **Servidor de verificación de copias separado del de producción**, con **un único** usuario de
   verificación por servidor, con `CREATEDB` y **sin** acceso a las bases de las instancias.

   ```sql
   -- en el servidor de verificación
   CREATE ROLE verificador LOGIN CREATEDB PASSWORD '…';
   ```

   Comprobación: `docker exec cliente-x node dist/src/cli/verify.js <copia>` da `RESTAURABLE`, y
   `psql "postgres://verificador:…@db.interna:5432/chatbot_cliente_x?sslmode=verify-full"`
   (servidor de producción) es rechazado. Las bases temporales de `db:verify` no admiten
   conexiones de otros usuarios y las huérfanas se limpian solas ([sección 8](#8-copias-de-seguridad-guía-de-validación)).

9. **Estado de salud del contenedor.** La imagen trae un `HEALTHCHECK` sobre la vista pública de
   `/health` (sin `HEALTH_SECRET`, que así no aparece en `docker inspect`): 120 s de gracia para
   las migraciones, y después sana solo con `{"status":"ok"}`.

   Comprobación: `docker inspect -f '{{.State.Health.Status}}' cliente-x` pasa de `starting` a
   `healthy` en menos de 2 minutos. Con Docker Engine anterior al 25 se ignora `--start-interval` y
   el primer sondeo llega a los 30 s: sigue entrando en los 2 minutos.

10. **Si el contenedor está `unhealthy`.** Docker **no** reinicia por sí solo un contenedor
    `unhealthy` (ni con `--restart`, que solo actúa si el proceso termina): reinícialo tú o tu
    orquestador, pero **antes** mira por qué:

    ```bash
    docker inspect --format '{{json .State.Health}}' cliente-x   # últimos sondeos y su código
    pnpm instance:versions --only cliente-x                       # estado y esquema (sección 5)
    ```

    | `instance:versions` | Causa probable | Qué hacer |
    |---|---|---|
    | `Degradado` | La BD no responde o el esquema no es el esperado | Revisa antes la BD (servidor, red, certificado); reiniciar no lo arregla |
    | `No lista` | Arrancando o parándose | Espera un minuto y repite |
    | `No responde` | Proceso caído, migrando o red | Mira los registros del contenedor (`docker logs cliente-x`): `migration_blocked` / `migration_failed` ([5.4](#54-vuelta-atrás)) |

    Reinicia (`docker restart cliente-x`) solo cuando la causa esté resuelta.

11. **Integración continua** (antes de publicar una imagen). Pasos, en este orden:

    ```bash
    pnpm install --frozen-lockfile
    pnpm lint && pnpm typecheck && pnpm test
    pnpm audit --prod
    osv-scanner scan --lockfile pnpm-lock.yaml
    gitleaks detect --source . -v
    semgrep scan --config auto src/
    docker build --build-arg CORE_VERSION=X.Y.Z -t chatbot:X.Y.Z .
    trivy image --severity HIGH,CRITICAL --ignore-unfixed chatbot:X.Y.Z
    ```

    | Paso | Bloquea la publicación si encuentra |
    |---|---|
    | `lint`, `typecheck`, `test` | Cualquier fallo |
    | `pnpm audit --prod` | Vulnerabilidad alta o crítica en una dependencia de producción |
    | `osv-scanner` | Lo mismo, en dependencias de producción |
    | `gitleaks` | Cualquier hallazgo sin revisar |
    | `semgrep` | Hallazgos de severidad `ERROR` |
    | Trivy | Vulnerabilidad alta o crítica con corrección disponible |

    El criterio es el de la [sección 11.4](#114-criterio-de-severidad-y-de-salida-a-producción). El
    lockfile congelado, el hash de pnpm en `packageManager` (lo comprueba Corepack) y los scripts de
    instalación limitados a `argon2` y `esbuild` (`pnpm.onlyBuiltDependencies`) hacen que la
    instalación sea la misma en cada construcción. Para mantener al día el digest de la base y las
    dependencias puede añadirse un bot de actualizaciones cuando haya repositorio remoto.

12. **Imagen base fijada.** El `Dockerfile` fija `node:22-slim` por digest en `ARG NODE_IMAGE`,
    común a sus dos etapas. Para actualizarla, sigue la [sección 5](#5-actualizar-el-núcleo)
    («Actualizar la imagen base»).

    Comprobación: la prueba de fijado (`pnpm test:unit image-pinning`) pasa, y dos construcciones
    con el mismo `NODE_IMAGE` parten de la misma base: las primeras capas de
    `docker image inspect -f '{{json .RootFS.Layers}}' chatbot:X.Y.Z` coinciden.

Después del despliegue, comprueba la versión: `pnpm instance:versions --only <id>` da `Correcto`
con la versión desplegada, y anótala con `--annotate` ([sección 5](#5-actualizar-el-núcleo)).

### 2.6 Configuración del negocio (en el panel de producción)

1. Rellena datos del negocio, horarios, servicios, precios y preguntas frecuentes. Si ya los
   preparaste en una instancia de pruebas, llévalos con el fichero (ver abajo) en vez de teclearlos.
2. Resuelve los avisos críticos: el sistema no deja activar un negocio que los tenga (FR-032).
3. Consumo (010): moneda de coste, precio de `LLM_MODEL` y tope mensual de gasto
   ([sección 4.1](#41-consumo-precios-y-tope-en-el-panel-010)). No viajan en el fichero de
   configuración: se ponen en cada instancia.
4. Prueba en "Probar el bot" las preguntas típicas del sector y alguna trampa (precio no
   registrado, "quiero hablar con una persona").
5. Pasa el negocio a activo.
6. Chat web: webs permitidas, enlace de privacidad, topes diarios y mensuales acordes a lo
   contratado, y activar. Entrega al cliente el fragmento `<script>`.
   Si el cliente quiere el chat con su imagen, **Diseño del chat** (011): colores, forma, posición,
   tamaño, nombre, bienvenida, textos y logo, avatar e icono, con vista previa. Es opcional (sin
   diseño el chat tiene el aspecto original), se aplica en la siguiente carga sin tocar el
   fragmento y viaja en el fichero de configuración. Tras actualizar el núcleo a la 011, los
   navegadores que tengan `widget.js` en caché ven la esquina y el tamaño originales hasta una
   hora después; los colores y textos se ven al momento.
7. WhatsApp: registra en Meta el webhook `https://…/webhooks/whatsapp` con el `WHATSAPP_VERIFY_TOKEN`
   y envía un mensaje de prueba.

El **tema del panel** (014) no es configuración del negocio y no hace falta tocarlo en el alta: el
panel sigue la preferencia de color del sistema y el control **Tema** de la barra superior permite
forzar claro u oscuro. La elección se guarda en una cookie de ese navegador (`kb_theme`, un año),
así que es de cada persona y cada equipo: no viaja en el fichero de configuración, no entra en las
copias y no se comparte entre navegadores. Lo que ven los clientes finales en el chat web no cambia
con el tema del panel.

#### Llevar la configuración de pruebas a producción (008)

1. En el panel de la instancia de pruebas, **Exportar e importar** → **Exportar**. Se descarga
   `configuracion-<INSTANCE_ID>-<AAAAMMDD-HHMM>.json`. Marca "Incluir destinos de avisos" solo si
   quieres llevarlos: importarlos en pruebas haría escribir al negocio real, y en producción solo
   conviene si son los definitivos. Por defecto no se incluyen.
2. En el panel de producción, **Importar** → elige el fichero. Si no es válido (ilegible, de otra
   herramienta, de una versión futura, con reglas incumplidas o de más de 5 MB) se rechaza con la
   lista completa de errores y no cambia nada. Desde la 011 el formato es el **2** e incluye el
   diseño del chat con sus imágenes; un fichero del formato 1 se sigue importando como "sin
   diseño", así que el destino vuelve al aspecto original del chat (la vista previa lo avisa).
3. Revisa la **vista previa**: qué se añade, cambia y elimina por sección, los avisos resultantes y
   si se aplicará. Si el negocio está activo y el resultado dejaría un aviso crítico, o el chat web
   activado perdería webs permitidas o enlace de privacidad, la importación se bloquea.
4. Si el fichero trae destinos de avisos, marca la casilla y pulsa "Actualizar vista previa"
   para incluirlos; sin marcarla se conservan los de producción.
5. **Confirma.** Se reemplaza toda la configuración en una transacción. La importación **nunca**
   cambia el estado del negocio (preparación/activo) ni activa o desactiva el chat web: eso lo
   decides tú. Si la configuración cambió desde la vista previa, se rechaza y hay que revisar de nuevo.
6. **Deshacer**: antes de aplicar se guarda la configuración anterior (con sus destinos de avisos).
   Descárgala en "Configuración anterior a la última importación" e impórtala como cualquier
   otro fichero. Solo se conserva la de la última importación; entra en las copias de seguridad.

Regla para el desarrollo: **toda spec que añada o cambie configuración del negocio sube
`formatVersion` en `src/config-transfer/format.ts` y añade su actualizador** (lo vigila el test de
cobertura de columnas). Así los ficheros antiguos siguen importándose en núcleos nuevos.

### 2.7 Cierre del alta

- [ ] Copia de seguridad inicial: `node dist/src/cli/backup.js` en el contenedor.
- [ ] Copia comprobada con la [guía de validación de copias](#8-copias-de-seguridad-guía-de-validación)
      (`pnpm db:verify <copia> --json > v.json`) y anotada:
      `pnpm instance:verified <id> v.json` (rechaza el informe de otra instancia).
- [ ] Inventario al día: `pnpm instance:update <id> --status active --image X.Y.Z
      --llm-workspace "<workspace>"` (y `--backup-key-location` si no lo hiciste en 2.2).
- [ ] `pnpm instance:list` muestra la instancia activa. La marca `!` señala las activas sin una
      verificación de copia correcta en los últimos 31 días.
- [ ] El cliente sabe cómo pedirte cambios (canal y plazo).

---

## 3. Aislamiento entre clientes

El código no tiene `tenant_id`: **el aislamiento depende por completo de cómo se despliega.** Estas
reglas no son opcionales.

1. **Una BD por cliente, con usuario propio.** Si dos instancias apuntaran a la misma BD, cada una
   vería los datos y conversaciones de la otra.
2. **Secretos únicos por instancia.** Un `SESSION_SECRET` repetido permitiría reutilizar una sesión
   del panel de un cliente en otro con la misma credencial.
3. **Credencial de operador distinta por instancia.** Si se filtra una, solo cae un panel.
4. **Nunca clonar BD** de localhost ni de otro cliente para empezar uno nuevo.
5. **Clave de Anthropic por cliente** (ver sección 4).
6. **Núcleo sin lógica de cliente.** Nada de `if cliente === …` en `src/`. Lo vigila
   `pnpm test sector-neutrality`; no se desactiva.
7. **Extensiones aisladas.** Una extensión de un cliente no puede afectar a otras instancias, y
   retirarla deja la instancia con el comportamiento del núcleo (Principio III).
8. **Logs sin datos personales.** Los registros técnicos ya no guardan textos, números, tokens ni
   IP; no añadas nada que rompa esa regla al depurar un cliente concreto.

---

## 4. Coste de la API

Dos modelos posibles; elige uno por cliente y déjalo por escrito en el contrato.

| Modelo | Cómo funciona | Ventajas | Inconvenientes |
|---|---|---|---|
| **Clave tuya, workspace por cliente** | Creas en la consola de Anthropic un workspace por cliente, con su clave y su límite de gasto, y repercutes el coste | Controlas el modelo y el gasto; facturación clara por cliente | Adelantas tú el pago |
| **Clave del cliente** | El cliente crea su cuenta y te da la clave | El cliente paga directamente a Anthropic | Dependes de que mantenga su cuenta al día; si se queda sin saldo, el bot deja de responder |

En los dos casos:

- Nunca uses la misma clave para varios clientes: no sabrías cuánto consume cada uno, no podrías
  cortar a uno sin afectar a los demás y una filtración expondría a todos.
- Ajusta los topes del chat web (200 al día y 3 000 al mes por defecto) a lo contratado.
- Pon el **tope mensual de gasto** de la instancia (feature 010, abajo) por debajo del límite de
  gasto del workspace de Anthropic: el del panel corta con el contacto del negocio y deja derivar a
  una persona; el del workspace, en cambio, deja al bot sin modelo.

### 4.1 Consumo, precios y tope en el panel (010)

La página **Consumo** (`/admin/usage`) de cada instancia muestra los tokens y el coste estimado del
modelo de hoy, del mes en curso y de los 12 meses anteriores, por canal (WhatsApp, Chat web y
"Probar el bot") y con los totales de **Clientes finales** (lo facturable al cliente) e
**Instancia**. No identifica conversaciones ni clientes. Guía de validación:
[specs/010-usage-cost-cap/quickstart.md](../specs/010-usage-cost-cap/quickstart.md).

En el alta, tras desplegar (antes de abrir el tráfico):

1. **Moneda de coste**: la de la factura del proveedor (USD por defecto). Solo se puede cambiar con la
   tabla de precios vacía.
2. **Precios por modelo**: añade al menos el de `LLM_MODEL` (la pantalla lo marca y ofrece añadirlo
   con el nombre puesto), por millón de tokens de entrada, salida, escritura y lectura de caché,
   copiados de la lista de precios del proveedor. El coste se fija al registrar: actualiza los
   precios cuando cambien y el pasado conserva el suyo. Lo consumido sin precio sale «sin precio».
3. **Tope mensual**: importe en la moneda de coste. Exige el precio de `LLM_MODEL`. Un tope por
   debajo del gasto ya hecho se acepta y corta en el siguiente mensaje.

Qué ocurre con el tope activo:

| Gasto del mes local | Panel | WhatsApp | Chat web | "Probar el bot" |
|---|---|---|---|---|
| < 80 % | — | Normal | Normal | Normal |
| ≥ 80 % | Aviso «Gasto del mes al N % del tope» en todas las pantallas | Normal | Normal | Normal |
| ≥ 100 % | Aviso crítico en todas las pantallas | Contacto del negocio sin modelo (`R-CAP`); una petición de persona se deriva con el resumen literal | "No disponible" con el contacto | Normal y suma al gasto |

- Se reanuda sin reiniciar al subir el tope por encima del gasto, al desactivarlo o al empezar el
  mes local. El registro de actividad emite `spend_cap_reached` una vez al mes.
- Si se borra el precio de `LLM_MODEL` con el tope activo, el panel avisa en todas las pantallas:
  ese consumo no cuenta para el tope hasta que vuelva a tener precio.
- Las respuestas que ya estaban en curso al cruzar el tope terminan y se registran: el exceso queda
  acotado a las respuestas simultáneas (`processorConcurrency`).
- Los precios, la moneda y el tope **no** viajan en la exportación de la configuración (008): hay que
  ponerlos en cada instancia. El consumo sí entra en las copias de seguridad.
- El estado del tope de todo el parque se ve en la columna **Tope** de `pnpm instance:versions`
  ([sección 5](#5-actualizar-el-núcleo)).

**En producción (feature 012) el tope es obligatorio** y falla cerrado:

- Con `NODE_ENV=production`, sin tope activo, sin precio para `LLM_MODEL` o, con
  `AUDIO_TRANSCRIPTION=on`, sin precio de transcripción para `STT_MODEL`, el negocio **no se puede
  activar** y, si ya estaba activo, los clientes reciben solo el contacto (WhatsApp `R-CAP`, chat web
  «no disponible»). El panel lo muestra en una banda roja en todas las pantallas y `/health` da
  `spendCap: "blocked"` (`bloqueado` en `instance:versions`).
- Si el gasto no se puede leer (consulta fallida o de más de 2 s), tampoco se llama al modelo.
- Con el negocio activo en producción no se puede desactivar el tope ni borrar esos precios.
- **Tope diario de WhatsApp** (por defecto 200 respuestas con modelo al día, 1–10 000): al llegar,
  WhatsApp responde `R-CAP` hasta las 00:00 locales; las peticiones de persona se siguen derivando.
  Se ajusta en «Consumo» → «Tope diario de WhatsApp».
- **Precios de transcripción** (por minuto de audio, en la moneda de coste): cada audio transcrito
  suma al gasto del mes y se comprueba el tope **antes** de descargarlo. Se ponen en «Consumo» →
  «Precios de transcripción».
- Nada de esto viaja en la exportación de la configuración (008); sí entra en las copias.

### 4.2 Límites de derivación (012)

Cada instancia limita lo que un cliente final puede hacer llegar al negocio. Se ajustan en
«Consumo» → «Límites de derivación», que muestra también los contadores de hoy (derivaciones
nuevas, peticiones sin aviso, avisos y avisos retenidos). Valen desde el siguiente mensaje.

| Límite | Por defecto | Mínimo | Máximo | Al alcanzarlo |
|---|---|---|---|---|
| Derivaciones nuevas al día | 20 | 1 | 200 | El cliente recibe `R-HANDOFF-FAIL` con el contacto del negocio; el negocio no recibe nada |
| Minutos entre avisos de una derivación | 15 | 5 | 240 | Lo que escribe el cliente espera y sale en **un** aviso agrupado al cumplirse el intervalo |
| Avisos al negocio al día | 60 | 10 | 500 | Los reenvíos esperan a las 00:00 locales; los recordatorios no se envían (el cliente sí recibe su aviso de retraso); el panel avisa |

- Cuentan las alertas, los reenvíos y los recordatorios (uno por aviso, salga por una o por dos
  vías). «Probar el bot» ni cuenta ni se limita.
- Si una derivación termina con mensajes esperando el intervalo, quedan **retenidos (no
  reenviados)**: se ven en «Derivaciones» → «Mensajes retenidos» y el bot no los contesta.
- En los avisos, el texto del cliente va entre comillas y con las direcciones desactivadas
  (`ejemplo[.]com`).
- Como los precios, estos límites no viajan en la exportación de la configuración.

### 4.3 Proveedor del modelo: qué cambia entre los tres (017)

Cada instancia elige su proveedor en su propio fichero de entorno —`LLM_PROVIDER` con
`anthropic`, `gemini` u `openai`— y nada más. No hay una imagen distinta por proveedor, y el
panel, los canales y la conversación no saben quién hay detrás.

- **Sin `LLM_PROVIDER` la instancia es de Anthropic**, que es lo que ya eran. Los entornos de las
  instancias desplegadas **no se tocan** al actualizar.
- `LLM_MODEL` es **obligatoria** con Gemini y con OpenAI. Con Anthropic conserva su valor por
  defecto. Un nombre de modelo equivocado se parece mucho a un fallo del proveedor, así que es
  mejor que lo declare el entorno que inventar un valor por defecto que envejezca en el código.
- La credencial va en la variable **de su proveedor**: `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` u
  `OPENAI_API_KEY`. Las de los demás proveedores **no** se usan como respaldo: manda el declarado,
  y si su credencial no está, la instancia no arranca.
- El proveedor elegido queda anotado en el inventario (`pnpm instance:list`, columna
  `PROVEEDOR`). La credencial, nunca. Un inventario anterior a la 017 muestra `—` hasta el primer
  `pnpm instance:sync`.

#### Qué conserva, qué traduce y qué no tiene cada uno

Esta tabla **no es informativa**: está declarada en `src/llm/capabilities.ts` y
`tests/unit/llm/capabilities.test.ts` la compara con lo que hacen los tres adaptadores **y** con
este texto, celda a celda. Si alguien cambia un adaptador y no actualiza las dos, la suite falla.

| Capacidad | `anthropic` | `gemini` | `openai` |
|---|---|---|---|
| Esquema de salida obligado | sí (tolerante) | sí (tolerante) | sí (modo estricto) |
| Mando de esfuerzo | sí | sí | según modelo |
| Razonamiento interno | sí | sí (no siempre apagable) | según modelo |
| Marca explícita de caché | sí | no | no |
| Tokens de lectura de caché | sí | sí | sí |
| Tokens de escritura de caché | sí | no | sí |
| Señal propia de rechazo | sí (motivo de parada) | sí (bloqueo de seguridad) | sí (elemento de contenido) |

Fila por fila, y qué pasa en cada caso:

1. **Esquema de salida obligado.** Los tres obligan a que la respuesta tenga la forma del esquema
   del dominio, y los tres la revalidan después con Zod: el esquema sigue siendo la única puerta.
   El modo estricto de OpenAI **no admite propiedades opcionales**, así que su adaptador las
   promueve a obligatorias admitiendo `null` y normaliza los nulos a «ausente» a la vuelta, para
   que los valores por defecto del dominio se apliquen igual. Se **traduce**; el dominio no se
   toca.
2. **Mando de esfuerzo.** `LLM_EFFORT` se traduce directo en los tres. En OpenAI depende del
   modelo: si el modelo configurado no admite el parámetro, el adaptador **no lo silencia** —deja
   una línea en el registro, reintenta una vez sin él y recuerda la decisión para el resto de la
   vida del proceso—. Esto es **degradación declarada**, no un ajuste ignorado.
3. **Razonamiento interno.** Se usa donde existe y se prescinde de él donde no, sin que cambie la
   forma de la respuesta. En Gemini algunos modelos **no lo apagan del todo**, y en OpenAI depende
   del modelo. Por eso `LLM_EFFORT=medium` no significa lo mismo en los tres y por eso la
   evaluación es obligatoria por proveedor.
4. **Marca explícita de caché.** Solo Anthropic la tiene y se **conserva**. Gemini y OpenAI usan su
   caché automática y no se marca nada. La caché explícita de Gemini **se descartó a propósito**:
   obligaría a mantener un contenido en caché con vida propia en el proveedor, que se
   desincronizaría de la información del negocio, porque el prompt del sistema se lee en cada
   respuesta sin caché por decisión del producto. Que nadie la añada de buena fe.
5. **Tokens de lectura de caché.** Los tres los informan.
6. **Tokens de escritura de caché.** Gemini **no informa del concepto**, nunca. En el panel sale
   «sin dato», que no es `0`: un cero afirmaría que el modelo midió y que no hubo nada. Anthropic y
   OpenAI sí informan, así que una respuesta que no escribió caché sale `0`, que es un cero medido.
   La pantalla de consumo lo deduce de lo registrado, no del nombre del proveedor.
7. **Señal propia de rechazo.** Cada uno la señala a su manera y las tres acaban en la **misma**
   causa del dominio, `refusal`. Gemini tiene además dos: el bloqueo del prompt y el del candidato.

Lo que **no** cambia con el proveedor: las cuatro causas de fallo del dominio, el plazo y los dos
intentos por respuesta —que comparten un único presupuesto, porque la política de reintentos de
los SDK está desactivada—, el registro de consumo, el tope de gasto y la salida a una persona.

---

## 5. Actualizar el núcleo

Una versión nueva de la imagen llega a **todos** los clientes y las migraciones se aplican solas al
arrancar. Desde la feature 009 cada instancia declara qué versión corre y en qué estado está, y la
publicación es un procedimiento por etapas: cada paso tiene una comprobación (orden o pantalla), el
resultado esperado y cuándo **parar**. Contrato completo:
[specs/009-version-health-rollout/contracts/release-procedure.md](../specs/009-version-health-rollout/contracts/release-procedure.md).

Herramientas que usa:

- **`GET /health`** en cada instancia. Sin credencial responde solo el estado: `200` con `ok` y,
  desde la 016, `200` con **`db_unavailable`**; `503` con `degraded` / `not_ready`. Sirve a un
  monitor o balanceador.

  **`db_unavailable` responde 200 a propósito** (016): la base de datos no contesta, pero el
  proceso vive y sirve. Si diera 503, la sonda de la imagen marcaría la instancia como enferma,
  la política de reinicio la relanzaría, el arranque intentaría migrar contra una base que sigue
  sin estar y la instancia entraría en un bucle de reinicios con el proxy devolviendo 502: es
  exactamente lo que pasaba antes de la 016. Durante un corte, `schema.applied` y `spendCap`
  llegan en `null`; `coreVersion` y `schema.expected` siguen valiendo, porque se leen del núcleo
  y no de la base de datos. **Qué hacer**: mirar el servidor PostgreSQL, no la instancia; cuando
  la base vuelva, la instancia se recupera sola en menos de 30 s, sin reiniciar nada ni perder
  las sesiones del panel. `degraded` (503) sigue queriendo decir que la base **sí** contesta pero
  su esquema está vacío, es desconocido o no es el esperado: eso sí necesita al operador. Con
  `Authorization: Bearer <HEALTH_SECRET>` añade `instanceId`, `coreVersion`, el esquema aplicado y
  esperado y, desde la 010, `spendCap` (estado del tope de gasto: `none`, `normal`, `warning`,
  `reached`, o `null` si no se pudo leer; no cambia el estado). Nunca muestra datos del negocio,
  conversaciones, secretos, importes ni la causa de un fallo.
  Límite: 30 peticiones por minuto y por IP; un monitor debe sondear **cada 10 s o más** (con
  intervalos de 2 s o menos recibe `429` y da la instancia por caída).
- **Pie del panel**: tras iniciar sesión, todas las pantallas muestran «Núcleo X.Y.Z · Esquema
  000N_…», con el distintivo «Esquema distinto del esperado» si no coincide.
- **`pnpm instance:versions`**: consulta `/health` de todas las instancias del inventario que no
  están de baja (en paralelo, 5 s por instancia) con el `HEALTH_SECRET` de su entorno
  (`<dir. del inventario>/envs/<id>.env` o `--envs-dir`), solo en memoria. Muestra estado, núcleo,
  esquema, versión anotada, si coincide y, en la columna **Tope** (010), el estado del tope de gasto
  (`sin tope`, `normal`, `≥80 %`, `alcanzado` o `—` si la instancia es anterior a la 010 o no lo
  informa), que no cuenta para el resultado ni el código de salida; `--only <id>[,<id>]`, `--json`
  (campo `spendCap`), `--timeout <s>`;
  `--allow-insecure` solo para `http://localhost` en pruebas. Código 0 si todo está `Correcto` y
  coincide con lo anotado, 1 si hay algo que revisar, 2 por argumentos, inventario o clave. No
  escribe nada salvo con `--annotate` (pide confirmación; `--yes` sin terminal), que anota en
  `imageVersion` la versión observada de las filas `Correcto`. Contrato:
  [instance-versions-command.md](../specs/009-version-health-rollout/contracts/instance-versions-command.md).

| Resultado en `instance:versions` | Significado |
|---|---|
| `Correcto` | Responde, identidad comprobada y esquema = el esperado |
| `Degradado` | La BD no responde o el esquema no es el que espera el núcleo |
| `No lista` | Arrancando o parándose |
| `No responde` | Red, DNS, TLS, tiempo agotado; también **mientras migra** (no escucha hasta terminar) |
| `Respuesta no válida` | No cumple el contrato (o redirige: el secreto nunca se envía a otra dirección) |
| `Sin información de versión` | `404`: imagen anterior a la 009 |
| `Secreto rechazado` | `401`: el `HEALTH_SECRET` del entorno no es el de la instancia, **o la instancia aún no tiene desplegado su `HEALTH_SECRET`** |
| `Límite de peticiones` | `429`: algo está sondeando demasiado |
| `Solo estado` | No hay `HEALTH_SECRET` en el entorno de tu equipo: solo se ve el estado |
| `Identidad distinta` | La URL del inventario lleva a **otra** instancia: no se le atribuye versión |
| `No consultada` | Sin URL o URL no `https` |

**Desde la versión que incluye la 013**, entornos que antes daban `APTO` con advertencias pueden
dar `NO APTO`: `TRUST_PROXY` vacío con `https` (`trust_proxy_empty`) y URL de base de datos
remotas sin `sslmode=verify-full` (`database_tls_required`, también en `BACKUP_VERIFY_URL`) pasan
a ser error en producción. Antes de la tanda de cada instancia, pasa su entorno por
`instance:check` con el núcleo nuevo y corrígelo ([5.1](#51-comprobaciones-previas-en-tu-equipo)).
La instancia sigue arrancando con una URL sin `verify-full` (la regla vive en `instance:check`), pero
no se despliega una instancia `NO APTO`.

### 5.0 Antes de la primera vez (una vez por instancia)

| Comprobación | Esperado | Si no |
|---|---|---|
| `pnpm instance:health-secret <id>` (instancias anteriores a la 009) y despliegue del entorno | La instancia responde `/health` completo | No publicar a esa instancia hasta tenerlo: no se podrá comprobar su versión |
| `pnpm instance:sync <id> <entorno>` y `pnpm instance:check <entorno>` | `APTO`, con `HEALTH_SECRET` presente y no repetido | Corregir lo que indique |
| `pnpm instance:versions` | Todas las instancias en `Correcto` y «Coincide: sí» (si falta la anotación, `--annotate`) | Resolver antes de empezar: una instancia ya degradada no es un buen punto de partida |
| Si un monitor o balanceador consulta `/health`, revisar su intervalo | Cada 10 s o más (límite: 30 por minuto y por IP) | Ampliar el intervalo: con menos recibe `429` y da la instancia por caída |
| Antes de la tanda que lleve la 012 o posterior: tope de gasto y precios en «Consumo» de cada instancia | Tope activo y precio de `LLM_MODEL` (y de `STT_MODEL` con audios) | Sin ellos, la instancia actualizada responde solo con el contacto y no deja activar el negocio ([sección 4.1](#41-consumo-precios-y-tope-en-el-panel-010)) |
| `pnpm instance:check <entorno>` con el núcleo nuevo | `APTO`: ningún secreto corto, de ejemplo, trivial o repetido y `HEALTH_SECRET` presente | Rotar los secretos que indique **antes** de desplegar: desde la 012 la instancia de producción **no arranca** con ellos (mismas reglas que `instance:check`) |

`instance:health-secret` genera el secreto, lo escribe en el entorno sin tocar el resto del
fichero y **no lo muestra**; con `--rotate` lo cambia. Las instancias nuevas ya nacen con él
(`instance:new`).

### 5.1 Comprobaciones previas (en tu equipo)

| Comprobación | Esperado | Criterio |
|---|---|---|
| Subir `version` en `package.json` (semántica, `X.Y.Z`) y commit | Un solo número nuevo; nunca se reutiliza uno ya desplegado | — |
| `pnpm lint && pnpm typecheck && pnpm test` | Verde | **Parar** si falla |
| `pnpm test:eval` y `EVAL_CHANNEL=web pnpm test:eval` | Sin regresiones en los criterios | **Parar** si hay regresión |
| Revisar las migraciones nuevas | Solo añadir; ficheros ya publicados intactos (reglas al final de esta sección) | **Parar** si se editó una migración publicada |
| Etiqueta Git `vX.Y.Z` y `docker build --build-arg CORE_VERSION=X.Y.Z -t chatbot:X.Y.Z .` | La construcción termina; si `CORE_VERSION` falta o ≠ `package.json`, falla | **Parar** si falla. **Nunca `latest`** |
| `docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.version" }}' chatbot:X.Y.Z` | Imprime `X.Y.Z`, igual que la etiqueta `-t` | **Parar** si difiere: la etiqueta `-t` la eliges tú, el `Dockerfile` no la controla |
| Desde la 013: `pnpm instance:check <entorno>` de **cada** instancia de la tanda, con el núcleo nuevo | `APTO` | **Parar** esa instancia hasta corregir su entorno (`trust_proxy_empty`, `database_tls_required`) |
| Pasos de integración continua de la [2.5](#25-despliegue) (paso 11) | Ninguno bloquea | **Parar** si alguno bloquea ([11.4](#114-criterio-de-severidad-y-de-salida-a-producción)) |

**Dos matices del guión, aprendidos en el despliegue de la 0.1.2 (2026-10-13).**

- **`pnpm test:eval` no siempre aplica.** La tabla la pide en cada versión, pero mide la cadena de
  respuesta del bot. Si la versión **no toca** `src/conversation`, `src/knowledge`, los prompts ni
  el modelo —compruébalo con `git diff main..HEAD -- src/`—, la evaluación mediría exactamente lo
  mismo que la versión anterior y cuesta dinero: se puede saltar **dejando escrito en el cierre de
  la spec qué ficheros cambiaron**. Si toca cualquiera de esos sitios, no es opcional.
- **No hay instancia de pruebas.** El §5.2 supone una instancia con datos ficticios que hoy no
  existe: las dos del inventario son de cliente. Mientras siga así, su papel lo hace la **primera
  tanda** del §5.3 —una sola instancia, verificada con `instance:versions` antes de seguir—, y la
  vuelta atrás del §5.4 es la red de seguridad. Anotarlo en el cierre de cada versión.

**Actualizar la imagen base.** El `Dockerfile` fija `node:22-slim` por el digest de su índice
multiplataforma en `ARG NODE_IMAGE` (013). Para pasar a una base nueva (parche de seguridad de
Node o de Debian):

1. `docker buildx imagetools inspect node:22-slim` y copia el campo `Digest` (`sha256:…`, el del
   índice, no el de una plataforma).
2. Cámbialo en `ARG NODE_IMAGE=node:22-slim@sha256:<digest>`.
3. Construye y pasa las pruebas (`pnpm test` incluye la de fijado; Trivy, paso 11 de la 2.5).
4. Publícala como **versión nueva** del núcleo, con este mismo procedimiento.

### 5.2 Instancia de pruebas

| Comprobación | Esperado | Criterio |
|---|---|---|
| Desplegar `chatbot:X.Y.Z` en la instancia de pruebas (datos ficticios, entorno como producción) | Arranca; si había migraciones, hizo la copia `…__premigration.cbak` | **Parar** si los registros muestran `migration_blocked` o `migration_failed` (ver 5.4) |
| `pnpm instance:versions --only <pruebas>` | `Correcto`, núcleo `X.Y.Z`, esquema el esperado | **Parar** en cualquier otra fila |
| Panel: pie «Núcleo X.Y.Z · Esquema …» y «Probar el bot» con 3 preguntas conocidas | Versión correcta; respuestas coherentes con la configuración | **Parar** si no |
| Si hubo migraciones: [guía de validación de copias](#8-copias-de-seguridad-guía-de-validación) con la copia `premigration` | Verificación correcta | **Parar** si falla |

Si la instancia no puede hacer la copia previa (falta la configuración, el directorio no existe o
no se puede escribir, disco lleno) **no migra ni arranca** y lo registra como `migration_blocked`;
el esquema queda sin cambios.

### 5.3 Tandas de clientes

Tandas pequeñas (una o dos instancias), de menos a más crítica. Para cada instancia de la tanda:

1. Desplegar `chatbot:X.Y.Z` en esa instancia (un solo cambio: la etiqueta).
2. **Comprobación tras actualizar** (menos de 2 minutos):
   - `pnpm instance:versions --only <id>`
   - Panel de la instancia: pie con la versión y el esquema esperados, y sin avisos nuevos.

| Resultado de `instance:versions` | Significado | Criterio |
|---|---|---|
| `Correcto`, núcleo `X.Y.Z`, «Coincide: NO» (anotación vieja) | Actualizada bien; falta anotar | Continuar; se anota en el cierre |
| `Correcto` con otra versión | Se desplegó otra etiqueta | **Parar la tanda**; corregir el despliegue |
| `Degradado` | BD caída o esquema distinto del esperado | **Parar la tanda**; ver 5.4 |
| `No lista` | Arrancando o parándose | Esperar 1 minuto y repetir; si persiste, **parar la tanda** |
| `No responde` | Aún migrando (mientras migra no escucha), no arrancó (p. ej. `migration_blocked`) o red | Esperar a que termine la migración y repetir; si persiste o los registros muestran `migration_blocked` / `migration_failed`, **parar la tanda** |
| `Identidad distinta` | La URL del inventario apunta a otra instancia | **Parar la tanda**; corregir la URL (`instance:update` / `instance:sync`) antes de seguir |
| `Secreto rechazado` / `Solo estado` / `Sin información de versión` | No se puede verificar («Secreto rechazado» también sale si la instancia aún no tiene desplegado su `HEALTH_SECRET`) | **Parar la tanda**: sin verificación no se continúa |

La tanda siguiente solo empieza cuando todas las instancias de la actual están `Correcto` con la
versión nueva.

**Limitación conocida**: la instancia migra **antes** de escuchar, así que mientras migra
`instance:versions` la muestra como `No responde` (nunca como correcta). Distingue "migrando" de
"caída" mirando sus registros: `migration_blocked` / `migration_failed` indican fallo; si no hay
ninguno, espera y repite.

### 5.4 Vuelta atrás

| Situación | Acción | Comprobación posterior |
|---|---|---|
| La migración **no se aplicó** (`migration_blocked`, o falló antes de cambiar el esquema: el error dice «esquema sin cambios») | Arreglar la causa (p. ej. `BACKUP_DIR`, disco) y reiniciar; o volver a desplegar `chatbot:<anterior>` | `instance:versions --only <id>`: `Correcto` y versión anterior |
| La migración **se aplicó**, la versión nueva falla y la anterior es compatible (migración de solo añadir) | Volver a desplegar `chatbot:<anterior>` | `instance:versions`: puede salir `Degradado` por esquema por delante; el pie del panel muestra núcleo anterior y esquema nuevo. Si el negocio sigue atendido, mantener y programar la corrección |
| La migración **se aplicó** y **no es compatible** (`migration_failed`, o `Degradado` por esquema por delante con la instancia sin atender) | **Parar** la instancia; con la **imagen anterior**, restaurar la copia `premigration` que nombra el error: `node dist/src/cli/restore.js <fichero>` | `instance:versions`: `Correcto`, versión y esquema anteriores; repetir la [validación de copias](#8-copias-de-seguridad-guía-de-validación) |

Tras volver atrás **no** se continúa con las tandas siguientes: se detiene la publicación hasta
publicar una versión corregida, con un número de versión nuevo.

### 5.5 Cierre

| Comprobación | Esperado |
|---|---|
| `pnpm instance:versions` con todas las instancias | Todas `Correcto` en `X.Y.Z` |
| `pnpm instance:versions --annotate` (revisa la lista y confirma) | El inventario recoge `X.Y.Z`; una segunda ejecución da «Coincide: sí» y código 0 |
| Si hubo migraciones: [guía de validación de copias](#8-copias-de-seguridad-guía-de-validación) con una copia posterior a la actualización de cada instancia | Verificación correcta, anotada con `instance:verified` |
| Anotar en el registro de la publicación: fecha, versión, tandas e incidencias | — |

### Reglas de las migraciones

A partir de la 006 la restauración de copias antiguas reaplica las migraciones y comprueba su hash:

- Las migraciones son **de solo añadir** (columnas o tablas nuevas antes de dejar de usar las
  viejas).
- Los ficheros de migraciones ya publicados **no se editan nunca**: una copia hecha con ellos
  dejaría de poder restaurarse (`schema_mismatch`), y `/health` lo mostraría como esquema distinto
  del esperado (compara también el hash).

---

## 6. Cambios que pide un cliente

Antes de programar nada, en este orden (Principio II):

1. **¿Se cubre con la configuración actual?** Hazlo en su panel. Sin despliegue.
2. **¿Se cubriría ampliando la configuración de forma válida para cualquier sector?** Spec de
   **núcleo** que no mencione al cliente (solo como ejemplo ilustrativo). Lo reciben todos.
3. **¿Es realmente particular de ese cliente?** Spec de **extensión**, conectada a un punto de
   extensión del núcleo. Si ese punto no existe, primero una spec de núcleo que lo añada de forma
   genérica (ver [P5](#p5-puntos-de-extensión-del-núcleo)).

---

## 7. Baja de un cliente

Empieza con `pnpm instance:retire <id>` (pide escribir el `id` para confirmar; `--yes` sin
terminal). Solo cambia el inventario: la instancia pasa a "de baja" con la fecha de hoy y su `id`,
su BD y sus secretos **siguen contando como usados para siempre**. Las herramientas no borran
nada; los pasos siguientes son manuales:

1. Desactiva el chat web y retira el webhook de WhatsApp en Meta.
2. Entrega al cliente los datos que le correspondan según el contrato.
3. Para el contenedor, revoca su clave de Anthropic y elimina sus secretos.
4. Borra la BD y sus copias de seguridad en el plazo acordado, y anótalo en el inventario con
   `pnpm instance:update <id> --data-deleted <AAAA-MM-DD>`. Las copias viven en el volumen de
   `BACKUP_DIR` (y en sus réplicas o instantáneas, si las hay): borra ese volumen y las réplicas.
   Destruir la `BACKUP_KEY` de la instancia deja ilegibles las copias que quedaran en cualquier
   otro sitio.

---

## 8. Copias de seguridad: guía de validación

Cada instancia copia su BD en `BACKUP_DIR` con los mismos comandos (feature 006):

| Comando (local / en la imagen) | Qué hace |
|---|---|
| `pnpm db:backup` / `node dist/src/cli/backup.js` | Copia bajo demanda, cifrada, sin pausar al bot |
| `pnpm db:restore <fichero>` / `node dist/src/cli/restore.js` | Restaura con la instancia **parada**; pide escribir el `INSTANCE_ID` para confirmar |
| `pnpm db:verify <fichero>` / `node dist/src/cli/verify.js` | Restaura en una BD temporal, compara y la borra; antes limpia las temporales huérfanas |
| `pnpm db:backups [--prune]` / `node dist/src/cli/backups.js` | Lista las copias de la instancia y aplica la retención |

Además, la instancia hace una copia diaria (`BACKUP_DAILY_TIME`, hora local del negocio) y una
previa a cada migración, y borra las de más de `BACKUP_RETENTION_DAYS` días conservando siempre la
última válida. Todos los comandos aceptan `--json` para anotar el resultado en el inventario.

Una copia que no se ha restaurado nunca no está comprobada. Esta guía se hace en menos de 15
minutos.

### Bases temporales de `db:verify` (013)

`db:verify` crea en el servidor de `BACKUP_VERIFY_URL` una base temporal
`verify_<aaaammddhhmmss UTC>_<16 hex>` y, **antes de cargar ningún dato**, retira a `PUBLIC` los
permisos `CONNECT` y `TEMPORARY`: durante la verificación solo puede entrar su dueño (el usuario
de `BACKUP_VERIFY_URL`) y un superusuario. Al terminar la borra siempre.

Si una verificación se interrumpe (el proceso muere), la base queda **huérfana**, con datos reales
de clientes. Cada `db:verify` limpia antes las huérfanas: borra las bases que cumplen **exactamente**
el patrón `verify_<aaaammddhhmmss>_<16 hex>` con una marca de hace más de **6 horas**, o el formato
anterior a la 013 (`verify_<16 hex>`), y que **no tienen ninguna conexión**. Las borra con `DROP`
sin `FORCE`: si alguien se conecta entre la comprobación y el borrado, PostgreSQL lo rechaza y la
base se respeta. Nunca toca una base con otro nombre (las de las instancias se llaman
`chatbot_<id>`) ni una reciente o en uso. Un fallo de la limpieza no detiene la verificación.

La salida dice qué ha pasado, sin nombres de base, antes de la línea de la base temporal (también
si la copia no es restaurable) y solo si hay algo que contar:

| Línea | Significado | Qué hacer |
|---|---|---|
| `Bases temporales huérfanas: 2 borradas.` | Había verificaciones interrumpidas y se han limpiado | Nada |
| `Bases temporales huérfanas: 1 borrada, 1 sin poder borrar (permisos del usuario de BACKUP_VERIFY_URL).` | Hay una huérfana de otro dueño: otra instancia usa otro usuario de verificación en el mismo servidor | Bórrala con un superusuario y usa **un único usuario de verificación por servidor** |
| `Bases temporales huérfanas: no se ha podido comprobar el servidor; puede quedar alguna.` | No se pudo listar el servidor (o la orden terminó antes de conectar, p. ej. con la copia dañada o `db_ca_unreadable`) | Revisa a mano `\l verify_*` con un superusuario |

Con `--json`, el informe lleva `"orphans": { "listed": true, "removed": 1, "failed": 1 }` y el
registro `verify_completed`, `orphansListed`, `orphansRemoved` y `orphansFailed`. El código de
salida sigue dependiendo solo de si la copia es restaurable.

### Cuándo repetirla

- Al dar de alta una instancia ([cierre del alta](#26-cierre-del-alta)).
- **Una vez al mes** por instancia, con la copia diaria más reciente.
- Tras cada actualización del núcleo con migraciones, con la copia `premigration` en la instancia
  de pruebas y, al cerrar la publicación, con una copia posterior a la actualización de cada
  instancia ([sección 5.5](#55-cierre)).
- Tras cambiar `BACKUP_KEY`.

Anota en el inventario la fecha, el fichero y el resultado de `db:verify --json` con
`pnpm instance:verified <id> <informe.json>` (o `-` para leerlo de la entrada estándar).

### Antes de empezar (una vez por instancia)

1. `BACKUP_KEY` generada con `openssl rand -hex 32` y guardada en el gestor de secretos, **no** en
   `BACKUP_DIR`. Si se pierde, sus copias no se pueden recuperar.
2. `BACKUP_DIR` en un volumen persistente distinto del contenedor, con instantáneas, réplica o
   sincronización fuera de la máquina.
3. Una instancia de pruebas (la tuya de staging, o `docker compose up -d db` + `pnpm dev` en tu
   equipo) con un usuario de PostgreSQL con `CREATEDB` para `db:verify` (`BACKUP_VERIFY_URL`),
   **sin** variables `WHATSAPP_*` ni `SMTP_*`: tras restaurar tendrá los destinos de avisos del
   negocio real y no debe poder escribirles.

### Pasos

1. **Copiar** (en la instancia real): `node dist/src/cli/backup.js`. Esperado: nombre
   `<instancia>__<esquema>__<fecha>__manual.cbak`, tamaño y recuentos por tabla. Apunta los
   recuentos de `business`, `service` y `faq`.
2. **Llevar el fichero** a la instancia de pruebas por el medio que uses para sacar copias de la
   máquina. La clave de la instancia real se pone en la de pruebas solo durante la prueba, en
   `BACKUP_KEYS_PREVIOUS`, nunca como `BACKUP_KEY`.
3. **Comprobar** (en la de pruebas): `pnpm db:verify <fichero>`. Esperado: `RESTAURABLE`, misma
   instancia, esquema y recuentos que en el paso 1, y "Base de datos temporal eliminada".
4. **Restaurar en la instancia de pruebas**, parada:
   `pnpm db:restore <fichero> --from-instance <instancia-real>`, escribir el `INSTANCE_ID` de la
   de pruebas para confirmar y arrancar con `pnpm dev`. Esperado: "Restaurada" con los mismos
   recuentos; al arrancar se aplican las migraciones pendientes (con su copia previa) y se borran
   las conversaciones de más de 30 días.
5. **Confirmar en el panel** de pruebas (`/admin`): nombre del negocio, servicios, precios,
   horarios y FAQ iguales a los de la instancia real; mismo estado (activo o en preparación). Los
   avisos que muestre el panel son los del estado restaurado: la restauración no los recalcula ni
   cambia el estado del negocio o de los canales.
6. **Limpiar**: quita `BACKUP_KEYS_PREVIOUS` de la instancia de pruebas y vuelve a sus datos
   ficticios (o `docker compose down -v`), porque ahora contiene datos reales de clientes finales.

### Si algo falla

| Mensaje | Qué hacer |
|---|---|
| `wrong_key` | La copia es de otra clave: añade la anterior en `BACKUP_KEYS_PREVIOUS` |
| `other_instance` | Es de otra instancia: repite con `--from-instance <id>` si es lo que quieres |
| `schema_newer` | La copia es de un núcleo más reciente: restaura con esa versión de la imagen o posterior |
| `corrupted` | El fichero está dañado o incompleto: usa otra copia y revisa cómo se transfirió |
| `instance_running` | Para la instancia antes de restaurar |
| `verify_url_invalid` | (016) `BACKUP_VERIFY_URL` no se puede interpretar: revisa su formato en el fichero de entorno |
| `verify_db_unavailable` | (016, estrechado) No se pudo **conectar** con el servidor de verificación: comprueba que está en marcha y accesible desde la instancia |
| `verify_db_create_failed` | (016) Se conectó pero no se pudo **crear** la base temporal: `BACKUP_VERIFY_URL` necesita un usuario con `CREATEDB` |
| `db_ca_unreadable` | No se puede leer el fichero de `sslrootcert` de la URL: móntalo (solo lectura) y revisa la ruta y sus permisos (salida 2 en `db:restore` y `db:verify`) |
| `db_tls_untrusted` | El certificado del servidor no vale para el nombre de la URL o no lo firma una autoridad de confianza: revisa el nombre y `sslrootcert` |
| `db_tls_unsupported` | La URL pide TLS y el servidor no lo acepta: activa TLS en PostgreSQL |

---

## 9. Propuestas de specs

Lo anterior funciona a mano con pocos clientes, pero con cada cliente nuevo aumenta el riesgo de
error humano (secretos repetidos, BD equivocada, actualizaciones sin copia). Estas specs lo cubren.
Todas son de **núcleo**: genéricas, sin nombres de cliente ni de sector.

### 9.1 Specs ya realizadas

Estado tomado del [README](../README.md) a 2026-10-13.

| Nº | Feature | Estado | Qué aporta a la operación multicliente |
|---|---|---|---|
| 001 | Base de conocimiento del negocio | Completada | Panel `/admin` por instancia, avisos calculados y bloqueo de activación con avisos críticos (FR-032) |
| 002 | Atención de dudas y precios por WhatsApp | Completada (evaluación de audios aplazada hasta que un cliente los active, T083) | Canal WhatsApp, `pnpm bot:chat` y `pnpm test:eval` para comprobar calidad antes de publicar |
| 003 | Claridad del panel del operador y enlace a mapa | Completada | Panel más claro para el operador |
| 004 | Canal web del bot de atención | Completada | Chat web incrustable, webs permitidas y topes diarios y mensuales de respuestas |
| 005 | Derivación de la conversación al negocio | Completada | Salida a una persona (Principio V): avisos al negocio por WhatsApp y/o email (`SMTP_*`) |
| 006 | Copias de seguridad y restauración por instancia | Completada | **Era la propuesta P3**: copias cifradas diarias, bajo demanda y previas a cada migración; restauración y verificación ([sección 5](#5-actualizar-el-núcleo) y [sección 8](#8-copias-de-seguridad-guía-de-validación)) |
| 007 | Aprovisionamiento de instancias | Completada | **Era la propuesta P1**: `pnpm instance:new`, `instance:db`, `instance:check` e inventario sin secretos ([sección 2](#2-alta-de-un-cliente-nuevo) y [sección 7](#7-baja-de-un-cliente)) |
| 008 | Exportar e importar la configuración del negocio | Completada (2026-10-01) | **Era la propuesta P2**: fichero JSON versionado, importación con vista previa y confirmación transaccional, deshacer con la configuración anterior ([sección 2.6](#26-configuración-del-negocio-en-el-panel-de-producción)) |
| 009 | Versión visible y actualización escalonada | Completada (2026-10-01) | **Era la propuesta P6**: `GET /health` con dos niveles (`HEALTH_SECRET`), versión en el pie del panel, `pnpm instance:versions` e `instance:health-secret`, y procedimiento de publicación por tandas con vuelta atrás ([sección 5](#5-actualizar-el-núcleo)) |
| 010 | Consumo y coste por instancia | Completada (2026-10-01) | **Era la propuesta P4**: consumo del modelo por canal sin textos, pantalla **Consumo** con precios por modelo y moneda de coste, tope mensual de gasto con salida a una persona, y su estado en `/health` y en `instance:versions` ([sección 4.1](#41-consumo-precios-y-tope-en-el-panel-010)) |
| 011 | Diseño del chat web | Completada (2026-10-05) | No venía de ninguna propuesta de esta sección. Cada cliente tiene su chat con su imagen sin despliegue ni cambiar el fragmento: sección **Diseño del chat** del panel, contraste mínimo garantizado, aviso de asistente automático y salida a una persona siempre presentes, formato 2 del fichero de configuración con el diseño y sus imágenes ([sección 2.6](#26-configuración-del-negocio-en-el-panel-de-producción)) |
| 012 | Protección frente a abuso y saturación | Completada (2026-10-06) | **Era la propuesta P8**: tope de gasto obligatorio en producción que falla cerrado, transcripción dentro del tope y tope diario de WhatsApp ([sección 4.1](#41-consumo-precios-y-tope-en-el-panel-010)); límites de derivación con reenvíos agrupados ([sección 4.2](#42-límites-de-derivación-012)); límites por dirección (/64) en las rutas públicas y pool de BD acotado; login con retardo en lugar de bloqueo; plazos en las llamadas salientes y reintentos de lotes; importación acotada; una sola regla de enlaces; registros sin datos y arranque que rechaza secretos débiles ([sección 5.0](#50-antes-de-la-primera-vez-una-vez-por-instancia)) |
| 013 | Requisitos de despliegue seguro | Completada (2026-10-06) | **Era la propuesta P9**: `instance:check` da NO APTO en producción con `TRUST_PROXY` vacío y `https` y con URL de base de datos remotas sin `sslmode=verify-full`; `instance:db` se niega a conectar sin TLS verificado (`--sslrootcert`); TLS verificado en todas las conexiones con mensajes sin datos; `db:verify` con bases temporales cerradas a otros usuarios y limpieza de huérfanas; imagen con `HEALTHCHECK`, base fijada por digest y pnpm con hash; receta de producción con comprobaciones ([sección 2.5](#25-despliegue), [2.3](#23-crear-la-base-de-datos-pnpm-instancedb), [2.4](#24-completar-y-validar-pnpm-instancecheck), [5](#5-actualizar-el-núcleo) y [8](#8-copias-de-seguridad-guía-de-validación)) |
| 014 | Modo oscuro del panel del operador | Completada (2026-10-13) | No venía de ninguna propuesta de esta sección: es una mejora de comodidad del panel, pensada además para comprobar que el núcleo se puede ampliar y actualizar con instancias ya desplegadas. El panel sigue la preferencia de color del sistema y ofrece un control de tres opciones —Automático, Claro, Oscuro— en la barra superior y en la pantalla de acceso; la elección vive en una cookie del navegador del operador, así que **no es configuración del negocio**: no viaja en el fichero de configuración, no entra en las copias y no cambia el esquema. El modo claro queda igual que antes y el chat web que ven los clientes finales no cambia nada ([sección 2.6](#26-configuración-del-negocio-en-el-panel-de-producción)). Desplegada como **0.1.2** el 2026-10-13 en las dos instancias, por tandas |
| 016 | Resistencia a los cortes de la base de datos y verificación de copias por socket | Completada (2026-10-09) | No venía de ninguna propuesta de esta sección: es una **corrección** de dos fallos del núcleo que destapó la fase 9 del despliegue. Una instancia ya arrancada sobrevive a un corte de su base de datos sin reiniciarse y sigue respondiendo al cliente final con el teléfono de emergencia por los dos canales; `/health` gana el estado `db_unavailable` con **200**, que no es motivo de reinicio ([sección 5](#5-actualizar-el-núcleo)); `db:verify` funciona con las direcciones **sin nombre de servidor** del despliegue real y sus motivos de fallo distinguen dirección, conexión y creación ([sección 8](#8-copias-de-seguridad-guía-de-validación)); el chat web nunca se queda indicando espera; y dos comprobaciones del operador que la forma de dirección de producción silenciaba —calidad de la contraseña de la base de datos y prohibición del usuario `postgres`— vuelven a aplicarse ([sección 2.4](#24-completar-y-validar-pnpm-instancecheck)) |

Todas están completadas. Quedan aplazadas la evaluación de audios de la 002 (T083), que se hace
antes de activar los audios en una instancia, el ensayo de la guía de publicación de la 009 con
una persona que no haya participado (SC-006). La receta de producción de la 013 (§2.5) no la ha
validado una persona ajena porque el proyecto lo lleva una sola persona (T044b, cerrada por
decisión del responsable): el primer despliegue en producción es su validación, siguiéndola paso
a paso y corrigiéndola donde no se cumpla una comprobación. Además, el canal WhatsApp no está activo en ningún
cliente y ha cambiado con la 012: antes de activarlo en el primer cliente se revisa entero en desarrollo
con una app de pruebas (ver `WHATSAPP_*` en la [sección 2.4](#24-completar-y-validar-pnpm-instancecheck)),
incluido el 404 que registra la URL completa cuando WhatsApp no está configurado (desviación del
quickstart de la 012).

### 9.2 Orden de ejecución

Una spec cada vez, en este orden (`/speckit-specify` → plan → tasks → implement). Los números
definitivos los asigna `/speckit-specify`; si no se cuela otra feature, serán 012, 013…

Al terminar una spec, actualiza esta sección y la 9.1 (estado, feature que cubre cada propuesta y
orden de las pendientes).

Ni la 014 ni la 016 cambian este orden, y **ninguna propuesta pasa a hecha por ellas**: la 016 es
una corrección de dos fallos del núcleo descubiertos en la fase 9 del despliegue y la 014 una mejora
de comodidad del panel. Las pendientes siguen siendo P7 y P5, en ese orden.

| Orden | Id | Propuesta | Prioridad | Depende de | Cuándo |
|---|---|---|---|---|---|
| 1 | P7 | Estado de las copias de seguridad, visible | Media | P3 (006), P6 (009) | Antes de tener varias instancias en producción sin revisar sus registros a diario |
| 2 | P5 | Puntos de extensión del núcleo | Baja | — | Solo cuando llegue la primera petición que no quepa en la configuración |
| — | P9 | Requisitos de despliegue seguro | — | — | **Hecha** (feature 013) |
| — | P8 | Protección frente a abuso y saturación | — | — | **Hecha** (feature 012) |
| — | P4 | Consumo y coste por instancia | — | — | **Hecha** (feature 010) |
| — | P6 | Versión visible y actualización escalonada | — | — | **Hecha** (feature 009) |
| — | P1 | Aprovisionamiento de instancias | — | — | **Hecha** (feature 007) |
| — | P2 | Exportar e importar la configuración del negocio | — | — | **Hecha** (feature 008) |
| — | P3 | Copias de seguridad y restauración por instancia | — | — | **Hecha** (feature 006) |

Por qué este orden:

1. **P1 primero** porque protege el aislamiento, que depende por completo del despliegue
   ([sección 3](#3-aislamiento-entre-clientes)). Desde la 006 el alta tiene todavía más piezas
   manuales (`INSTANCE_ID`, `BACKUP_DIR`, `BACKUP_KEY`) y un error ahí no se nota hasta que hace
   falta restaurar.
2. **P2** (hecha) ahorra trabajo en cada alta y permite revisar la configuración en la
   instancia de pruebas antes de llevarla a producción.
3. **P6** (hecha) en cuanto hubo dos instancias en producción: saber qué versión corre cada una
   es lo que hace seguras las actualizaciones por tandas. Usa el inventario de P1.
4. **P4** (hecha) cuando el consumo empezó a facturarse y creció el riesgo de gasto. El límite de
   gasto del workspace de Anthropic de cada cliente ([sección 4](#4-coste-de-la-api)) sigue como
   última red de seguridad, por encima del tope de la instancia.
5. **P8 y P9** antes que todo lo pendiente: salen de la auditoría completa del 2026-10-05
   ([sección 11.6](#116-registro-de-auditorías)) y sin ellas la instancia no es apta para
   producción. P8 (hecha, feature 012) primero porque sus fallos se explotan desde Internet sin
   credenciales; P9 (hecha, feature 013) después, porque es sobre todo comprobación y
   documentación.
6. **P7** antes que P5 porque es pequeña y cierra un hueco real: hoy una copia que falla solo
   deja rastro en los registros, y nadie lo ve hasta que hace falta restaurar.
7. **P5** no se adelanta: se diseña a partir de un caso real.

### P8. Protección frente a abuso y saturación

- **Estado**: **hecha** (feature 012, 2026-10-06). Las comprobaciones de operación están en las
  secciones [4.1](#41-consumo-precios-y-tope-en-el-panel-010), [4.2](#42-límites-de-derivación-012) y
  [5.0](#50-antes-de-la-primera-vez-una-vez-por-instancia).
- **Ámbito**: núcleo.
- **Origen**: auditoría completa del 2026-10-05 ([sección 11.6](#116-registro-de-auditorías)).
  Todos los puntos están comprobados en el código.
- **Problema**: no hay fallos que den acceso a datos o al panel, pero un anónimo puede hacer
  gastar dinero al negocio o dejar la instancia sin servicio, y el operador puede quedarse sin
  acceso al panel justo cuando lo necesita para cortar el abuso.
- **Alcance**:
  - **Tope de gasto obligatorio**: una instancia de producción no atiende clientes con el tope
    desactivado o sin precio para `LLM_MODEL`; el tope falla cerrado (si no se puede calcular el
    coste, se limita por número de llamadas). Tope diario de respuestas también en WhatsApp.
  - **Whisper dentro del tope**: comprobar el tope antes de transcribir y registrar su consumo.
  - **Derivaciones**: los reenvíos al negocio cuentan para los topes; límite por instancia de
    derivaciones nuevas y de avisos por derivación y periodo, con reenvíos agrupados; las URL y el
    texto del cliente en los avisos van claramente delimitados.
  - **Rutas públicas**: límite de peticiones en `/chat/frame`, `/chat/design.css` y
    `/chat/design/*`; la ruta de imágenes compara el hash antes de leer los bytes; IPv6 agrupado
    por /64 en los límites por IP; pool de BD con máximo y `statement_timeout`.
  - **Login**: el límite global de fallos no impide entrar con la credencial correcta (retardo
    creciente en lugar de bloqueo).
  - **Llamadas salientes**: plazo en todas las llamadas a Meta (envío, metadatos y descarga de
    audio).
  - **Lotes que fallan**: reintentos con contador y espera creciente, sin repetir avisos.
  - **Importación de configuración**: listas con máximo, errores limitados y deduplicación lineal.
  - **Verificador de enlaces**: el bot no puede mostrar un enlace que el verificador no haya
    visto (mismo patrón en `grounding.ts`, `links.js` y `message-links.ts`).
  - **Registros**: los errores se registran sin datos (`name`, `code`), y `hub.verify_token` no
    aparece en el registro de peticiones.
  - **Arranque en producción**: falla con secretos débiles o de ejemplo, o sin `BACKUP_KEY` o
    `HEALTH_SECRET`.
- **Fuera de alcance**: retos anti-bot en el chat web (se valora solo si los límites no bastan).
- **Texto para `/speckit-specify`**:
  > Proteger cada instancia frente al abuso y la saturación antes de publicarla: el tope de gasto
  > pasa a ser obligatorio en producción y falla cerrado, cubre también la transcripción de audios
  > y tiene tope diario en WhatsApp; los reenvíos de una derivación al negocio cuentan para los
  > topes y tienen su propio límite; las rutas públicas del chat web tienen límite de peticiones;
  > el bloqueo del login no impide entrar al operador con la credencial correcta; las llamadas
  > salientes tienen plazo; los lotes que fallan se reintentan con espera; la importación de
  > configuración limita su tamaño y su coste; el bot no muestra enlaces que no haya verificado;
  > los registros no guardan datos de errores ni tokens; y la instancia no arranca en producción
  > con secretos débiles o sin copias. Ámbito: núcleo.

### P9. Requisitos de despliegue seguro

- **Estado**: **hecha** (feature 013, 2026-10-06). La receta de producción está en la
  [sección 2.5](#25-despliegue). No la ha validado una persona ajena (proyecto de una sola
  persona): se valida en el primer despliegue.
- **Ámbito**: núcleo (operación y documentación).
- **Origen**: auditoría completa del 2026-10-05 (agente de infraestructura).
- **Problema**: la aplicación ya hace bien lo que le toca, pero su seguridad en producción depende
  de requisitos del despliegue que hoy no se comprueban o ni siquiera están documentados.
- **Alcance**:
  - `pnpm instance:check` pasa de aviso a error (no apto) en producción cuando: `TRUST_PROXY` está
    vacío con `PUBLIC_BASE_URL` en https; `DATABASE_URL`, `BACKUP_VERIFY_URL` o
    `INSTANCE_DB_ADMIN_URL` apuntan a un host no local sin `sslmode=verify-full`; falta
    `PUBLIC_BASE_URL`.
  - `HEALTHCHECK` en la imagen sobre `GET /health`, con periodo de gracia para las migraciones.
  - Imagen base fijada por digest y `packageManager` con hash; `.npmrc` con `save-exact` y
    `onlyBuiltDependencies`; `.gitignore` con `*.pem`, `*.key` y `*.p12`.
  - `db:verify`: borra las BD `verify_*` huérfanas y les revoca `CONNECT` a `PUBLIC`.
  - Sección 2.5 de este documento con una receta de producción: proxy que sustituye (no añade)
    `X-Forwarded-For`, puerto 3000 solo en `127.0.0.1` o red interna, TLS hacia PostgreSQL,
    `--env-file` con permisos 0600, contenedor `--read-only` con `--cap-drop=ALL` y
    `no-new-privileges`, volumen de copias con dueño UID 1000 y modo 0700, servidor de
    verificación separado del de producción, y CI con `pnpm audit --prod`, escaneo de la imagen y
    las herramientas de la [sección 11.2](#112-agentes-y-para-qué-sirve-cada-uno).
- **Texto para `/speckit-specify`**:
  > Hacer que el despliegue seguro se compruebe y no dependa de la memoria del operador:
  > instance:check marca como no apto en producción un proxy sin TRUST_PROXY, las conexiones a
  > PostgreSQL remotas sin TLS verificado y la falta de PUBLIC_BASE_URL; la imagen tiene
  > healthcheck y base fijada por digest; la verificación de copias limpia sus bases temporales;
  > y la guía de operación incluye la receta de producción (proxy, red, TLS, permisos, contenedor
  > endurecido e integración continua con escaneo de dependencias, secretos e imagen). Ámbito:
  > núcleo.

### P1. Aprovisionamiento de instancias

> **Hecha** en la feature 007 ([spec](../specs/007-instance-provisioning/spec.md)). Se conserva
> la propuesta original como referencia.

- **Ámbito**: núcleo (herramientas de operación).
- **Problema**: el alta se hace a mano y cada paso manual puede romper el aislamiento (secretos
  copiados, BD compartida, variables incompletas). Desde la 006 hay además un identificador de
  instancia, un volumen de copias y una clave de copias que deben ser únicos y estar guardados.
- **Alcance**:
  - Comando `pnpm instance:new` que pide los datos mínimos (identificador de instancia, URL
    pública, zona horaria, región telefónica, moneda, teléfono de emergencia) y genera un fichero
    de entorno completo a partir de `.env.example`, con secretos nuevos: `SESSION_SECRET`,
    `BACKUP_KEY`, `WHATSAPP_VERIFY_TOKEN` si usa WhatsApp, y el hash de la contraseña del operador.
  - Script SQL o comando que crea la BD y un usuario con permisos solo sobre ella.
  - Comando `pnpm instance:check` que valida un fichero de entorno antes de desplegar: variables
    obligatorias (incluidas `INSTANCE_ID`, `BACKUP_DIR` y `BACKUP_KEY`), `NODE_ENV=production`,
    `https` en `PUBLIC_BASE_URL`, WhatsApp "las cinco o ninguna", `SMTP_URL` y `SMTP_FROM` juntas,
    `BACKUP_KEY` distinta de `SESSION_SECRET`, y que ni el `INSTANCE_ID` ni ningún secreto
    coincide con los de otras instancias del inventario.
  - Inventario de instancias (fichero local fuera del repositorio) sin secretos en claro: cliente,
    subdominio, `INSTANCE_ID`, versión de la imagen, workspace de Anthropic, dónde está guardada
    la `BACKUP_KEY`, fecha de alta y fecha y resultado de la última verificación de copia.
- **Fuera de alcance**: elegir proveedor de hosting o crear la infraestructura.
- **Texto para `/speckit-specify`**:
  > Herramientas de operación para dar de alta una instancia nueva del núcleo de forma segura:
  > generar un entorno completo con secretos únicos (incluida la clave de las copias de
  > seguridad), crear una base de datos con un usuario propio, validar el entorno antes de
  > desplegar detectando identificadores y secretos repetidos entre instancias, y llevar un
  > inventario de instancias sin secretos en claro. Ámbito: núcleo.

### P2. Exportar e importar la configuración del negocio

> **Hecha** en la feature 008 ([spec](../specs/008-config-export-import/spec.md)). Se conserva
> la propuesta original como referencia.

- **Ámbito**: núcleo.
- **Problema**: la configuración solo se puede preparar en el panel de producción. No hay forma de
  prepararla en una instancia de pruebas, revisarla y llevarla a producción, ni de guardar una
  copia legible de la configuración. La restauración de la 006 (`db:restore --from-instance`) no
  sirve para esto: mueve la BD entera, conversaciones incluidas, y está pensada para recuperar la
  misma instancia o comprobar copias.
- **Alcance**:
  - Exportar desde el panel un fichero JSON versionado con la configuración del negocio (datos,
    horarios, servicios, precios, FAQ, configuración del chat web). **Sin** conversaciones ni
    datos de clientes finales.
  - Los destinos de avisos de derivación (005) se exportan solo si el operador lo marca, porque
    importarlos en una instancia de pruebas la haría escribir al negocio real.
  - Importarlo en otra instancia: validación con los esquemas Zod del dominio, vista previa de
    cambios, aplicación en una transacción que respeta FR-032 (si el negocio queda activo con un
    aviso crítico, se revierte).
  - La importación nunca activa el negocio ni los canales por sí sola.
- **Fuera de alcance**: sincronización automática entre instancias; plantillas por sector dentro
  de `src/` (seguirían en `tests/fixtures/` o fuera del repositorio).
- **Texto para `/speckit-specify`**:
  > El operador puede exportar la configuración del negocio de una instancia a un fichero y
  > importarla en otra, con validación, vista previa de cambios y aplicación transaccional que
  > respeta los avisos críticos. No incluye conversaciones ni datos de clientes finales, los
  > destinos de avisos solo se incluyen si el operador lo pide y la importación nunca activa el
  > negocio ni los canales. Ámbito: núcleo.

### P6. Versión visible y actualización escalonada

> **Hecha** en la feature 009 ([spec](../specs/009-version-health-rollout/spec.md)). Se conserva
> la propuesta original como referencia.

- **Ámbito**: núcleo (operación).
- **Problema**: con varias instancias no es fácil saber qué versión corre cada una ni comprobar
  que una actualización ha ido bien.
- **Ya cubierto por la 006**: la copia previa a cada migración (sin ella no migra ni arranca) y
  la norma de migraciones de solo añadir, con los ficheros publicados intocables
  ([sección 5](#5-actualizar-el-núcleo)).
- **Alcance pendiente**:
  - Versión del núcleo y versión del esquema de BD visibles en el panel y en un endpoint de salud
    (`/health`) sin datos sensibles (hoy no existe).
  - Comando que consulta el `/health` de las instancias del inventario de P1 y muestra qué versión
    corre cada una.
  - Guía de publicación que convierta la [sección 5](#5-actualizar-el-núcleo) en un procedimiento
    con comprobaciones: etiquetado semántico, instancia de pruebas, tandas, comprobación tras
    actualizar cada instancia y vuelta atrás con la copia `premigration`.
- **Texto para `/speckit-specify`**:
  > Exponer la versión del núcleo y del esquema de base de datos en el panel y en un endpoint de
  > salud sin datos sensibles, consultar desde el inventario qué versión corre cada instancia y
  > definir el procedimiento de publicación escalonada con instancia de pruebas, comprobación
  > tras cada actualización y vuelta atrás con la copia previa a la migración. Ámbito: núcleo.

### P4. Consumo y coste por instancia

> **Hecha** en la feature 010 ([spec](../specs/010-usage-cost-cap/spec.md)). Se conserva
> la propuesta original como referencia.

- **Ámbito**: núcleo.
- **Problema**: el panel muestra respuestas por día y mes del chat web, pero no los tokens
  consumidos ni el gasto estimado, y WhatsApp no tiene un tope de gasto equivalente.
- **Alcance**:
  - Registrar por respuesta los tokens de entrada y salida y el modelo usado, **sin** guardar
    textos, en todos los canales (WhatsApp, chat web y "Probar el bot", este último aparte).
  - Vista en el panel con el consumo del día y del mes por canal y el coste estimado con precios
    configurables.
  - Tope mensual de gasto por instancia, común a todos los canales, que al alcanzarse hace que el
    bot responda con el contacto del negocio (Principio V: siempre hay salida a una persona). Las
    conversaciones derivadas (005) siguen funcionando.
- **Texto para `/speckit-specify`**:
  > Medir y mostrar en el panel el consumo del modelo por instancia y canal (tokens y coste
  > estimado, sin guardar textos) y permitir un tope mensual de gasto que, al alcanzarse, hace que
  > el bot dé el contacto del negocio en todos los canales. Ámbito: núcleo.

### P7. Estado de las copias de seguridad, visible

- **Ámbito**: núcleo (operación).
- **Problema**: la instancia hace la copia diaria y la previa a cada migración (006), pero su
  resultado solo queda en los registros (`backup_created`, `backup_failed`, `backup_disabled`).
  Una copia que falla en silencio, o una instancia sin `BACKUP_DIR` o `BACKUP_KEY`, no se nota
  hasta que hace falta restaurar.
- **Decisión de partida**: el panel **muestra** el estado, pero no hace ni restaura copias.
  Las copias siguen siendo automáticas (servidor) y la restauración sigue en la terminal con la
  instancia parada (006): restaurar desde la propia aplicación no es posible en marcha, el panel
  puede no funcionar justo cuando hace falta, y descargar una copia por una sesión web expondría
  todos los datos de la instancia.
- **Alcance esperado**:
  - Línea de solo lectura en el panel: fecha y resultado de la última copia, y aviso si no hay
    copia correcta en las últimas 24 h o si las copias están desactivadas por falta de
    configuración. Sin rutas de fichero, claves ni datos de la copia.
  - El mismo estado en el nivel protegido de `GET /health` (009) y en `pnpm instance:versions`,
    para ver todas las instancias de un vistazo y poder vigilarlo desde fuera.
  - El estado se obtiene de lo que la instancia ya sabe (las copias de `BACKUP_DIR` y el
    resultado del último intento), sin guardar nada nuevo que no viaje en las copias.
  - Sin acciones nuevas en el panel: ni "hacer copia ahora", ni descargar, ni restaurar.
- **Texto para `/speckit-specify`**:
  > Mostrar al operador el estado de las copias de seguridad de la instancia, en solo lectura:
  > fecha y resultado de la última copia, y un aviso si no hay ninguna correcta en las últimas
  > 24 horas o si las copias están desactivadas. Debe verse en el panel, en el nivel protegido
  > de /health y en instance:versions. El panel no hace, descarga ni restaura copias; eso sigue
  > siendo automático o desde la terminal. Ámbito: núcleo.

### P5. Puntos de extensión del núcleo

- **Ámbito**: núcleo.
- **Problema**: el Principio III exige que las personalizaciones sean extensiones conectadas a
  puntos genéricos, pero esos puntos aún no existen.
- **Cuándo**: **no** adelantarla. Esperar a la primera petición real que no quepa en la
  configuración y diseñar solo el punto que esa petición necesita.
- **Alcance esperado**:
  - Mecanismo de carga de extensiones por instancia (activadas por configuración de entorno),
    sin que la imagen común cambie de comportamiento si no hay extensiones.
  - Contrato de cada punto de extensión con tipos y tests; las extensiones no pueden saltarse la
    verificación de datos (Principio IV) ni bloquear la derivación a una persona (Principio V).
  - Test que compruebe que retirar una extensión deja la instancia con el comportamiento del
    núcleo.
- **Texto para `/speckit-specify`** (adaptar al caso real):
  > Añadir al núcleo un punto de extensión genérico para <necesidad descrita sin nombrar al
  > cliente>, con un contrato tipado, carga opcional por instancia y garantía de que ninguna
  > extensión puede saltarse la verificación de datos ni la salida a una persona. Ámbito: núcleo.

---

## 10. Resumen de reglas

1. Una imagen para todos; un entorno y una BD por cliente.
2. Secretos, credenciales y clave de Anthropic nuevos para cada cliente, nunca copiados: el
   entorno sale de `pnpm instance:new` y pasa por `pnpm instance:check` antes de cada despliegue.
3. La información del negocio se registra en el panel de su instancia; el cliente no la edita.
4. Nada específico de un cliente o sector en `src/`.
5. Antes de actualizar: tests, evaluación e instancia de pruebas; la copia previa la hace la
   instancia y, sin ella, no migra. Migraciones de solo añadir; las publicadas no se editan.
   Imagen etiquetada con la versión de `package.json` (nunca `latest`), publicación por tandas y
   cada instancia comprobada con `pnpm instance:versions` antes de seguir; cada una con su propio
   `HEALTH_SECRET`.
6. Cada instancia con su `INSTANCE_ID`, su `BACKUP_KEY` (guardada fuera de las copias) y un
   volumen persistente para `BACKUP_DIR`; una copia se comprueba restaurándola, cada mes.
7. Lo que no cabe en la configuración se resuelve con una spec, primero de núcleo si es genérico y
   de extensión solo si es realmente particular.
8. Nada sale a producción sin la auditoría de seguridad de la [sección 11](#11-auditoría-de-seguridad):
   la de la feature al cerrarla, y la completa antes de la primera publicación y de cada versión
   mayor.

---

## 11. Auditoría de seguridad

Proceso para auditar la seguridad con agentes de Claude Code. Está escrito para reutilizarlo tal
cual en otros proyectos: solo cambian las rutas del alcance y el reparto por zonas.

### 11.1 Cuándo se hace

| Momento | Tipo | Alcance |
|---|---|---|
| Al cerrar cada feature, antes de fusionarla | De feature | Solo los commits de la feature |
| Antes de la primera publicación en producción | Completa | Todo el repositorio, más infraestructura y dependencias |
| Antes de una versión mayor, o cada 6 meses | Completa | Igual que la anterior |
| Tras tocar autenticación, cifrado, secretos o subida de ficheros | De feature con foco | Los commits del cambio, con los agentes de ese tema |

Una auditoría de feature **no** sirve para dar el visto bueno a la salida a producción: solo dice
que la feature no introduce fallos. Para publicar hace falta la completa.

### 11.2 Agentes y para qué sirve cada uno

Son agentes de solo lectura: no modifican nada y entregan un informe con hallazgos priorizados.

| Agente | Modelo | Qué revisa |
|---|---|---|
| `security-secrets` | Sonnet | Claves, tokens y contraseñas en el código y en el historial de git (con gitleaks), `.env`, logs que filtren secretos, qué arrastran las exportaciones |
| `security-code-vulns` | Sonnet | OWASP Top 10: validación de entrada, subida de ficheros, deserialización, prototype pollution, condiciones de carrera, consumo de recursos, valores por defecto inseguros |
| `security-auth-crypto` | Opus | Sesiones, cookies, CSRF, autorización e IDOR, hash de contraseñas, algoritmos y uso del cifrado, comparaciones en tiempo constante, límites de peticiones, cabeceras de seguridad, CORS |
| `security-injection` | Opus | Recorrido de los datos no fiables hasta sumideros peligrosos: SQL, XSS, inyección CSS, comandos, path traversal, SSRF, logs, plantillas, `postMessage` |
| `security-infrastructure` | Sonnet | Dockerfile, compose, CI/CD, puertos expuestos, usuario del contenedor, red y TLS |
| `security-supply-chain` | Sonnet | Dependencias y lockfile: CVE conocidas, scripts de instalación, versiones sin fijar, typosquatting |
| `/security-review` | (el de la sesión) | Revisión de los cambios pendientes de la rama con criterio estricto: solo fallos explotables con alta confianza, sin saturación ni límites de peticiones. Sirve de segunda opinión y de filtro de falsos positivos |

Por qué esos modelos: Opus en los dos temas que exigen seguir flujos de datos entre ficheros y
razonar sobre criptografía; Sonnet en los que son sobre todo búsqueda de patrones y lectura de
configuración.

**Herramientas gratuitas que ejecutan los agentes.** Los agentes no se quedan en leer código:
lanzan escáneres de código abierto y después comprueban a mano lo que señalan, porque la mayoría
de sus avisos son falsos positivos (en la auditoría completa, los 8 de gitleaks y los 3 de semgrep
lo fueron). Conviene tenerlas instaladas y llevarlas también a la CI, sin depender de los agentes:

| Herramienta | Qué audita | Uso | Lo ejecuta |
|---|---|---|---|
| [gitleaks](https://github.com/gitleaks/gitleaks) | Secretos en el código **y en todo el historial de git**, incluidos ficheros ya borrados | `gitleaks detect --source . -v` (historial) o `gitleaks dir .` (solo los ficheros) | `security-secrets` |
| [semgrep](https://semgrep.dev) | Patrones inseguros en el código fuente (criptografía mal usada, `postMessage('*')`, inyecciones) | `semgrep scan --config auto src/` | `security-code-vulns`, `security-injection` |
| [osv-scanner](https://github.com/google/osv-scanner) | Vulnerabilidades conocidas (CVE/GHSA) de las dependencias leyendo el lockfile (`pnpm-lock.yaml`), producción y desarrollo | `osv-scanner scan --lockfile pnpm-lock.yaml` | `security-supply-chain` |

Además, `pnpm audit --prod` (incluido en pnpm, sin instalar nada) da la lista de CVE solo de las
dependencias que llegan a producción; `pnpm audit` sin `--prod` incluye las de desarrollo. Si
`pnpm audit` y osv-scanner discrepan, manda la ruta real: una CVE en una dependencia de desarrollo
que `pnpm prune --prod` deja fuera de la imagen no bloquea la salida.

### 11.3 Proceso

1. **Fijar el alcance.**
   - De feature: el diff contra `main` puede arrastrar features anteriores sin fusionar. Se toma la
     base del primer commit de la feature:
     ```bash
     FIRST=$(git log --format=%h --grep='^011' --reverse | head -1)
     git diff --stat "$FIRST^"..HEAD -- src scripts
     ```
   - Completa: `src/`, scripts, Dockerfile, compose, CI y lockfile.
2. **Lanzar los agentes en paralelo y en segundo plano**, cada uno con un prompt que incluya:
   - el alcance exacto (rango de commits o carpetas);
   - los ficheros clave y el contexto de seguridad que ya existe (cómo se autentica, qué cifra,
     qué rutas son públicas), para que no lo redescubra;
   - los puntos concretos que preocupan en ese cambio;
   - "solo lectura", respuesta en español, hallazgos con severidad, `fichero:línea`, escenario de
     explotación concreto y remediación, y falsos positivos descartados de forma explícita.
3. **Leer cada informe al llegar** y no darlo por bueno: los hallazgos son la opinión de un modelo.
4. **Pasar `/security-review`** sobre el mismo alcance. Necesita `origin/HEAD`: si el repositorio no
   tiene remoto, falla y la revisión se hace a mano con el mismo criterio estricto.
5. **Comprobar en el código** cada hallazgo de severidad media o superior antes de aceptarlo (leer
   las líneas citadas, buscar si hay mitigaciones en otro sitio, mirar si la spec lo decidió así).
6. **Consolidar** en una sola tabla: hallazgos comprobados, severidad, qué agentes lo marcaron,
   lo confirmado como correcto y lo que queda fuera del alcance para revisarlo aparte.
7. **Corregir** con una spec de núcleo (`/speckit-specify`), nunca a mano fuera del flujo.

### 11.4 Criterio de severidad y de salida a producción

| Severidad | Significado | ¿Bloquea la salida? |
|---|---|---|
| Crítica | Explotable sin autenticación con impacto grave (datos, ejecución, toma de cuentas) | Sí |
| Alta | Explotable con condiciones razonables, o con sesión y gran impacto | Sí |
| Media | Saturación de rutas públicas, endurecimiento importante, fallo con mitigación parcial | Sí en rutas públicas; si no, se planifica |
| Baja / Info | Higiene, defensa en profundidad, impacto solo visual | No; se anota |

Una decisión tomada en la spec (por ejemplo, aceptar imágenes animadas) no es un hallazgo: si se
quiere cambiar, se reabre la spec.

### 11.5 Auditoría completa: reparto en profundidad

Con un solo agente por tema sobre todo el código, el agente tiende a quedarse en la superficie.
En la completa, los dos agentes Opus se dividen por zonas y cada uno recibe la lista de carpetas
de su zona. Tamaño de `src/` en esta fecha: 272 ficheros, unas 34.000 líneas.

| Agente | Modelo | Zona | Tokens (aprox.) | Tiempo |
|---|---|---|---|---|
| `security-infrastructure` | Sonnet | Dockerfile, compose, `scripts/`, copias y su volumen | 40–80k | 2–4 min |
| `security-supply-chain` | Sonnet | `package.json`, `pnpm-lock.yaml` (498 paquetes), `pnpm audit` | 40–80k | 2–4 min |
| `security-secrets` | Sonnet | Todo el repositorio e historial de git | 50–100k | 2–4 min |
| `security-code-vulns` | Sonnet | Todo `src/` | 150–300k | 5–10 min |
| `security-auth-crypto` A | Opus | Panel y operación: `admin`, `app.ts`, `config`, `cli`, `provisioning`, `backup`, `health` | 150–250k | 5–10 min |
| `security-auth-crypto` B | Opus | Canales y derivación: `channels`, `webchat`, `handoff`, `mail`, `usage` | 150–250k | 5–10 min |
| `security-injection` A | Opus | Entrada pública y bot: `channels`, `webchat`, `conversation`, `llm` (incluida la inyección de prompt), `knowledge`, `speech`, `handoff`, `mail` | 150–250k | 5–10 min |
| `security-injection` B | Opus | Panel y operación: `admin`, `config-transfer`, `db`, `cli`, `provisioning`, `backup` | 150–250k | 5–10 min |

**Total:** entre 0,9 y 1,6 millones de tokens. En paralelo, unos 10–15 minutos de reloj, más la
consolidación. Las cifras de tokens son orientativas; los agentes Opus pesan más que el resto. Con
una suscripción, descuenta del cupo de uso.

Referencias reales:

- Auditoría de feature de la 011 (unas 5.300 líneas en 40 ficheros): 4 agentes, unos 280k tokens
  en total, entre 1 y 2,5 minutos cada uno.
- Auditoría completa del 2026-10-05 con este reparto: 8 agentes, unos 960k tokens en total (de 23k
  en supply-chain a 278k en code-vulns), y unos 10 minutos de reloj hasta que terminó el último.
  Los agentes Opus por zonas tardaron de 5,5 a 10 minutos cada uno.

### 11.6 Registro de auditorías

| Fecha | Tipo | Alcance | Resultado |
|---|---|---|---|
| 2026-10-05 | De feature | 011, `59d8c30..HEAD` | Sin hallazgos críticos ni altos. 1 media: la ruta pública de imágenes del diseño lee y revalida la imagen antes de comprobar el hash, sin límite de peticiones. 4 bajas: límite de 8 MB en el guardado del diseño, caracteres Unicode de dirección en los textos, bloques PNG desconocidos y SOF duplicados en JPEG, error completo en el log. Fuera de alcance: AES-GCM sin longitud de etiqueta fijada (`src/handoff/tokens.ts`, copias), clave fija de test detectada por gitleaks, `.gitignore` sin `*.pem` ni `*.key` |
| 2026-10-06 | De feature | 013, cambios de `src/`, `Dockerfile` y configuración desde `cee65c7^` (revisión manual: `/security-review` necesita un remoto) | Sin hallazgos explotables. SQL dinámico de `db:verify` (`DROP`, `CREATE`, `REVOKE`) solo con nombres generados o filtrados por el patrón exacto y citados; ningún mensaje ni registro con URL, host, ruta o nombres del certificado; la sonda de salud solo habla con `127.0.0.1`. Comprobado que una URL que la clasificación da por no válida y `pg` sí acepta nunca acaba en una conexión remota sin TLS (socket local o nombre que no resuelve). Encontrado al implementar y corregido: con una IP en la URL, `verify-full` no comprobaba el nombre del certificado (`pg` no pasa la IP a TLS); ahora es `database_tls_ip_host`. Notas: una `DATABASE_URL` no interpretable no da error en `instance:check` (el esquema del arranque solo exige que no esté vacía); una base `verify_<16 hex>` del formato anterior se borra si no tiene conexiones, aunque sea de una verificación de un núcleo anterior que acaba de empezar (esa verificación fallaría; no se pierden datos) |
| 2026-10-05 | Completa | Todo el repositorio, infraestructura, dependencias e historial de git (8 agentes, sección 11.5) | **No apta todavía para producción.** Sin vulnerabilidades críticas ni de toma de control o fuga de datos: XSS, SQL, comandos, CSRF, sesiones, firma del webhook, cifrado y secretos, correctos. Bloqueantes de abuso y disponibilidad (comprobados en el código): tope de gasto desactivado por defecto y sin exigir; los reenvíos de una derivación no cuentan para ningún tope (avisos y plantillas de pago sin límite, con texto del atacante); rutas públicas del chat sin límite de peticiones; el límite global del login deja fuera al operador; llamadas a Meta sin plazo; Whisper fuera del tope de gasto. Además: importación con coste cuadrático, enlaces que el verificador no ve, errores completos y `hub.verify_token` en los logs, y requisitos de despliegue sin documentar (TLS hacia PostgreSQL, puerto 3000, `TRUST_PROXY`, healthcheck, BD de verificación). El aviso de semgrep sobre AES-GCM resultó no explotable. Dependencias de producción sin CVE conocidas. **Cerrados**: los bloqueantes de abuso y disponibilidad, con la 012; los requisitos de despliegue (TLS hacia PostgreSQL, puerto 3000, `TRUST_PROXY`, healthcheck, BD de verificación) y `.gitignore` sin `*.pem`/`*.key` (de la auditoría de la 011), con la 013 |

---

## 12. Contenedores Docker del entorno local

Qué contenedores aparecen en Docker Desktop mientras se trabaja en este proyecto y para qué sirve cada uno.

| Contenedor | Imagen | Función | ¿Lo define el repo? |
|---|---|---|---|
| `chatbotasesor-db-1` | `postgres:16` | BD de la instancia local (`docker compose up -d db`, puerto 127.0.0.1:55442) | Sí, `docker-compose.yml` |
| `chatbotasesor-mailpit` | `axllent/mailpit` | SMTP falso de desarrollo: captura los correos (SMTP 1025, web http://localhost:8025) | No, se crea a mano |
| Postgres temporal de los tests | `postgres:16` | Lo levanta Testcontainers en `pnpm test:integration`, con nombre aleatorio, y lo borra al terminar | Lo crea el test |
| `ryuk` | `testcontainers/ryuk` | Auxiliar de Testcontainers: limpia los contenedores temporales si el test se cuelga | Lo crea el test |
| BD temporal de `db:verify` | `postgres` | Restaura una copia en una BD aparte para comprobarla (`pnpm db:verify`) | Lo crea el script |

Los contenedores de otros proyectos (`supabase_*_nexushr`, `citasclinica-db-1`, `salon_db*`,
`supabase_db_esencialsada`) no pertenecen a este repo y se pueden parar sin afectarlo.

---

## 13. Comandos útiles de Docker

```bash
docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"   # qué hay y en qué estado
docker stats --no-stream                                            # CPU y memoria por contenedor
docker stop $(docker ps -q --filter "name=nexushr")                 # parar un proyecto entero por nombre
docker logs -f --tail 50 chatbotasesor-db-1                         # seguir el log de un contenedor
docker container prune                                              # borrar los contenedores parados
```
