# Implementation Plan: Atención automática de dudas y precios por WhatsApp

**Branch**: `002-whatsapp-faq-bot` | **Date**: 2026-09-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-whatsapp-faq-bot/spec.md`

**Ámbito**: Núcleo

## Summary

Los clientes finales escriben al WhatsApp del negocio y el bot contesta al momento, a
cualquier hora, dudas de horario, ubicación, servicios, precios y preguntas frecuentes, solo
con la información registrada en la base de conocimiento (spec 001). Si falta un dato, lo dice
y ofrece el contacto del negocio.

Enfoque técnico: webhook de la WhatsApp Cloud API con firma verificada que guarda cada
mensaje en PostgreSQL (deduplicado) y responde `200` al instante. Un procesador en el mismo
proceso espera 3 s sin mensajes nuevos del cliente, lee el `KnowledgeSnapshot` sin caché,
calcula por código los hechos delicados (hora local, abierto ahora, franjas de los próximos
14 días, precios formateados) y pide a Claude (`claude-sonnet-5`, esfuerzo `medium`, salida
estructurada, por la API de Anthropic) el cuerpo
de la respuesta y unas banderas. Un verificador determinista rechaza cualquier cifra que no
salga de los datos, y el código compone el saludo y el bloque de contacto para garantizar los
Principios IV y V. La atención de audios queda preparada tras un interruptor por instancia,
desactivado por defecto (FR-028): mientras esté apagado, un audio recibe el aviso de "solo
texto"; si se activa, se transcribe con Whisper durante la espera y el audio no se guarda.
Límite de 30 mensajes / 15 min por número, borrado automático a 30 días y registros técnicos
sin texto y con el número seudonimizado. Detalle en [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.x (strict) sobre Node.js 22 LTS (heredado de la 001)

**Primary Dependencies**: las de la 001 (Fastify 5, Drizzle ORM, `pg`, Zod,
libphonenumber-js…) más `@anthropic-ai/sdk` (modelo `claude-sonnet-5`). WhatsApp Cloud API
y transcripción (OpenAI `whisper-1`, solo con `AUDIO_TRANSCRIPTION=on`) con `fetch` nativo,
sin SDK adicional.

**Storage**: PostgreSQL 16, la misma BD por instancia; migración `0001` con `customer`,
`conversation` y `message` ([data-model.md](data-model.md))

**Testing**: Vitest — `unit`, `contract` (`fastify.inject`), `integration` (Testcontainers,
con `ChatModel`, `SpeechToText` y `ChannelSender` falsos y reloj controlable) y una suite
nueva `eval` con el modelo real, fuera de `pnpm test`

**Target Platform**: el mismo contenedor Linux por instancia; necesita salida HTTPS a
`graph.facebook.com`, `api.anthropic.com` y, solo con audios activados, `api.openai.com`, y
entrada HTTPS pública para el webhook

**Project Type**: servicio web (monolito modular): se añade el módulo de dominio
`src/conversation` y los adaptadores del canal, el modelo y la transcripción

**Performance Goals**: SC-003 — p95 < 10 s desde el último mensaje del lote hasta el envío,
con 3 s de espera incluidos; webhook p95 < 150 ms; decenas a cientos de mensajes al día por
instancia

**Constraints**: ninguna afirmación del negocio fuera del snapshot (FR-006, Principio IV);
contacto siempre disponible (Principio V); snapshot leído en cada respuesta sin caché
(FR-007); nada guardado si el negocio no está activo (FR-002); audios nunca persistidos;
registros sin texto (FR-030a); borrado a 30 días (FR-030); sin lógica sectorial (FR-031)

**Scale/Scope**: 1 número de WhatsApp y 1 negocio por instancia; hasta 4 conversaciones
procesándose en paralelo; historial de 30 mensajes por conversación en el contexto

Todas las incógnitas técnicas quedan resueltas en [research.md](research.md) (tabla final).
Cifras que la spec delegaba al plan: espera de agrupado 3 s con tope 8 s (R5); límite 30
mensajes / 15 min (R6); audio ≤ 2 MB y ≤ 120 s (R10); margen de borrado 24 h (R11).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Evaluación inicial (antes de Phase 0)

| Principio | Cumplimiento en esta feature | Estado |
|-----------|------------------------------|--------|
| **I. Base común única** | Spec de núcleo. Plantillas, instrucciones del modelo y detector de petición de persona son genéricos; todo lo que varía sale del snapshot (FR-031). El test de neutralidad existente recorre todo `src/`, incluidos los módulos nuevos. SC-010 se mide con los tres sectores de `tests/fixtures/`. | ✅ |
| **II. Configuración antes que código** | Nombre, horario, servicios, precios, FAQ, tono y contacto salen de la BD vía `KnowledgeReader`; cambiarlos no requiere desplegar y se aplica en la siguiente respuesta. Credenciales del canal, del modelo y de la transcripción son variables de instancia. | ✅ |
| **III. Personalizaciones aisladas** | Sin extensiones. Los puertos `ChatModel`, `SpeechToText`, `ChannelSender` y `MediaFetcher` son genéricos y permiten cambiar de proveedor sin tocar el dominio. | ✅ (N/A) |
| **IV. Solo información registrada** | Contexto cerrado al snapshot; hechos de horario y precios calculados por código; verificador determinista de cifras con respuesta segura; FAQ subordinadas a datos estructurados; tests unitarios del verificador y suite `eval` para SC-001/002/004. | ✅ |
| **V. Siempre hay salida a una persona** | El bloque de contacto lo compone el código desde `snapshot.handoff`; se añade si el modelo lo marca **o** si el detector determinista reconoce la petición; también en el aviso de límite, en la respuesta segura y en la disculpa por fallo de generación. La petición de persona prevalece sobre `needsRephrase`. Con el snapshot ilegible, la disculpa lleva el contacto de emergencia de la instancia (`EMERGENCY_CONTACT_PHONE`, FR-029). Durante el límite por número (FR-004a) no se contestan mensajes, tampoco las peticiones de persona: se justifica porque el aviso R-LIMIT ya entrega el contacto (y se repite como mucho una vez cada 15 min si el exceso continúa) y porque el límite solo salta con volúmenes que no corresponden a una conversación normal (R6). Tests unitarios (SC-008 al 100 %). | ✅ |
| **VI. El operador registra la información** | Los clientes finales no pueden alterar la configuración: el bot solo lee el snapshot; las instrucciones incrustadas en mensajes se tratan como datos (FR-026, test en `eval`). No se añade ninguna vía para el negocio. | ✅ |
| Restricción: canal WhatsApp | WhatsApp Cloud API oficial. | ✅ |
| Restricción: aislamiento | Conversaciones en la BD propia de la instancia; número y credenciales de WhatsApp propios; nada compartido entre instancias. | ✅ |
| Flujo: pruebas de IV y V | Deterministas en CI (unit + integración) y lingüísticas en `eval`, requisito para cerrar la feature. | ✅ |

**Resultado**: sin violaciones. Se puede continuar con Phase 0.

### Re-evaluación tras el diseño (Phase 1)

Revisados [data-model.md](data-model.md) y [contracts/](contracts/):

- **I**: las plantillas de [bot-replies.md](contracts/bot-replies.md) y las reglas de
  [chat-model.md](contracts/chat-model.md) no nombran sectores; la lista del detector usa
  expresiones de uso general. ✅
- **II**: ninguna tabla nueva guarda configuración del negocio; solo conversaciones. ✅
- **IV**: `ReplyContext` solo contiene el snapshot y hechos derivados de él; el verificador
  compara con `AllowedFacts` derivado del mismo snapshot; los precios "a consultar" y sin
  importe se entregan sin cifra y activan el contacto. ✅
- **V**: el árbol de decisión de [bot-replies.md](contracts/bot-replies.md) añade CONTACTO en
  todos los caminos donde el snapshot es legible y hace falta; la 001 garantiza que en un
  negocio activo nunca está vacío. Con el snapshot ilegible, R-ERR lleva el contacto de
  emergencia de la instancia (variable obligatoria con el canal), así que no queda ningún
  camino sin salida a una persona. ✅
- **VI**: el único endpoint nuevo es el webhook firmado de Meta; no escribe en tablas de la
  001. ✅
- **Privacidad** (restricción de aislamiento y FR-030/030a): audio solo en memoria; registros
  sin texto con seudónimo HMAC ([activity-log.md](contracts/activity-log.md)); borrado a 30
  días con cascada. ✅

**Resultado**: sin violaciones. Complexity Tracking vacío.

## Project Structure

### Documentation (this feature)

```text
specs/002-whatsapp-faq-bot/
├── plan.md              # Este fichero
├── research.md          # Phase 0: decisiones técnicas
├── data-model.md        # Phase 1: customer, conversation, message
├── quickstart.md        # Phase 1: guía de validación
├── contracts/
│   ├── whatsapp-webhook.md  # Webhook de Meta, envío y descarga de audio; puertos del canal
│   ├── chat-model.md        # Puerto ChatModel, petición a Claude y verificador de cifras
│   ├── bot-replies.md       # Composición, plantillas y árbol de decisión
│   └── activity-log.md      # Catálogo de registros técnicos
├── checklists/
└── tasks.md             # Phase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
src/
├── config/env.ts                 # + WHATSAPP_*, EMERGENCY_CONTACT_PHONE, ANTHROPIC_API_KEY, LLM_*, AUDIO_TRANSCRIPTION, STT_*
├── db/
│   ├── schema.ts                 # + customer, conversation, message
│   └── migrations/0001_*.sql
├── knowledge/                    # 001, sin cambios (se reutilizan snapshot y time/intervals)
├── conversation/                 # Dominio de esta feature (sin HTTP)
│   ├── ports.ts                  # ChatModel, SpeechToText, ChannelSender, MediaFetcher, Clock
│   ├── settings.ts               # Constantes: espera, tope, límite, ventana, retención
│   ├── intake.ts                 # Recepción: estado, deduplicación, conversación, límite
│   ├── processor.ts              # Cola: reclamar lotes, reglas de ventana, envío y reintentos
│   ├── transcription.ts          # Audios (si AUDIO_TRANSCRIPTION=on): descarga y transcripción en paralelo a la espera
│   ├── responder.ts              # Lote → ReplyContext → ChatModel → verificador → composición
│   ├── facts.ts                  # Hechos derivados y AllowedFacts desde el snapshot
│   ├── grounding.ts              # Verificador de cifras
│   ├── handoff-detector.ts       # Detector determinista de petición de persona
│   ├── templates.ts              # Plantillas tú/usted y formateo de contacto y horarios
│   ├── retention.ts              # Borrado a 30 días
│   ├── activity-log.ts           # Eventos del contrato y seudónimo HMAC
│   └── repositories/             # customer, conversation, message
├── channels/whatsapp/            # Adaptador HTTP del canal
│   ├── webhook.ts                # Rutas GET/POST, parser JSON encapsulado, firma
│   ├── payload.ts                # Esquema Zod del evento → InboundEvent
│   └── graph-client.ts           # ChannelSender y MediaFetcher sobre la Graph API
├── llm/anthropic-chat-model.ts   # ChatModel con @anthropic-ai/sdk
├── speech/whisper.ts             # SpeechToText sobre la API de transcripción
├── cli/bot-chat.ts               # pnpm bot:chat (ChannelSender de consola)
├── app.ts                        # + registro del webhook si el canal está configurado
└── server.ts                     # + arranque y parada del procesador y del borrado

tests/
├── unit/conversation/            # grounding, facts, templates, detector, intake, payload
├── contract/whatsapp-webhook.test.ts
├── integration/conversation/     # agrupado, límite, ventanas, reinicio, retención, registros
├── eval/                         # suite con el modelo real (vitest project "eval")
└── fixtures/                     # + preguntas por sector y audios de prueba
```

**Structure Decision**: proyecto único, siguiendo lo previsto en la 001. `src/conversation`
es un módulo de dominio hermano de `src/knowledge`, sin dependencias de HTTP ni de SDK
externos: habla con el mundo a través de `ports.ts`. Los adaptadores (`channels/whatsapp`,
`llm`, `speech`) son los únicos que conocen Fastify, la Graph API, `@anthropic-ai/sdk` o la
API de transcripción. El panel (`src/admin`) no cambia.

## Complexity Tracking

Sin violaciones de la constitución que justificar.
