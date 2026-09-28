# Implementation Plan: Claridad del panel del operador y enlace a mapa

**Branch**: `003-admin-panel-clarity` (se implementa sobre `004-web-channel`, [research R1](research.md#r1-rama-y-punto-de-partida)) | **Date**: 2026-09-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-admin-panel-clarity/spec.md`

**Ámbito**: Núcleo

## Summary

El panel pasa a explicar lo que ya hace el sistema: una casilla "Quitar" en cada medio de
derivación, un recuadro con el contacto al que el bot pasa las conversaciones (en Datos y en
Derivación), un mensaje al guardar cuando ese contacto cambia o se toca el teléfono o los
medios, textos de registro único en Políticas, Tono y Derivación, resúmenes en la portada y
ayuda en "Cómo llegar". Además se añade el campo opcional "Enlace a mapa" (solo `https://`,
≤ 500 caracteres), que llega al bot en el snapshot junto a la dirección.

Enfoque técnico: la casilla se resuelve en `handoffSchema` (las filas marcadas no se validan
ni se guardan) y se ve tachada con CSS `:has()`, sin JavaScript. El contacto del bot sigue
siendo `effectiveHandoff(state)`; una variante de `runGuardedWrite` devuelve el estado antes
y después dentro de la misma transacción, y el dominio devuelve un `HandoffChange` que el
panel convierte en el mensaje del flash. Una columna nueva `business.map_url` (migración
`0003`), un esquema Zod propio y `snapshot.business.mapUrl`. Como la 002 ya está
implementada, se ajusta el prompt para que el modelo pueda copiar ese enlace (hoy tiene
prohibido escribir enlaces); el verificador de cifras ya lo admite. Detalle en
[research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.x (strict) sobre Node.js 22 LTS (heredado)

**Primary Dependencies**: las de la 001/002/004 (Fastify 5, Eta + htmx, Drizzle ORM, Zod 4,
libphonenumber-js, `@anthropic-ai/sdk`). Sin dependencias nuevas.

**Storage**: PostgreSQL 16, una BD por instancia; migración `0003`: columna nula
`business.map_url text`. Nada más cambia en la BD.

**Testing**: Vitest. Unitarios (esquema de `map_url`, `sameContact`, `describeHandoffChange`,
mensajes, resúmenes, snapshot, verificador con enlaces de mapas, prompt), de contrato con
`fastify.inject` (rutas del panel y forma del snapshot) e integración con Testcontainers
(quitar medios con FR-032, frescura de `mapUrl`). Un caso nuevo de `pnpm test:eval`.

**Target Platform**: servidor Linux (contenedor), una instancia por cliente (heredado)

**Project Type**: servicio web con panel renderizado en servidor (heredado)

**Performance Goals**: sin objetivos nuevos. El guardado de Datos y Derivación carga el estado
una vez más dentro de la transacción; es una pantalla del operador con carga despreciable.

**Constraints**: todo funciona sin JavaScript (FR-004, casos límite); sin nombres de sector en
`src/` (Principio I); el snapshot sin caché (FR-021 de la 001); los derivados (contacto del
bot, resúmenes) se calculan en cada petición y no se guardan.

**Scale/Scope**: 1 columna, 1 migración, 2 funciones de dominio, 2 módulos pequeños del panel,
6 vistas y 1 parcial, 1 regla del prompt; documentación de la 001 y la 002.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Cumple | Cómo |
|-----------|--------|------|
| I. Base común única | Sí | Todo es genérico. El ejemplo de "Cómo llegar" no nombra sectores; el test de neutralidad sectorial recorre también las vistas nuevas. El enlace no se limita a un proveedor de mapas (FR-012) |
| II. Configuración antes que código | Sí | El enlace a mapa es un dato más del negocio, editable desde el panel sin despliegue |
| III. Personalizaciones aisladas | Sí (N/A) | Spec de núcleo; no hay extensiones ni puntos de extensión nuevos |
| IV. Solo información registrada | Sí | El bot solo puede dar el enlace guardado: el verificador de cifras rechaza cualquier otro enlace, y se prueba (R9). El prompt pide copiarlo tal cual |
| V. Siempre hay salida a una persona | Sí | Quitar medios sigue protegido por FR-032 (rechazo con el negocio activo, probado en integración). El operador ve siempre a quién pasa el bot la conversación y se le avisa cuando un negocio en preparación se queda sin salida (FR-005 – FR-007). No cambia la detección de la petición de persona |
| VI. El operador registra la información | Sí | Todo ocurre en el panel del operador; nada nuevo para el negocio |
| Flujo: spec con ámbito | Sí | La spec declara "núcleo" |
| Flujo: pruebas de IV y V | Sí | IV: verificador con enlace guardado y con enlace inventado + caso de eval. V: integración de FR-032 al quitar el último medio |

**Resultado**: sin desviaciones. No hay nada en *Complexity Tracking*.

**Re-evaluación tras el diseño (Fase 1)**: se mantiene. El único cambio en la conversación es
una regla del prompt y un campo más del snapshot; el verificador determinista sigue siendo la
garantía del Principio IV. La casilla "Quitar" no crea ningún camino de guardado fuera de
`runGuardedWrite`.

## Project Structure

### Documentation (this feature)

```text
specs/003-admin-panel-clarity/
├── spec.md
├── plan.md              # Este fichero
├── research.md          # Fase 0
├── data-model.md        # Fase 1
├── quickstart.md        # Fase 1: guía de validación
├── contracts/
│   ├── admin-panel.md       # Rutas, recuadro, mensajes y textos del panel
│   └── knowledge-reader.md  # snapshot.business.mapUrl y cambio del prompt
├── checklists/
└── tasks.md             # Fase 2 (/speckit-tasks)
```

Documentos de otras features que se actualizan al implementar:

```text
specs/001-business-knowledge-base/quickstart.md           # escenario 6 y enlace a esta guía (FR-016)
specs/001-business-knowledge-base/contracts/admin-panel.md
specs/001-business-knowledge-base/contracts/knowledge-reader.md
specs/002-whatsapp-faq-bot/spec.md                         # US1, escenario 4: enlace a mapa
specs/002-whatsapp-faq-bot/contracts/chat-model.md
README.md                                                  # estado de la feature (avisando antes)
```

### Source Code (repository root)

```text
src/
├── db/
│   ├── schema.ts                      # business.mapUrl
│   └── migrations/0003_*.sql          # ADD COLUMN map_url (drizzle-kit generate)
├── knowledge/
│   ├── types.ts                       # BusinessRecord.mapUrl, snapshot, HandoffChange
│   ├── state.ts                       # lee map_url
│   ├── snapshot.ts                    # business.mapUrl
│   ├── handoff.ts                     # + sameContact, describeHandoffChange
│   ├── schemas/common.ts              # + optionalHttpsUrl
│   ├── schemas/business.ts            # + map_url
│   ├── schemas/handoff.ts             # + channels[i].remove
│   └── services/
│       ├── guarded-write.ts           # + runTrackedWrite (estado antes y después)
│       ├── business-info.ts           # saveBusiness → HandoffChange
│       └── settings.ts                # saveHandoff → HandoffChange
├── llm/prompt.ts                      # regla de enlaces y de ubicación
└── admin/
    ├── render.ts                      # submitForm: message como función del resultado
    ├── handoff-notice.ts              # nuevo: HandoffChange → texto del flash; texto del recuadro
    ├── section-summaries.ts           # nuevo: resúmenes de la portada
    ├── routes/business.ts             # map_url, recuadro, flash
    ├── routes/handoff.ts              # remove, 409 con valores guardados, recuadro, flash
    ├── routes/dashboard.ts            # resúmenes
    └── views/
        ├── business.eta               # ayuda de "Cómo llegar", enlace a mapa, recuadro
        ├── handoff.eta                # texto de registro único, recuadro
        ├── policies.eta, tone.eta     # texto de registro único
        ├── dashboard.eta              # resúmenes
        ├── app.css                    # fila marcada para quitar (:has)
        └── partials/
            ├── channel-row.eta        # casilla "Quitar"
            └── handoff-effective.eta  # nuevo: recuadro "Contacto que usa el bot"

tests/
├── unit/
│   ├── schemas/business.test.ts       # map_url
│   ├── schemas/handoff.test.ts        # remove
│   ├── knowledge/handoff-change.test.ts
│   ├── admin/handoff-notice.test.ts, section-summaries.test.ts
│   ├── snapshot/…                     # mapUrl
│   ├── conversation/grounding…        # enlaces de mapas permitidos y rechazados
│   └── llm/prompt…                    # regla de ubicación
├── contract/
│   ├── admin/business.test.ts, handoff.test.ts, dashboard…, policies…, tone…
│   └── snapshot-shape.test.ts         # mapUrl en el objeto estricto
├── integration/
│   ├── handoff-protection.test.ts     # quitar el último medio con el negocio activo
│   └── freshness.test.ts              # mapUrl en el siguiente snapshot
├── eval/                              # caso de ubicación con enlace (modelo real)
└── fixtures/                          # mapUrl en alguna fixture de sector
```

**Structure Decision**: se mantiene la estructura de un solo proyecto de la 001. El dominio
(`src/knowledge`) calcula el contacto del bot y su cambio sin saber nada de HTTP; los textos
para el operador viven en `src/admin`.

## Complexity Tracking

Sin violaciones de la constitución.
