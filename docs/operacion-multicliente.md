# Operación multicliente: cómo se reutiliza el chatbot con seguridad

Guía para el desarrollador y operador del producto. Explica qué es común y qué es de cada cliente,
cómo se da de alta un cliente nuevo, cómo se actualiza el núcleo sin romper a nadie y qué specs
faltan para que todo esto deje de hacerse a mano.

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
export INSTANCE_DB_ADMIN_URL=postgres://admin:…@servidor:5432/postgres   # o se pide sin eco
pnpm instance:db cliente-x [--env <fichero>] [--host <servidor> --port <puerto>]
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
   `BACKUP_DIR` compartidos, advertencia. No escribe nada. Código de salida 0 apto, 1 no apto: se
   puede usar como paso de despliegue.

Pasa también por `instance:check` cualquier cambio posterior del entorno.

Referencia de variables del entorno:

| Variable | Valor para el cliente |
|---|---|
| `DATABASE_URL` | La escribe `instance:db` (2.3) |
| `OPERATOR_USER` · `OPERATOR_PASSWORD_HASH` | Credencial propia de esta instancia |
| `SESSION_SECRET` | Recién generado |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | Número de saltos del proxy (`1` si hay uno); nunca `true` |
| `PUBLIC_BASE_URL` | `https://nombrecliente.tudominio.com` |
| `DEFAULT_TIMEZONE` · `DEFAULT_PHONE_REGION` · `DEFAULT_CURRENCY` | Los del negocio |
| `EMERGENCY_CONTACT_PHONE` | Teléfono E.164 del negocio |
| `ANTHROPIC_API_KEY` | La clave de su workspace |
| `LLM_MODEL` · `LLM_EFFORT` | Los valores por defecto salvo motivo documentado |
| `WHATSAPP_*` | Las cinco, o ninguna |
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

1. Arranca un contenedor con la **misma imagen etiquetada** que el resto (`chatbot:X.Y.Z`) y el
   entorno del cliente. Al arrancar aplica las migraciones y crea el negocio vacío en
   "En preparación".
2. Comprueba que `https://nombrecliente.tudominio.com/admin` pide login y que la cookie es `Secure`.
3. Comprueba la versión: `pnpm instance:versions --only <id>` da `Correcto` con la versión
   desplegada, y anótala con `--annotate` ([sección 5](#5-actualizar-el-núcleo)).

### 2.6 Configuración del negocio (en el panel de producción)

1. Rellena datos del negocio, horarios, servicios, precios y preguntas frecuentes. Si ya los
   preparaste en una instancia de pruebas, llévalos con el fichero (ver abajo) en vez de teclearlos.
2. Resuelve los avisos críticos: el sistema no deja activar un negocio que los tenga (FR-032).
3. Prueba en "Probar el bot" las preguntas típicas del sector y alguna trampa (precio no
   registrado, "quiero hablar con una persona").
4. Pasa el negocio a activo.
5. Chat web: webs permitidas, enlace de privacidad, topes diarios y mensuales acordes a lo
   contratado, y activar. Entrega al cliente el fragmento `<script>`.
6. WhatsApp: registra en Meta el webhook `https://…/webhooks/whatsapp` con el `WHATSAPP_VERIFY_TOKEN`
   y envía un mensaje de prueba.

#### Llevar la configuración de pruebas a producción (008)

1. En el panel de la instancia de pruebas, **Exportar e importar** → **Exportar**. Se descarga
   `configuracion-<INSTANCE_ID>-<AAAAMMDD-HHMM>.json`. Marca "Incluir destinos de avisos" solo si
   quieres llevarlos: importarlos en pruebas haría escribir al negocio real, y en producción solo
   conviene si son los definitivos. Por defecto no se incluyen.
2. En el panel de producción, **Importar** → elige el fichero. Si no es válido (ilegible, de otra
   herramienta, de una versión futura, con reglas incumplidas o de más de 5 MB) se rechaza con la
   lista completa de errores y no cambia nada.
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
- Hoy el panel no muestra el coste en tokens por instancia; lo propone la spec
  [P4](#p4-consumo-y-coste-por-instancia).

---

## 5. Actualizar el núcleo

Una versión nueva de la imagen llega a **todos** los clientes y las migraciones se aplican solas al
arrancar. Desde la feature 009 cada instancia declara qué versión corre y en qué estado está, y la
publicación es un procedimiento por etapas: cada paso tiene una comprobación (orden o pantalla), el
resultado esperado y cuándo **parar**. Contrato completo:
[specs/009-version-health-rollout/contracts/release-procedure.md](../specs/009-version-health-rollout/contracts/release-procedure.md).

Herramientas que usa:

- **`GET /health`** en cada instancia. Sin credencial responde solo el estado (`200 {"status":"ok"}`,
  o `503` con `degraded` / `not_ready`): sirve a un monitor o balanceador. Con
  `Authorization: Bearer <HEALTH_SECRET>` añade `instanceId`, `coreVersion` y el esquema aplicado y
  esperado. Nunca muestra datos del negocio, conversaciones, secretos ni la causa de un fallo.
  Límite: 30 peticiones por minuto y por IP; un monitor debe sondear **cada 10 s o más** (con
  intervalos de 2 s o menos recibe `429` y da la instancia por caída).
- **Pie del panel**: tras iniciar sesión, todas las pantallas muestran «Núcleo X.Y.Z · Esquema
  000N_…», con el distintivo «Esquema distinto del esperado» si no coincide.
- **`pnpm instance:versions`**: consulta `/health` de todas las instancias del inventario que no
  están de baja (en paralelo, 5 s por instancia) con el `HEALTH_SECRET` de su entorno
  (`<dir. del inventario>/envs/<id>.env` o `--envs-dir`), solo en memoria. Muestra estado, núcleo,
  esquema, versión anotada y si coincide; `--only <id>[,<id>]`, `--json`, `--timeout <s>`;
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

### 5.0 Antes de la primera vez (una vez por instancia)

| Comprobación | Esperado | Si no |
|---|---|---|
| `pnpm instance:health-secret <id>` (instancias anteriores a la 009) y despliegue del entorno | La instancia responde `/health` completo | No publicar a esa instancia hasta tenerlo: no se podrá comprobar su versión |
| `pnpm instance:sync <id> <entorno>` y `pnpm instance:check <entorno>` | `APTO`, con `HEALTH_SECRET` presente y no repetido | Corregir lo que indique |
| `pnpm instance:versions` | Todas las instancias en `Correcto` y «Coincide: sí» (si falta la anotación, `--annotate`) | Resolver antes de empezar: una instancia ya degradada no es un buen punto de partida |
| Si un monitor o balanceador consulta `/health`, revisar su intervalo | Cada 10 s o más (límite: 30 por minuto y por IP) | Ampliar el intervalo: con menos recibe `429` y da la instancia por caída |

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
| `pnpm db:verify <fichero>` / `node dist/src/cli/verify.js` | Restaura en una BD temporal, compara y la borra |
| `pnpm db:backups [--prune]` / `node dist/src/cli/backups.js` | Lista las copias de la instancia y aplica la retención |

Además, la instancia hace una copia diaria (`BACKUP_DAILY_TIME`, hora local del negocio) y una
previa a cada migración, y borra las de más de `BACKUP_RETENTION_DAYS` días conservando siempre la
última válida. Todos los comandos aceptan `--json` para anotar el resultado en el inventario.

Una copia que no se ha restaurado nunca no está comprobada. Esta guía se hace en menos de 15
minutos.

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
| `verify_db_unavailable` | `BACKUP_VERIFY_URL` necesita un servidor accesible y un usuario con `CREATEDB` |

---

## 9. Propuestas de specs

Lo anterior funciona a mano con pocos clientes, pero con cada cliente nuevo aumenta el riesgo de
error humano (secretos repetidos, BD equivocada, actualizaciones sin copia). Estas specs lo cubren.
Todas son de **núcleo**: genéricas, sin nombres de cliente ni de sector.

### 9.1 Specs ya realizadas

Estado tomado del [README](../README.md) a 2026-10-01.

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

Todas están completadas. Quedan aplazadas la evaluación de audios de la 002 (T083), que se hace
antes de activar los audios en una instancia, y el ensayo de la guía de publicación de la 009 con
una persona que no haya participado (SC-006).

### 9.2 Orden de ejecución

Una spec cada vez, en este orden (`/speckit-specify` → plan → tasks → implement). Los números
definitivos los asigna `/speckit-specify`; si no se cuela otra feature, serán 008, 009…

Al terminar una spec, actualiza esta sección y la 9.1 (estado, feature que cubre cada propuesta y
orden de las pendientes).

| Orden | Id | Propuesta | Prioridad | Depende de | Cuándo |
|---|---|---|---|---|---|
| 1 | P4 | Consumo y coste por instancia | Media | — | Antes de facturar el consumo o de activar WhatsApp en un cliente con tráfico abierto |
| 2 | P5 | Puntos de extensión del núcleo | Baja | — | Solo cuando llegue la primera petición que no quepa en la configuración |
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
4. **P4** ahora, cuando el consumo se facture o el riesgo de gasto crezca. Mientras tanto, el límite de
   gasto del workspace de Anthropic de cada cliente ([sección 4](#4-coste-de-la-api)) es la red de
   seguridad.
5. **P5** no se adelanta: se diseña a partir de un caso real.

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
