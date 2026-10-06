# Implementation Plan: Base de conocimiento del negocio

**Branch**: `001-business-knowledge-base` | **Date**: 2026-09-24 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-business-knowledge-base/spec.md`

**Ámbito**: Núcleo

## Summary

El bot de cada instancia necesita la información del negocio (datos, horario y cierres,
servicios, recursos, FAQ, políticas, tono y contacto de derivación) para responder y gestionar
citas. El operador la registra y mantiene en un panel web de administración de la instancia,
con validación al guardar, avisos de datos incompletos y un estado del negocio
("en preparación" / "activo") que no se puede activar sin salida a una persona.

Enfoque técnico: servicio web único en TypeScript/Node.js con Fastify y panel renderizado en
servidor (Eta + htmx). Una base de datos PostgreSQL por instancia garantiza el aislamiento.
La validación vive en esquemas Zod del dominio; los avisos se calculan siempre a partir del
estado actual (nunca se almacenan). Cada guardado se hace en una transacción que se revierte si
deja un negocio activo con un aviso crítico. El bot lee un `KnowledgeSnapshot` de la BD en cada
respuesta, sin caché, así que cualquier cambio se aplica en la siguiente respuesta.
Detalle en [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.x (strict) sobre Node.js 22 LTS

**Primary Dependencies**: Fastify 5, `@fastify/view` + Eta, htmx, `@fastify/formbody`,
`@fastify/secure-session`, `@fastify/csrf-protection`, `@fastify/rate-limit`, Drizzle ORM +
drizzle-kit, `pg`, Zod, libphonenumber-js, argon2

**Storage**: PostgreSQL 16, una base de datos por instancia (sin `tenant_id`)

**Testing**: Vitest (unit, contract con `fastify.inject`, integration con Testcontainers)

**Target Platform**: contenedor Linux, una instancia (contenedor + BD) por cliente

**Project Type**: servicio web (monolito modular): panel de administración + puerto de
lectura interno para el bot

**Performance Goals**: `getSnapshot()` p95 < 50 ms con 100 servicios, 20 recursos y 100 FAQ;
guardado de un formulario p95 < 300 ms

**Constraints**: cero caché de datos del negocio en el camino del bot (FR-021); cambios de datos
sin despliegue (FR-020); aislamiento total entre instancias (FR-022); sin campos sectoriales
(FR-024)

**Scale/Scope**: 1 negocio y 1 operador por instancia; decenas de servicios, recursos y FAQ;
~15 pantallas de panel

Todas las incógnitas técnicas quedan resueltas en [research.md](research.md) (tabla final).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Evaluación inicial (antes de Phase 0)

| Principio | Cumplimiento en esta feature | Estado |
|-----------|------------------------------|--------|
| **I. Base común única** | Spec de núcleo. Modelo genérico (FR-024): servicios, recursos, FAQ y políticas sin campos de sector. Los sectores solo aparecen como fixtures de test (SC-005). Test automático que busca nombres de sector/cliente en `src/`. | ✅ |
| **II. Configuración antes que código** | Toda la información del negocio es dato en BD editado desde el panel; alta y cambios sin despliegue (FR-020, SC-002). Parámetros de instancia (región telefónica, zona horaria y moneda por defecto) por variables de entorno, no en código. | ✅ |
| **III. Personalizaciones aisladas** | No hay extensiones en esta feature. El `KnowledgeReader` es un puerto genérico del núcleo sobre el que se apoyarán las specs siguientes. No se introduce nada específico de un cliente. | ✅ (N/A) |
| **IV. Solo información registrada** | El snapshot solo expone datos registrados y activos; nunca rellena valores por defecto inventados. Distingue "a consultar" de "importe no registrado" (`price.type = "missing"`) y marca como no reservable lo que no tiene duración. Los datos estructurados prevalecen sobre las FAQ (FR-014a). El comportamiento conversacional y sus pruebas corresponden a las specs de conversación. | ✅ |
| **V. Siempre hay salida a una persona** | Contacto de derivación efectivo con respaldo en el teléfono del negocio (FR-019). Aviso crítico si no hay ninguno; un negocio no puede activarse ni quedar activo sin salida (FR-031, FR-032), comprobado en transacción. Tests de integración para ambos casos. | ✅ |
| **VI. El operador registra la información** | Panel accesible solo con sesión de operador; ninguna ruta, rol ni API para el negocio (FR-023). | ✅ |
| Restricción: aislamiento entre instancias | Una BD por instancia; el proceso solo conoce su `DATABASE_URL`. | ✅ |
| Flujo: pruebas de IV y V | Esta feature no conversa, pero sí prueba las garantías de datos en que se apoyan IV y V (snapshot sin inactivos ni valores inventados; negocio activo siempre con derivación). | ✅ |

**Resultado**: sin violaciones. Se puede continuar con Phase 0.

### Re-evaluación tras el diseño (Phase 1)

Revisados [data-model.md](data-model.md) y [contracts/](contracts/):

- **I / FR-024**: ningún campo de sector; formas de pago en texto libre para no fijar una lista
  de un país; tipos de recurso sin enumerar ("profesional", "puesto"… son solo ejemplos). ✅
- **II**: los singletons (`business`, `policies`, `tone`, `handoff_contact`) se crean o editan
  desde el panel; la migración inicial solo crea el negocio vacío en `draft`. ✅
- **IV**: el contrato de [knowledge-reader.md](contracts/knowledge-reader.md) garantiza que los
  campos no registrados son `null` o listas vacías y que la única sustitución (teléfono como
  derivación) va marcada con `source`. ✅
- **V**: `HANDOFF_UNREACHABLE` es crítico; activación y guardado en negocio activo usan el mismo
  cálculo dentro de la transacción; el snapshot de un negocio activo nunca tiene
  `handoff.source = "none"`. ✅
- **VI**: [admin-panel.md](contracts/admin-panel.md) solo define rutas bajo `/admin` con sesión
  de operador. ✅

**Resultado**: sin violaciones. Complexity Tracking vacío.

## Project Structure

### Documentation (this feature)

```text
specs/001-business-knowledge-base/
├── plan.md              # Este fichero
├── research.md          # Phase 0: decisiones técnicas
├── data-model.md        # Phase 1: entidades, reglas y estados
├── quickstart.md        # Phase 1: guía de validación
├── contracts/
│   ├── admin-panel.md       # Rutas y comportamiento del panel
│   ├── knowledge-reader.md  # Puerto de lectura del bot (KnowledgeSnapshot)
│   └── warnings.md          # Catálogo de avisos
├── checklists/
└── tasks.md             # Phase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
src/
├── config/
│   └── env.ts                    # Variables de instancia validadas con Zod
├── db/
│   ├── schema.ts                 # Tablas Drizzle (data-model.md)
│   ├── client.ts                 # Pool y helper de transacciones
│   └── migrations/               # Generadas por drizzle-kit
├── knowledge/                    # Dominio de esta feature (sin HTTP)
│   ├── schemas/                  # Zod: business, hours, closure, service, resource, faq,
│   │                             #      policies, tone, handoff
│   ├── time/                     # Franjas semanales, cierres, effectiveIntervals, isOpenAt
│   ├── warnings.ts               # computeWarnings (catálogo de contracts/warnings.md)
│   ├── state.ts                  # Carga del KnowledgeState completo (para avisos y snapshot)
│   ├── snapshot.ts               # KnowledgeReader.getSnapshot (contracts/knowledge-reader.md)
│   ├── repositories/             # Acceso a BD por entidad
│   └── services/                 # Casos de uso: guardar X, activar/desactivar,
│                                 #   guardado protegido (FR-032)
├── admin/                        # Panel web (contracts/admin-panel.md)
│   ├── auth/                     # Login, sesión, CSRF
│   ├── routes/                   # Una ruta por sección
│   ├── views/                    # Plantillas Eta (layout, formularios, lista de avisos)
│   └── form-errors.ts            # ZodError → errores por campo
├── cli/
│   ├── snapshot.ts               # pnpm kb:snapshot
│   └── hash-password.ts          # pnpm operator:hash-password
├── app.ts                        # Construcción de la app Fastify
└── server.ts                     # Arranque

tests/
├── unit/                         # schemas, time, warnings, snapshot builder
├── contract/                     # rutas del panel (fastify.inject), forma del snapshot
├── integration/                  # Postgres real: FR-032, cascadas, activación, frescura
└── fixtures/                     # Negocios de ejemplo de tres sectores (SC-005)
```

**Structure Decision**: proyecto único. El dominio (`src/knowledge`) no depende de HTTP, así
que las specs siguientes (conversación por WhatsApp, disponibilidad, citas) se añadirán como
módulos hermanos (`src/conversation`, `src/scheduling`…) que consumen `KnowledgeReader` sin
tocar el panel. No hay frontend separado: el panel se renderiza en servidor.

## Complexity Tracking

Sin violaciones de la constitución que justificar.
