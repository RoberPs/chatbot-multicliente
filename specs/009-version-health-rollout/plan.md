# Implementation Plan: Versión visible y actualización escalonada

**Branch**: `009-version-health-rollout` | **Date**: 2026-10-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/009-version-health-rollout/spec.md`

**Ámbito**: Núcleo

## Summary

Cada instancia declara qué versión corre y en qué estado está; el operador lo ve en el panel, lo
consulta desde el inventario para todo el parque y sigue un procedimiento escrito para publicar por
tandas con vuelta atrás.

Enfoque técnico: tres piezas pequeñas sobre lo que ya existe, sin migraciones ni cambios en la
cadena de respuesta.

1. **Salud de la instancia** — módulo de dominio `src/health` (sin HTTP) que calcula el informe
   (estado, versión del núcleo, esquema aplicado y esperado, `INSTANCE_ID`) reutilizando
   `databaseSchema` / `installedSchema` de `src/backup/schema-version.ts`, y adaptador
   `GET /health` en `src/channels/health` con dos niveles: sin credencial solo `{status}`; con el
   secreto de salud (`HEALTH_SECRET`, cabecera `Authorization: Bearer`) el informe completo (R1,
   R2, R3). El mismo informe alimenta una línea fija en el pie del panel (R7).
2. **Versión del núcleo** — única fuente: el `version` de `package.json`, que ya viaja en la
   imagen; el `Dockerfile` exige un argumento `CORE_VERSION` igual a esa versión o la construcción
   falla, y lo graba en la etiqueta OCI `org.opencontainers.image.version`. La etiqueta `-t` la
   elige el operador: el procedimiento comprueba con `docker inspect` que coincide antes de
   desplegar (R4).
3. **Consulta desde el inventario** — nueva suborden `pnpm instance:versions` (módulo
   `src/provisioning/versions.ts`): lee el inventario, abre el entorno de cada instancia solo en
   memoria para obtener su `HEALTH_SECRET`, consulta `/health` en paralelo con tiempo límite, cruza
   identidad y versión anotada y pinta tabla o `--json`; solo con `--annotate` y confirmación
   escribe la versión observada en `imageVersion` (R5, R6, R8). El alta (`instance:new`) genera el
   secreto, `instance:check` lo exige y detecta repeticiones con las huellas existentes, y la nueva
   suborden `instance:health-secret` lo añade a las instancias anteriores sin mostrarlo (R2).
4. **Procedimiento** — se reescribe la sección 5 de `docs/operacion-multicliente.md` con etapas,
   comprobación, resultado esperado y criterio de continuar/parar ([contracts/release-procedure.md](contracts/release-procedure.md)).

Detalle de decisiones en [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.x (strict) sobre Node.js 22 LTS (heredado)

**Primary Dependencies**: las existentes — Fastify 5, `@fastify/rate-limit` (ya registrado con
`global: false`), Eta (pie del panel), `pg`, Zod, `node:crypto` (comparación en tiempo
constante), `fetch`/`AbortSignal.timeout` nativos de Node 22 para la orden. **Sin dependencias
nuevas.**

**Storage**: PostgreSQL 16, una BD por instancia. **Sin migración**: la versión del esquema se lee de
`drizzle.__drizzle_migrations`, que ya existe. El inventario (JSON de la 007) no cambia de formato:
`imageVersion` ya existe y las huellas incorporan la variable nueva `HEALTH_SECRET` sin tocar el
esquema del fichero ([data-model.md](data-model.md)).

**Testing**: Vitest —
`unit` (informe: estados, esquema igual/más nuevo/desconocido/vacío, versión inválida; comparación
del secreto; extracción y comparación de versiones semánticas; clasificación de filas de la orden
(no responde, no válida, degradada, discrepancia, identidad cruzada, sin información, sin secreto,
URL no `https`); formato de tabla y `--json`; calidad y generación de `HEALTH_SECRET`; regla de
repetición en el entorno; script de comprobación de versión),
`contract` (`fastify.inject`: `/health` sin credencial, con credencial correcta, incorrecta,
sin secreto configurado, BD caída, esquema distinto, `not_ready`/`stopping`, solo campos acordados,
sin sesión ni CSRF, límite de peticiones, ausencia de datos prohibidos en el cuerpo y en los
registros; pie del panel con versión),
`integration` (Testcontainers: SC-004 con BD real parada y esquema adelantado/atrasado; orden
`instance:versions` contra servidores Fastify reales en puertos locales con inventario temporal:
tabla, caída, URL cruzada, instancia sin `/health`, `--annotate`; SC-002 con 10 instancias de las
que 3 no responden < 60 s; `/health` no escribe en la BD y no retrasa la atención).
Sin `eval`: la cadena de respuesta no cambia (FR-008).

**Target Platform**: servidor Linux (contenedor `node:22-slim`); la orden corre en el equipo del
operador (Windows/macOS/Linux).

**Project Type**: servicio web (monolito modular): módulo nuevo `src/health`, adaptador en
`src/channels/health`, añadidos pequeños en `src/admin` (pie del panel), `src/config/env.ts`,
`src/provisioning` y `src/cli/instance.ts`.

**Performance Goals**: `/health` < 100 ms con la BD sana (dos consultas de solo lectura; objetivo
de diseño, la prueba de integración exige p95 < 250 ms para no fallar por la variabilidad de CI);
tope de
2 s por consulta a la BD antes de declarar "degradado". `instance:versions`: 10 instancias en < 1
min aun con caídas (SC-002) — tiempo límite por instancia 5 s, concurrencia 8.

**Constraints**: respuesta limitada a los campos acordados en todos los estados (FR-002, SC-003);
solo lectura (FR-006); secreto propio por instancia y comparación sin fugas (FR-001b); la orden
atribuye una versión solo si el `instanceId` coincide (FR-014); `https` salvo `--allow-insecure`
(FR-015); sin secretos ni datos de clientes en ninguna salida (FR-014); el comportamiento del bot
no cambia (FR-008); nada de sectores ni clientes en `src/`; textos y comentarios en español.

**Scale/Scope**: decenas de instancias por operador; una consulta por instancia y ejecución.

No quedan incógnitas técnicas: las cifras que la spec delegaba al plan (códigos HTTP, tiempos,
límite de peticiones, formato de la versión, nombre de la orden) están en el research.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio / regla | Evaluación |
|---|---|
| I. Base común única | **Cumple.** Todo es genérico: versión, esquema, estado. Ningún nombre ni lógica de sector o cliente en `src/`; la orden trata las instancias como identificadores opacos del inventario. |
| II. Configuración antes que código | **Cumple.** `HEALTH_SECRET` es configuración por instancia (variable de entorno, como el resto de secretos); no hay cambios de código por cliente. No toca la configuración del negocio ⇒ **no sube `formatVersion`** ni añade actualizador (008). |
| III. Personalizaciones aisladas | **No aplica**: no se añaden puntos de extensión ni extensiones (P5 sigue fuera de alcance). |
| IV. Solo información registrada | **Cumple.** No cambia la cadena de respuesta ni lo que el bot afirma; el informe de salud no contiene datos del negocio. |
| V. Siempre hay salida a una persona | **Cumple.** Ningún flujo de conversación se toca; `/health` es de solo lectura y limitado en frecuencia, así que no retrasa la derivación (FR-006, edge case de consultas abusivas). |
| VI. El operador registra la información | **Cumple.** El secreto de salud solo da acceso al informe; no expone al negocio ningún medio de alterar su configuración. La orden es una herramienta del operador. |
| Aislamiento entre instancias | **Cumple.** El informe no contiene datos de conversaciones ni de configuración; el `HEALTH_SECRET` es distinto por instancia y `instance:check` rechaza repeticiones; la orden rechaza atribuir una versión si el `instanceId` no es el esperado (SC-007). |
| Flujo de desarrollo (convenciones) | Spec de núcleo declarada. Migraciones: ninguna. Dominio sin HTTP (`src/health` puro; la ruta vive en `src/channels/health`, igual que los enlaces de derivación). Textos en español. README y guía de operación (9.1/9.2, propuesta P6 hecha, secciones 2.2/2.4 —entorno e inventario— y 5) se actualizan al cerrar (FR-020); el formato del inventario no cambia. |
| Pruebas de IV y V | La feature no afecta a la conversación (FR-008): no hay prueba nueva de IV/V; se mantiene verde la suite existente, que las cubre. |

**Resultado: sin violaciones; Complexity Tracking vacío.**

**Re-evaluación tras el diseño (Phase 1)**: el diseño no añade dependencias, migraciones ni cambios
en los flujos del bot; la única superficie pública nueva es `GET /health` con nivel sin credencial
mínimo (`{status}`) y nivel completo protegido. Sin cambios en la evaluación.

## Project Structure

### Documentation (this feature)

```text
specs/009-version-health-rollout/
├── plan.md                              # Este fichero
├── research.md                          # Phase 0
├── data-model.md                        # Phase 1
├── quickstart.md                        # Phase 1
├── contracts/
│   ├── health-endpoint.md               # GET /health (dos niveles)
│   ├── instance-versions-command.md     # pnpm instance:versions
│   └── release-procedure.md             # contenido de la guía de publicación (sección 5)
└── tasks.md                             # Phase 2 (/speckit-tasks; no lo crea /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── health/                          # NUEVO — dominio, sin HTTP
│   ├── version.ts                   # versión del núcleo (package.json), validación semántica
│   ├── report.ts                    # buildHealthReport(): estado + versiones; solo lectura
│   ├── secret.ts                    # verifyHealthSecret(): comparación en tiempo constante
│   └── lifecycle.ts                 # estado de ciclo de vida: starting | ready | stopping
├── channels/
│   └── health/
│       └── routes.ts                # NUEVO — GET /health, dos niveles, límite de peticiones
├── admin/
│   ├── render.ts                    # layout.version (informe del panel)
│   └── views/layout.eta             # línea fija «Núcleo x.y.z · Esquema 000N_…»
├── config/env.ts                    # HEALTH_SECRET (opcional) + regla de no reutilización
├── app.ts                           # registra la ruta; decora el ciclo de vida
├── startup.ts                       # marca ready tras arrancar y stopping al parar
├── provisioning/
│   ├── versions.ts                  # NUEVO — consulta, clasificación, tabla/JSON, anotación
│   ├── secrets.ts                   # calidad y generación de HEALTH_SECRET
│   ├── fingerprint.ts               # HEALTH_SECRET entre las huellas de secretos (hex)
│   ├── generate.ts                  # instance:new genera HEALTH_SECRET
│   └── check.ts                     # instance:check lo exige y detecta repeticiones
└── cli/instance.ts                  # subórdenes `versions` y `health-secret`

scripts/
└── check-version.mjs                # NUEVO — CORE_VERSION == package.json (usado por el Dockerfile)

Dockerfile                           # ARG CORE_VERSION + comprobación en la etapa de build
.env.example                         # HEALTH_SECRET documentada
package.json                         # scripts instance:versions e instance:health-secret

tests/
├── unit/health/ · unit/provisioning/versions.test.ts · unit/scripts/check-version.test.ts
├── contract/health.test.ts · contract/admin/version-footer.test.ts
└── integration/health/ · integration/provisioning/cli-versions.test.ts · cli-health-secret.test.ts

docs/operacion-multicliente.md       # sección 5 (procedimiento), 2.2/2.4, 9.1/9.2, P6 hecha
README.md                            # estado de la feature 009 y nueva orden
```

**Structure Decision**: monolito modular existente. El dominio nuevo (`src/health`) no depende de
HTTP; el adaptador HTTP vive en `src/channels/health` (precedente: `src/channels/handoff-links`) y la
herramienta del operador en `src/provisioning` + `src/cli`, junto a las demás órdenes `instance:*`.
No se toca `src/knowledge`, `src/conversation` ni `src/webchat`.

## Complexity Tracking

> Sin violaciones de la constitución que justificar.
