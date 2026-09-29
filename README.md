# Estado del producto

Estados: especificada → planificada → en implementación → completada (o abandonada / sustituida).

| Nº  | Feature                         | Ámbito | Estado      | Rama                         | Spec                                            | Actualizado |
|-----|---------------------------------|--------|-------------|------------------------------|-------------------------------------------------|-------------|
| 001 | Base de conocimiento del negocio | Núcleo | En implementación | `001-business-knowledge-base` | [spec](specs/001-business-knowledge-base/spec.md) | 2026-09-24  |
| 002 | Atención de dudas y precios por WhatsApp | Núcleo | En implementación | `002-whatsapp-faq-bot` | [spec](specs/002-whatsapp-faq-bot/spec.md) · [plan](specs/002-whatsapp-faq-bot/plan.md) · [tareas](specs/002-whatsapp-faq-bot/tasks.md) | 2026-09-25  |
| 003 | Claridad del panel del operador y enlace a mapa | Núcleo | En implementación | `004-web-channel` | [spec](specs/003-admin-panel-clarity/spec.md) · [plan](specs/003-admin-panel-clarity/plan.md) · [tareas](specs/003-admin-panel-clarity/tasks.md) | 2026-09-28  |
| 004 | Canal web del bot de atención | Núcleo | Completada | `004-web-channel` | [spec](specs/004-web-channel/spec.md) · [plan](specs/004-web-channel/plan.md) · [tareas](specs/004-web-channel/tasks.md) | 2026-09-28  |
| 005 | Derivación de la conversación al negocio | Núcleo | En implementación | `005-handoff-to-business` | [spec](specs/005-handoff-to-business/spec.md) · [plan](specs/005-handoff-to-business/plan.md) · [tareas](specs/005-handoff-to-business/tasks.md) | 2026-09-29  |
| 006 | Copias de seguridad y restauración por instancia | Núcleo | Completada | `006-instance-backup-restore` | [spec](specs/006-instance-backup-restore/spec.md) · [plan](specs/006-instance-backup-restore/plan.md) · [tareas](specs/006-instance-backup-restore/tasks.md) | 2026-09-29  |

---

# Núcleo del chatbot: base de conocimiento, panel del operador y bot de atención

Cada cliente tiene su propia instancia (contenedor + base de datos PostgreSQL) construida a
partir de este núcleo y de su configuración. El operador registra la información del negocio
en un panel web (feature 001) y el bot atiende las dudas de horario, ubicación, servicios,
precios y preguntas frecuentes (feature 002) por tres canales con la **misma** cadena de
respuesta (feature 004):

- **WhatsApp**, con la Cloud API de Meta (opcional).
- **Chat web** incrustable en la web del negocio, para visitantes anónimos.
- **"Probar el bot"** en el panel, para que el operador vea lo que vería un cliente.

El bot lee `KnowledgeReader.getSnapshot()` de la base de datos en cada respuesta, sin caché; el
modelo (Claude) solo redacta, y el código calcula horarios, verifica las cifras y añade el
contacto del negocio cuando hace falta. Lo único que cambia entre canales es una tabla de
políticas (entrega, ventana de respuesta, negocio activo, chat activado y topes de uso).

Cuando el bot no puede resolver algo, el cliente pide hablar con una persona o escribe una queja,
la conversación se **deriva** al negocio (feature 005): el bot calla, el negocio recibe un aviso
por WhatsApp y/o email y la conversación vuelve sola al bot cuando el negocio confirma, termina o
pasan 24 h sin actividad.

Cada instancia hace **copias de seguridad cifradas** de su base de datos (feature 006): una al día
a la hora local configurada, una antes de aplicar migraciones (sin ella no migra ni arranca) y las
que pida el operador. Se restauran y se comprueban con los mismos comandos en todas las
instancias.

## Requisitos

- Node.js 22 o superior y pnpm 9 (`corepack enable`)
- Docker (PostgreSQL local y tests de integración con Testcontainers)

## Puesta en marcha en local

```bash
pnpm install
docker compose up -d db                     # PostgreSQL 16; si el 5432 está ocupado: DB_PORT=55442 docker compose up -d db
cp .env.example .env                        # ajusta DATABASE_URL y pon SESSION_SECRET (openssl rand -hex 32)
pnpm operator:hash-password                 # pega el resultado en OPERATOR_PASSWORD_HASH
pnpm db:migrate                             # tablas + negocio vacío en "En preparación"
pnpm dev                                    # panel en http://localhost:3000/admin
pnpm kb:snapshot                            # lo que recibiría el bot ahora mismo, en JSON
```

Con `ANTHROPIC_API_KEY` y `EMERGENCY_CONTACT_PHONE` en `.env` ya hay bot, sin necesidad de
WhatsApp. Se puede probar de dos maneras:

- **Desde el panel**: `http://localhost:3000/admin/playground` ("Probar el bot" en la
  navegación). Cada respuesta muestra debajo su información técnica: si lleva saludo, si es una
  plantilla, por qué se añadió el contacto, cuántos borradores rechazó el verificador y cuánto
  tardó. Funciona también con el negocio "En preparación".
- **Desde la terminal**:

  ```bash
  pnpm bot:chat                               # conversación en la terminal; --as <número>, --verbose
  pnpm bot:chat --flood 35                    # envía 35 mensajes seguidos (límite por número)
  ```

Las guías de validación, con los escenarios manuales, están en
[specs/001-business-knowledge-base/quickstart.md](specs/001-business-knowledge-base/quickstart.md),
[specs/002-whatsapp-faq-bot/quickstart.md](specs/002-whatsapp-faq-bot/quickstart.md),
[specs/003-admin-panel-clarity/quickstart.md](specs/003-admin-panel-clarity/quickstart.md),
[specs/004-web-channel/quickstart.md](specs/004-web-channel/quickstart.md),
[specs/005-handoff-to-business/quickstart.md](specs/005-handoff-to-business/quickstart.md) y
[specs/006-instance-backup-restore/quickstart.md](specs/006-instance-backup-restore/quickstart.md).

## Chat web en la web del negocio

El chat público está **desactivado** en cada instancia hasta que el operador lo activa. En
`http://localhost:3000/admin/web-chat`:

1. Indica las **webs donde se mostrará** (una por línea, máximo 10): solo el esquema y el
   dominio, sin ruta, y con `https` salvo `localhost` y `127.0.0.1` para pruebas.
2. Indica el **enlace a la política de privacidad** del negocio; el chat lo muestra antes del
   primer mensaje, junto al aviso de que atiende un asistente automático y de que los mensajes
   se borran a los 30 días.
3. Ajusta los **topes** de respuestas al día y al mes (200 y 3 000 por defecto). Al alcanzar uno
   el chat deja de responder y da el contacto del negocio hasta el día o el mes siguiente; el
   panel lo avisa y muestra el uso del día y del mes.
4. Marca **"Activar el chat en estas webs"** y guarda. Sin webs permitidas o sin enlace de
   privacidad no se puede activar.
5. Copia el **fragmento** y pégalo una vez en la web del negocio, antes de `</body>`:

   ```html
   <script src="https://tu-instancia.example/chat/widget.js" defer></script>
   ```

   La URL sale de `PUBLIC_BASE_URL` si está definida y, si no, del origen con el que estés
   usando el panel. El fragmento no hay que cambiarlo al activar o desactivar el chat.

El fragmento solo añade un iframe servido por la instancia; el navegador impide incrustarlo en
webs que no estén en la lista (`frame-ancestors`). Desactivar el chat tiene efecto en la
siguiente petición: los visitantes pasan a ver "no disponible" con el contacto del negocio.

## Derivación al negocio

En `http://localhost:3000/admin/handoffs` se configuran los destinos de los avisos: un WhatsApp,
un email o ambos. Sin ninguno configurado el bot sigue dando el contacto de derivación de la
002 (el panel lo avisa, sin bloquear la activación del negocio); con uno solo, el panel avisa de
que solo llegan por esa vía.

- La vía **WhatsApp** necesita el canal de WhatsApp ya configurado y las tres plantillas de
  utilidad aprobadas por Meta (aviso, recordatorio y reenvío de mensajes): `pnpm handoff:templates`
  imprime su definición para darlas de alta. **Meta cobra por plantilla de utilidad enviada**;
  cada derivación, reenvío y recordatorio consume una.
- La vía **email** necesita `SMTP_URL`, `SMTP_FROM` y `PUBLIC_BASE_URL` (los enlaces "Le atiendo"
  y "Terminado" del correo apuntan a esta instancia). Para probarla en local sirve un SMTP de
  pruebas como [Mailpit](https://github.com/axllent/mailpit)
  (`docker run -p 1025:1025 -p 8025:8025 axllent/mailpit`, panel en `http://localhost:8025`).

Mientras una conversación está derivada el bot no contesta: los mensajes del cliente se agrupan y
se reenvían al negocio, y el chat web muestra una franja fija en su lugar. El negocio confirma
("Le atiendo") o termina ("Terminado") con los botones de WhatsApp o los enlaces del email; el
operador también puede terminarla desde el panel o desde "Probar el bot". Sin confirmar, a las
24 h sin mensajes del cliente la conversación vuelve sola al bot; si el negocio no confirma en
2 horas de horario, recibe un recordatorio único y el cliente, el contacto directo. La guía de
validación manual está en
[specs/005-handoff-to-business/quickstart.md](specs/005-handoff-to-business/quickstart.md).

## Copias de seguridad

Con `INSTANCE_ID`, `BACKUP_DIR` y `BACKUP_KEY` en `.env` (van las tres o ninguna; en `production`
son obligatorias):

```bash
pnpm db:backup                              # copia cifrada en BACKUP_DIR; aplica la retención
pnpm db:backups                             # lista las copias de la instancia (--prune: retención)
pnpm db:verify <fichero>                    # la restaura en una BD temporal, compara y la borra
pnpm db:restore <fichero>                   # con la instancia PARADA; pide escribir el INSTANCE_ID
```

- Cada copia es un único fichero `<instancia>__<esquema>__<fecha UTC>__<motivo>.cbak` (motivo
  `manual`, `daily` o `premigration`), cifrado con AES-256-GCM y una clave derivada de
  `BACKUP_KEY`. **Sin la clave no se puede restaurar**: guárdala fuera de `BACKUP_DIR`.
- La copia sale de un único instante y no pausa al bot. La restauración es todo o nada: rechaza
  sin tocar nada las copias dañadas, de otra clave (`BACKUP_KEYS_PREVIOUS` para las anteriores),
  de otra instancia (salvo `--from-instance <id>`) o de un núcleo más reciente.
- Al arrancar con migraciones pendientes y datos, la instancia hace una copia `premigration`; si
  no puede, no migra ni escucha (`migration_blocked`). Por eso las migraciones son de solo añadir
  y las ya publicadas no se editan.
- Las copias caducan a los `BACKUP_RETENTION_DAYS` días (7 por defecto, máximo 30); la última
  válida se conserva siempre. Los ficheros ajenos del directorio no se tocan.
- `db:verify` necesita un usuario con `CREATEDB` en el servidor de `BACKUP_VERIFY_URL`.

Guía del operador para comprobar las copias: [docs/operacion-multicliente.md §8](docs/operacion-multicliente.md#8-copias-de-seguridad-guía-de-validación).

## Variables de entorno

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `DATABASE_URL` | Sí | Base de datos propia de la instancia (una por cliente) |
| `OPERATOR_USER` | Sí | Usuario del operador |
| `OPERATOR_PASSWORD_HASH` | Sí | Hash Argon2id de la contraseña (`pnpm operator:hash-password`, mínimo 12 caracteres) |
| `SESSION_SECRET` | Sí | Clave de la cookie de sesión: 32 bytes aleatorios en hex (`openssl rand -hex 32`). Cambiarla cierra todas las sesiones |
| `DEFAULT_PHONE_REGION` | No (`ES`) | País para interpretar teléfonos escritos en formato nacional |
| `DEFAULT_TIMEZONE` | No (`Europe/Madrid`) | Zona horaria IANA inicial del negocio |
| `DEFAULT_CURRENCY` | No (`EUR`) | Moneda ISO 4217 inicial del negocio |
| `PORT` | No (`3000`) | Puerto HTTP |
| `NODE_ENV` | Sí | `development`, `test` o `production`. En `production` la cookie es `Secure`, se envía HSTS y las plantillas se cachean |
| `TRUST_PROXY` | No (ninguno) | Proxies delante del servicio: número de saltos (`1`) o IP/CIDR separadas por comas. Nunca `true` |
| `WHATSAPP_PHONE_NUMBER_ID` · `WHATSAPP_ACCESS_TOKEN` · `WHATSAPP_APP_SECRET` · `WHATSAPP_VERIFY_TOKEN` · `WHATSAPP_GRAPH_VERSION` | Las cinco o ninguna | Canal de WhatsApp Cloud API. Sin ellas la instancia arranca solo con el panel |
| `EMERGENCY_CONTACT_PHONE` | Con `ANTHROPIC_API_KEY` | Teléfono E.164 que se da si no se puede leer la información del negocio (disculpa del bot y chat web "no disponible") |
| `ANTHROPIC_API_KEY` | Para tener bot | Clave de la API de Anthropic. Con ella ya hay bot: "Probar el bot" y chat web, aunque no haya WhatsApp. También la usan `pnpm bot:chat` y `pnpm test:eval` |
| `PUBLIC_BASE_URL` | No | URL pública de la instancia (`https`, sin ruta; `http` solo con `localhost` o `127.0.0.1`). Se usa para escribir el fragmento del chat web y para comprobar el origen de las peticiones del chat |
| `LLM_MODEL` | No (`claude-sonnet-5`) | Modelo que redacta las respuestas |
| `LLM_EFFORT` | No (`medium`) | Esfuerzo del modelo: `low`, `medium` o `high` |
| `AUDIO_TRANSCRIPTION` | No (`off`) | Interruptor de audios. Con `off` un audio recibe el aviso de "solo texto" y no se descarga |
| `STT_API_KEY` | Con audios `on` | Clave del servicio de transcripción (API de OpenAI) |
| `STT_MODEL` | No (`whisper-1`) | Modelo de transcripción |
| `SMTP_URL` | Con `SMTP_FROM` | Servidor SMTP para los avisos de derivación: `smtps://usuario:clave@host:465` o `smtp://usuario:clave@host:587` (STARTTLS). Necesita además `PUBLIC_BASE_URL` |
| `SMTP_FROM` | Con `SMTP_URL` | Remitente de los avisos de derivación |
| `WHATSAPP_TEMPLATE_LANG` | No (`es`) | Idioma de las plantillas de WhatsApp de los avisos de derivación (`pnpm handoff:templates` imprime su definición) |
| `INSTANCE_ID` | En `production` | Identificador de la instancia (minúsculas, cifras y guiones; 1–40), distinto por cliente. Va dentro de cada copia |
| `BACKUP_DIR` | En `production` | Directorio absoluto de las copias: un volumen persistente escribible por la instancia |
| `BACKUP_KEY` | En `production` | Clave de las copias: 32 bytes aleatorios en hex (`openssl rand -hex 32`), distinta de `SESSION_SECRET`. Guárdala fuera de `BACKUP_DIR` |
| `BACKUP_KEYS_PREVIOUS` | No | Claves anteriores separadas por comas, solo para leer copias hechas antes de cambiar `BACKUP_KEY` |
| `BACKUP_RETENTION_DAYS` | No (`7`) | Días que se conservan las copias, de 1 a 30 |
| `BACKUP_DAILY_TIME` | No (`03:00`) | Hora local del negocio (`HH:MM`) de la copia diaria |
| `BACKUP_VERIFY_URL` | No (`DATABASE_URL`) | Servidor PostgreSQL donde `pnpm db:verify` crea la BD temporal (usuario con `CREATEDB`) |

## Comandos

| Comando | Qué hace |
|---------|----------|
| `pnpm dev` | Servidor con recarga; aplica migraciones al arrancar |
| `pnpm build` / `pnpm start` | Compila a `dist/` y arranca la versión compilada |
| `pnpm test` | Unitarios, contrato e integración (levanta PostgreSQL con Testcontainers) |
| `pnpm test:unit` · `test:contract` · `test:integration` | Cada suite por separado |
| `pnpm test <patrón>` | Solo los ficheros que coinciden, p. ej. `pnpm test sector-neutrality` |
| `pnpm test:eval` | Evaluación con el modelo real y los tres sectores de ejemplo (SC-001 a SC-010); tiene coste y no entra en `pnpm test`. Se omite sin `ANTHROPIC_API_KEY` |
| `EVAL_CHANNEL=web pnpm test:eval` | La misma evaluación por el canal web, para comprobar que da los mismos resultados que por WhatsApp. SC-009 se omite: la web solo admite texto |
| `npx vitest run --project eval --reporter=verbose` | La evaluación mostrando las tablas de porcentajes de **todos** los criterios. Con `pnpm test:eval` a secas, el reporter por defecto de vitest descarta la salida de los ficheros que pasan y solo se ven los criterios que fallan |
| `pnpm test:eval audio` | Además, los audios con Whisper real (necesita `STT_API_KEY` y las grabaciones de `tests/fixtures/audio/`) |
| `pnpm bot:chat` | Conversación con el bot en la terminal, con el modelo real y sin WhatsApp |
| `pnpm lint` · `pnpm typecheck` · `pnpm format` | Calidad de código |
| `pnpm db:generate` | Genera una migración tras cambiar `src/db/schema.ts` |
| `pnpm db:migrate` | Aplica las migraciones a `DATABASE_URL`; con datos y migraciones pendientes hace antes una copia `premigration` (sin ella no migra) |
| `pnpm db:backup` | Copia cifrada de la instancia en `BACKUP_DIR` (`--json` para el inventario) |
| `pnpm db:restore <fichero>` | Restaura una copia con la instancia parada (`--from-instance <id>`, `--yes`, `--json`) |
| `pnpm db:verify <fichero>` | Restaura la copia en una BD temporal, compara los recuentos y la borra |
| `pnpm db:backups` | Lista las copias de la instancia; `--prune` aplica la retención |
| `pnpm kb:snapshot` | Imprime el `KnowledgeSnapshot` actual |
| `pnpm operator:hash-password` | Pide una contraseña sin mostrarla y devuelve su hash Argon2id |
| `pnpm handoff:templates` | Imprime la definición JSON de las tres plantillas de WhatsApp de los avisos de derivación, para darlas de alta en Meta |

## Despliegue

`Dockerfile` construye una imagen única del núcleo, igual para todos los clientes. Cada
instancia es un contenedor con sus variables de entorno, su base de datos y un **volumen
persistente para las copias** (la imagen declara `/var/lib/chatbot/backups`, escribible por el
usuario `node`); al arrancar aplica las migraciones pendientes, con copia previa si hay datos.

> **Instancias existentes (desde la 006)**: en `production` una instancia **no arranca** sin
> `INSTANCE_ID`, `BACKUP_DIR` y `BACKUP_KEY` y un volumen montado en `BACKUP_DIR`. Añádelos antes
> de actualizarla a esta versión.
 Dar de alta un negocio, cambiar sus datos o activar el chat web se
hace en el panel, sin desplegar. El webhook de WhatsApp escucha en `/webhooks/whatsapp`
(verificación con `WHATSAPP_VERIFY_TOKEN` y firma con `WHATSAPP_APP_SECRET`) y el chat web en
`/chat` (fragmento, iframe y su API JSON). Las conversaciones se borran a los 30 días y los
registros técnicos no guardan textos, números, tokens ni la IP de los visitantes.

Alta, aislamiento, actualización y baja de clientes, y specs de operación pendientes: [docs/operacion-multicliente.md](docs/operacion-multicliente.md).

## Estructura

```text
src/
├── config/        variables de la instancia (Zod)
├── db/            esquema Drizzle, migraciones, cliente y transacciones
├── knowledge/     dominio sin HTTP: esquemas, reglas temporales, avisos, snapshot, casos de uso
├── conversation/  dominio del bot sin HTTP: recepción, espera, respuesta, verificador, plantillas
├── handoff/       dominio de la derivación al negocio sin HTTP: decisión, avisos, horario, tokens
├── backup/        copias de la instancia sin HTTP: formato cifrado, volcado, restauración,
│                  comprobación, retención, copia diaria y bloqueos
├── channels/      adaptadores de canal: WhatsApp (webhook y Graph API), web (iframe y API JSON)
│                  y los enlaces públicos de derivación (`/handoff/*`)
├── webchat/       dominio del chat web sin HTTP: configuración, disponibilidad, topes, sesión
├── mail/          adaptador de email (avisos de derivación por SMTP)
├── llm/           adaptador de Claude, construcción del prompt y resumen de derivaciones
├── speech/        adaptador de transcripción (solo con audios activados)
├── admin/         panel del operador: sesión, rutas, plantillas Eta + htmx, probar el bot
├── cli/           kb:snapshot, operator:hash-password, bot:chat, handoff:templates y
│                  db:backup, db:restore, db:verify, db:backups
├── bot.ts         composición del bot
├── app.ts         construcción de la app Fastify
├── startup.ts     arranque: bloqueo de instancia, migraciones con copia previa, purga y programador
└── server.ts      lee el entorno, llama a startInstance y atiende las señales
tests/             unit/, contract/, integration/, eval/, fixtures/ (los únicos con nombres de sector)
```
