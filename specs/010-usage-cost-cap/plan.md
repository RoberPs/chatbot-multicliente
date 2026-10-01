# Implementation Plan: Consumo y coste por instancia

**Branch**: `010-usage-cost-cap` | **Date**: 2026-10-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/010-usage-cost-cap/spec.md`

**Ámbito**: Núcleo

## Summary

Cada llamada al modelo deja un registro de tokens sin textos; el operador ve en el panel el consumo
y el coste estimado por canal, con precios que él mantiene, y puede fijar un tope mensual de gasto
que, al alcanzarse, hace que el bot dé el contacto del negocio sin llamar al modelo.

Enfoque técnico: un módulo de dominio nuevo `src/usage` y ganchos pequeños en la cadena existente.

1. **Medición** — los puertos `ChatModel` y `HandoffSummarizer` aceptan un receptor `onUsage`; el
   adaptador de Anthropic lo llama con `response.usage` siempre que el proveedor responda (también
   si la respuesta se descarta). El responder suma los intentos de una respuesta y el procesador
   guarda **un registro por respuesta** (y otro por resumen de derivación) con `UsageMeter.record`,
   fuera de la transacción del saliente y sin poder bloquearla (R1–R3).
2. **Coste** — precios por modelo en millonésimas por millón de tokens; el coste se calcula **al
   insertar** con el precio vigente y se guarda en billonésimas (enteros exactos); sin precio queda
   nulo para siempre (R4, R5). Días y meses en la hora local del negocio (R6).
3. **Tope** — `spendCapState` (una consulta, sin caché) se comprueba antes de llamar al modelo en
   WhatsApp y web, en la recepción y la disponibilidad del chat web, en cada página del panel y en el
   informe de salud (R7). Con el tope alcanzado: WhatsApp responde `R-CAP` + contacto y sigue
   decidiendo la derivación con el detector determinista; el chat web pasa al estado "no
   disponible" de la 004; los avisos al negocio llevan el resumen literal; "Probar el bot" sigue
   (R8, R9). Evento `spend_cap_reached` una vez por mes, persistido (R10).
4. **Panel** — pantalla `/admin/usage` (hoy, mes, meses conservados por canal y por día, precios,
   moneda y tope) y aviso común en el layout (≥ 80 %, alcanzado, modelo actual sin precio), fuera de
   `computeWarnings` (R12, R13).
5. **Parque** — `/health` con secreto añade `spendCap`; `instance:versions` lo muestra en una columna
   informativa (R11).
6. **Retención** — 13 meses en la pasada horaria existente (R14).

Detalle de decisiones en [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.x (strict) sobre Node.js 22 LTS (heredado)

**Primary Dependencies**: las existentes — Fastify 5, Eta + htmx (panel), Drizzle ORM + drizzle-kit,
`pg`, Zod, `@anthropic-ai/sdk` 0.128 (tipo `Usage`: `input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`). **Sin dependencias nuevas.**

**Storage**: PostgreSQL 16, una BD por instancia. Migración de solo añadir `0006_usage.sql`: tablas
`model_usage`, `model_price`, `usage_settings` (fila única) y enum `usage_purpose`; reutiliza el
enum `customer_channel` ([data-model.md](data-model.md)). No son configuración del negocio: **no
sube `formatVersion`** ni entran en el fichero de la 008 (R15). Entran solas en las copias de la 006.

**Testing**: Vitest —
`unit` (`costPico` y unidades; conversión de decimales a millonésimas y céntimos; niveles y
porcentaje del tope en los bordes 80 %/100 %; suma de intentos en el responder; `onUsage` del
adaptador con respuesta válida, descartada y error; validaciones Zod de precios y ajustes; `R-CAP` y
decisión de la derivación con salida sintética; formato con 4 decimales; columna y JSON de
`instance:versions`; lista cerrada de columnas de `model_usage` sin datos personales; el formato de
la 008 no cubre las tablas nuevas),
`contract` (`fastify.inject`: `/admin/usage` con sesión y CSRF, 422 por campo, activar sin precio,
cambio de moneda con precios, `?month`; aviso del layout en todas las pantallas; recordatorio en
"Probar el bot"; `/health` con y sin secreto; API y frame del chat web "no disponible" por tope de
gasto),
`integration` (Testcontainers: registro por canal, reintento del verificador sumado, resumen de
derivación; tope en WhatsApp y web sin llamadas al modelo; derivación con tope; subida del tope y
cambio de mes con reloj falso en la zona del negocio; evento una vez por mes; concurrencia cerca del
tope; retención de 13 meses; restauración de copia; rendimiento SC-006).
Sin `eval` nuevo: el prompt y la salida del modelo no cambian; la ruta sin modelo se prueba con
dobles.

**Target Platform**: servidor Linux (contenedor `node:22-slim`); `instance:versions` en el equipo
del operador.

**Project Type**: servicio web (monolito modular): módulo nuevo `src/usage`; cambios en
`src/conversation`, `src/handoff`, `src/llm`, `src/webchat`, `src/admin`, `src/health`,
`src/provisioning/versions.ts`.

**Performance Goals**: ≤ 10 ms añadidos por respuesta (una consulta del tope + una inserción) como
objetivo de diseño; SC-006 exige < 100 ms en la mediana (R16). La pantalla "Consumo" responde en
< 500 ms con un mes de 50 000 registros (índice por `day`).

**Constraints**: ningún texto ni identificador personal o de conversación en `model_usage`
(FR-003); registrar nunca impide responder (FR-005); tope sin caché (FR-016, FR-022); costes
congelados al registrar (FR-011); enteros exactos (SC-002); `/health` sin credencial intacto;
estado del tope sin importes; nada de sectores ni clientes en `src/`; textos en español.

**Scale/Scope**: hasta decenas de miles de respuestas al mes por instancia; 13 meses de registros.

No quedan incógnitas técnicas: unidades, captura de tokens, texto con el tope alcanzado, salud y
retención están resueltos en el research.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio / regla | Evaluación |
|---|---|
| I. Base común única | **Cumple.** Precios, moneda y tope son datos genéricos de la instancia; el núcleo no trae precios ni topes de ningún cliente (FR-026). Ningún nombre ni rama de sector en `src/`. |
| II. Configuración antes que código | **Cumple.** Precios, moneda y tope se configuran en el panel sin desplegar. No son configuración del negocio (no se exportan, FR-024): no sube `formatVersion`; el test de cobertura de columnas no cambia y un test nuevo fija que las tablas no viajan. |
| III. Personalizaciones aisladas | **No aplica**: no hay extensiones ni puntos de extensión nuevos. |
| IV. Solo información registrada | **Cumple.** Con el tope, el bot no genera texto: `R-CAP` es una plantilla fija con el contacto registrado. Sin tope, la cadena (prompt, verificador) no cambia. |
| V. Siempre hay salida a una persona | **Cumple.** Con el tope alcanzado toda respuesta lleva el contacto del negocio (o el de emergencia); en WhatsApp las peticiones de persona se siguen detectando y derivando (detector determinista + decisión de la 005); en web el estado "no disponible" muestra el contacto, como en la 004. Pruebas de integración lo verifican antes de cerrar. |
| VI. El operador registra la información | **Cumple.** Solo el operador con sesión ve y cambia precios y tope; el negocio no tiene acceso. |
| Aislamiento entre instancias | **Cumple.** Registros, precios y tope viven en la BD de cada instancia; el estado del tope sale solo por el `/health` con secreto propio. |
| Flujo de desarrollo (convenciones) | Spec de núcleo declarada. Migración de solo añadir. Dominio sin HTTP (`src/usage`; las rutas en `src/admin`). Fechas en hora local con zona IANA; importes en enteros (el coste en billonésimas porque un céntimo no basta, R4). README y `docs/operacion-multicliente.md` (9.1, 9.2, P4 hecha, secciones de operación del panel y de la consulta del parque) se actualizan al cerrar, avisando antes al usuario. |
| Pruebas de IV y V | La feature cambia la conversación (ruta con tope): pruebas de integración de contacto en `R-CAP`, derivación con tope y estado "no disponible" del chat web. |

**Resultado: sin violaciones; Complexity Tracking vacío.**

**Re-evaluación tras el diseño (Phase 1)**: el diseño añade tres tablas sin datos personales, un
campo informativo en el `/health` protegido y una plantilla fija con contacto; no añade dependencias
ni toca el prompt. La ruta con tope reutiliza la decisión de derivación de la 005 sin bifurcarla.
Sin cambios en la evaluación.

## Project Structure

### Documentation (this feature)

```text
specs/010-usage-cost-cap/
├── plan.md                               # Este fichero
├── research.md                           # Phase 0
├── data-model.md                         # Phase 1
├── quickstart.md                         # Phase 1
├── contracts/
│   ├── usage-recording.md                # puertos onUsage, UsageMeter, quién registra
│   ├── spend-cap-conversation.md         # tope en la cadena: R-CAP, web, derivación, eventos
│   ├── admin-usage-screen.md             # /admin/usage y aviso del layout
│   └── health-spend-cap.md               # spendCap en /health e instance:versions
└── tasks.md                              # Phase 2 (/speckit-tasks; no lo crea /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── usage/                                # NUEVO — dominio, sin HTTP
│   ├── types.ts                          # TokenUsage, ResponseUsage, SpendCapLevel…
│   ├── money.ts                          # costPico, decimales ↔ millonésimas/céntimos, formato 4 decimales
│   ├── schemas.ts                        # Zod: precio y ajustes (FR-013, FR-014)
│   ├── meter.ts                          # createUsageMeter: INSERT … SELECT, nunca lanza (FR-005)
│   ├── spend-cap.ts                      # spendCapState, markNotified (evento una vez por mes)
│   ├── summary.ts                        # resúmenes por canal, día y mes; meses conservados
│   ├── settings.ts                       # lectura/escritura de precios y ajustes en transacción
│   └── retention.ts                      # purgeModelUsage (13 meses)
├── knowledge/time/local-date.ts          # localDay / localMonthRange (movidos desde webchat/usage.ts)
├── db/schema.ts · db/migrations/0006_usage.sql
├── llm/anthropic-chat-model.ts           # onUsage con response.usage (también si se descarta)
├── llm/anthropic-summarizer.ts           # onUsage
├── conversation/
│   ├── ports.ts                          # onUsage en ChatModel
│   ├── channels.ts                       # ChannelPolicy.spendCap
│   ├── types.ts                          # R-CAP en REPLY_TEMPLATES
│   ├── templates.ts · responder.ts       # capResponse; suma de intentos → response.usage
│   ├── processor.ts                      # comprobación del tope, ruta R-CAP, registro de consumo
│   ├── intake.ts                         # descarte web `spend_cap`
│   ├── activity-log.ts                   # eventos nuevos
│   └── retention.ts                      # llama a purgeModelUsage
├── handoff/ports.ts · service.ts         # onUsage del resumen; modelSummary: false
├── webchat/availability.ts               # tope de gasto → reason 'quota'
├── bot.ts                                # compone UsageMeter y lo pasa a procesador y derivación
├── admin/
│   ├── routes/usage.ts                   # NUEVO — /admin/usage, precios, ajustes
│   ├── routes/index.ts                   # registra la ruta
│   ├── render.ts                         # layout.spend en cada página
│   ├── routes/playground.ts              # recordatorio con el tope alcanzado
│   └── views/usage.eta · partials/usage-table.eta · partials/spend-banner.eta · layout.eta · playground.eta
├── health/report.ts                      # spendCap en el sondeo y en fullView
└── provisioning/versions.ts              # columna Tope y campo spendCap

tests/
├── unit/usage/ · unit/llm/ · unit/conversation/ · unit/provisioning/versions.test.ts · unit/config-transfer/
├── contract/admin/usage.test.ts · contract/admin/spend-banner.test.ts · contract/health.test.ts · contract/web-chat-limits.test.ts
└── integration/usage/ (registro, tope, derivación, mes, retención, concurrencia) · integration/performance.test.ts · integration/backup/

docs/operacion-multicliente.md            # 9.1/9.2, P4 hecha, panel y consulta del parque
README.md                                 # estado de la feature 010
```

**Structure Decision**: monolito modular existente. El dominio nuevo (`src/usage`) no depende de
HTTP y lo usan la conversación, la derivación, el panel y la salud; la pantalla vive en `src/admin`
y el cálculo del aviso en `renderPage`, como la línea de versión de la 009. `localDay` se mueve a
`src/knowledge/time` para que `src/usage` y `src/webchat` lo compartan sin depender uno del otro.

## Complexity Tracking

> Sin violaciones de la constitución que justificar.
