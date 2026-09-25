# Estado del producto

Estados: especificada → planificada → en implementación → completada (o abandonada / sustituida).

| Nº  | Feature                         | Ámbito | Estado      | Rama                         | Spec                                            | Actualizado |
|-----|---------------------------------|--------|-------------|------------------------------|-------------------------------------------------|-------------|
| 001 | Base de conocimiento del negocio | Núcleo | En implementación | `001-business-knowledge-base` | [spec](specs/001-business-knowledge-base/spec.md) | 2026-09-24  |
| 002 | Atención de dudas y precios por WhatsApp | Núcleo | En implementación | `002-whatsapp-faq-bot` | [spec](specs/002-whatsapp-faq-bot/spec.md) · [plan](specs/002-whatsapp-faq-bot/plan.md) · [tareas](specs/002-whatsapp-faq-bot/tasks.md) | 2026-09-25  |

**Siguiente paso**: la 001 tiene todas sus tareas hechas y la suite en verde. Para pasarla a
"completada" falta cronometrar el alta de un negocio típico (SC-001, escenario 8 del
quickstart) y construir la imagen Docker en un entorno con acceso al registro de npm.
La 002 tiene implementadas las cinco historias, los tipos de mensaje no atendidos, los audios
(desactivados por defecto), el límite por número, la ventana de 24 h y el borrado a los 30
días, con `pnpm test` en verde. La evaluación con el modelo real (`claude-sonnet-5`, esfuerzo
`medium`) dio 174 de 175 casos correctos; el fallo (plazos en minutos) está corregido. Para
pasarla a "completada" falta recorrer los escenarios del quickstart con `pnpm bot:chat` (T100)
y grabar los 21 audios de prueba de `tests/fixtures/audio/` para medir los audios (T083). Usa Claude Sonnet 5 por la API de
Anthropic. Antes de usarla con clientes reales hacen falta los contratos de encargado del
tratamiento con Meta y Anthropic (y con el proveedor de transcripción si se activan los
audios).

---

# Núcleo del chatbot: base de conocimiento, panel del operador y bot de WhatsApp

Cada cliente tiene su propia instancia (contenedor + base de datos PostgreSQL) construida a
partir de este núcleo y de su configuración. El operador registra la información del negocio
en un panel web (feature 001) y el bot atiende por WhatsApp las dudas de horario, ubicación,
servicios, precios y preguntas frecuentes (feature 002). El bot lee
`KnowledgeReader.getSnapshot()` de la base de datos en cada respuesta, sin caché; el modelo
(Claude) solo redacta, y el código calcula horarios, verifica las cifras y añade el contacto
del negocio cuando hace falta.

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

Para probar el bot sin WhatsApp, con el negocio activo y `ANTHROPIC_API_KEY` en `.env`:

```bash
pnpm bot:chat                               # conversación en la terminal; --as <número>, --verbose
pnpm bot:chat --flood 35                    # envía 35 mensajes seguidos (límite por número)
```

Las guías de validación, con los escenarios manuales, están en
[specs/001-business-knowledge-base/quickstart.md](specs/001-business-knowledge-base/quickstart.md) y
[specs/002-whatsapp-faq-bot/quickstart.md](specs/002-whatsapp-faq-bot/quickstart.md).

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
| `EMERGENCY_CONTACT_PHONE` | Con el canal | Teléfono E.164 que se da si no se puede leer la información del negocio |
| `ANTHROPIC_API_KEY` | Con el canal | Clave de la API de Anthropic (también para `pnpm bot:chat` y `pnpm test:eval`) |
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
las migraciones pendientes. Dar de alta un negocio o cambiar sus datos se hace en el panel, sin
desplegar. El webhook de WhatsApp escucha en `/webhooks/whatsapp` (verificación con
`WHATSAPP_VERIFY_TOKEN` y firma con `WHATSAPP_APP_SECRET`). Las conversaciones se borran a los
30 días y los registros técnicos no guardan textos ni números en claro.

## Estructura

```text
src/
├── config/        variables de la instancia (Zod)
├── db/            esquema Drizzle, migraciones, cliente y transacciones
├── knowledge/     dominio sin HTTP: esquemas, reglas temporales, avisos, snapshot, casos de uso
├── conversation/  dominio del bot sin HTTP: recepción, espera, respuesta, verificador, plantillas
├── channels/      adaptador de WhatsApp (webhook y Graph API)
├── llm/           adaptador de Claude y construcción del prompt
├── speech/        adaptador de transcripción (solo con audios activados)
├── admin/         panel del operador: sesión, rutas, plantillas Eta + htmx
├── cli/           kb:snapshot, operator:hash-password y bot:chat
├── bot.ts         composición del bot
├── app.ts         construcción de la app Fastify
└── server.ts      arranque
tests/             unit/, contract/, integration/, eval/, fixtures/ (los únicos con nombres de sector)
```
