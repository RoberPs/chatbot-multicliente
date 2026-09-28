# Estado del producto

Estados: especificada → planificada → en implementación → completada (o abandonada / sustituida).

| Nº  | Feature                         | Ámbito | Estado      | Rama                         | Spec                                            | Actualizado |
|-----|---------------------------------|--------|-------------|------------------------------|-------------------------------------------------|-------------|
| 001 | Base de conocimiento del negocio | Núcleo | En implementación | `001-business-knowledge-base` | [spec](specs/001-business-knowledge-base/spec.md) | 2026-09-24  |
| 002 | Atención de dudas y precios por WhatsApp | Núcleo | En implementación | `002-whatsapp-faq-bot` | [spec](specs/002-whatsapp-faq-bot/spec.md) · [plan](specs/002-whatsapp-faq-bot/plan.md) · [tareas](specs/002-whatsapp-faq-bot/tasks.md) | 2026-09-25  |
| 003 | Claridad del panel del operador y enlace a mapa | Núcleo | En implementación | `004-web-channel` | [spec](specs/003-admin-panel-clarity/spec.md) · [plan](specs/003-admin-panel-clarity/plan.md) · [tareas](specs/003-admin-panel-clarity/tasks.md) | 2026-09-28  |
| 004 | Canal web del bot de atención | Núcleo | Completada | `004-web-channel` | [spec](specs/004-web-channel/spec.md) · [plan](specs/004-web-channel/plan.md) · [tareas](specs/004-web-channel/tasks.md) | 2026-09-28  |
| 005 | Derivación de la conversación al negocio | Núcleo | Planificada | `005-handoff-to-business` | [spec](specs/005-handoff-to-business/spec.md) · [plan](specs/005-handoff-to-business/plan.md) | 2026-09-28  |

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
[specs/003-admin-panel-clarity/quickstart.md](specs/003-admin-panel-clarity/quickstart.md) y
[specs/004-web-channel/quickstart.md](specs/004-web-channel/quickstart.md).

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
| `pnpm db:migrate` | Aplica las migraciones a `DATABASE_URL` |
| `pnpm kb:snapshot` | Imprime el `KnowledgeSnapshot` actual |
| `pnpm operator:hash-password` | Pide una contraseña sin mostrarla y devuelve su hash Argon2id |

## Despliegue

`Dockerfile` construye una imagen única del núcleo, igual para todos los clientes. Cada
instancia es un contenedor con sus variables de entorno y su base de datos; al arrancar aplica
las migraciones pendientes. Dar de alta un negocio, cambiar sus datos o activar el chat web se
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
├── channels/      adaptadores de canal: WhatsApp (webhook y Graph API) y web (iframe y API JSON)
├── webchat/       dominio del chat web sin HTTP: configuración, disponibilidad, topes, sesión
├── llm/           adaptador de Claude y construcción del prompt
├── speech/        adaptador de transcripción (solo con audios activados)
├── admin/         panel del operador: sesión, rutas, plantillas Eta + htmx, probar el bot
├── cli/           kb:snapshot, operator:hash-password y bot:chat
├── bot.ts         composición del bot
├── app.ts         construcción de la app Fastify
└── server.ts      arranque
tests/             unit/, contract/, integration/, eval/, fixtures/ (los únicos con nombres de sector)
```
