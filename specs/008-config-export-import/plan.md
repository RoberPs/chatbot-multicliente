# Implementation Plan: Exportar e importar la configuración del negocio

**Branch**: `008-config-export-import` | **Date**: 2026-09-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/008-config-export-import/spec.md`

**Ámbito**: Núcleo

## Summary

El operador exporta desde el panel la configuración del negocio a un fichero JSON legible y la
importa en otra instancia (o en la misma) con validación completa, vista previa de cambios y
aplicación todo o nada. La importación es un reemplazo completo que nunca cambia el estado del
negocio ni la activación del chat web; los destinos de los avisos de derivación solo viajan si el
operador los incluye al exportar y los elige al importar; y antes de aplicar se guarda la
configuración anterior para poder deshacer.

Enfoque técnico: módulo nuevo `src/config-transfer` sin HTTP y una página nueva del panel
`/admin/config`. El fichero es JSON canónico con sobre versionado (`formatVersion: 1`) y valores en
la forma del dominio; las relaciones recurso → servicio van por nombre (R1, R2). La validación es
un esquema Zod estricto que **reutiliza los primitivos del dominio** y devuelve todos los errores
con sección, elemento y motivo (R3, R4). La subida usa `@fastify/multipart` solo en esa ruta, con
límite de 5 MiB (R5). La vista previa es un **ensayo**: ejecuta el mismo reemplazo dentro de una
transacción que siempre se revierte y calcula el diff por secciones y los avisos con
`computeWarnings` (R6, R8). La confirmación usa la escritura protegida existente
(`runTrackedWrite`, FR-032), comprueba una huella SHA-256 de la configuración para detectar cambios
desde la vista previa, guarda la configuración anterior en la tabla nueva `config_pre_import` y
reemplaza conservando los UUID de servicios, recursos y preguntas emparejados (R7, R9, R11). Los
registros son un catálogo cerrado sin textos (R12). Detalle en [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript 5.x (strict) sobre Node.js 22 LTS (heredado)

**Primary Dependencies**: las existentes — Fastify 5, Eta + htmx, Drizzle ORM, Zod,
`libphonenumber-js`, `node:crypto` (huella SHA-256, identificadores). **Nueva**:
`@fastify/multipart` (plugin oficial de Fastify), registrado solo en `POST /admin/config/import`
(R5).

**Storage**: PostgreSQL 16, una BD por instancia. Migración `0005_config_transfer` (solo añadir):
tabla `config_pre_import` de una fila ([data-model.md](data-model.md) §3). Fichero pendiente en
memoria del proceso (R10).

**Testing**: Vitest — `unit` (esquema v1: cada regla y cada diferencia ◆ del contrato, campos
desconocidos, `format`/versión, BOM, JSON ilegible; traducción de errores a sección/elemento;
serialización canónica estable; diff por sección y destacados; huella; cobertura de columnas de
configuración (R4); almacén de pendientes con caducidad y época; catálogo del registro),
`contract` (`fastify.inject`: sesión y CSRF en todas las rutas; exportación con y sin destinos,
cabeceras y nombre; 400/413/422/404/409; vista previa sin cambios en la BD; confirmación,
cancelación y resultado; descarga de la configuración anterior; registros sin valores de la
configuración; navegación), `integration` (Testcontainers: SC-001 igualdad de snapshots entre dos
BD; SC-002; SC-003 con datos de clientes de todos los canales; SC-004; SC-005 con fallo inyectado a
mitad; FR-018 en activo; FR-019 concurrente; conservación de UUID emparejados; bot leyendo la
configuración importada en la respuesta siguiente; SC-007 con 200/50/200). Sin `eval`: la cadena
de respuesta no cambia y SC-001 se verifica con la igualdad del snapshot, que es la única fuente
de la respuesta (Principio IV).

**Target Platform**: servidor Linux (contenedor `node:22-slim`), panel en navegador de escritorio;
funciona sin JavaScript (htmx solo mejora la actualización de la vista previa).

**Project Type**: servicio web (monolito modular): módulo nuevo `src/config-transfer`, rutas y
vistas nuevas en `src/admin`, un añadido pequeño en `src/knowledge/services/guarded-write.ts`.

**Performance Goals**: SC-007 — vista previa y aplicación < 5 s cada una con 200 servicios,
50 recursos y 200 preguntas (objetivo interno < 1 s; R13). Exportación del mismo tamaño < 1 s.

**Constraints**: todo o nada en una transacción (FR-015); vista previa sin escrituras confirmadas
(FR-014); nunca importar `status` ni `enabled` (FR-017); destinos de avisos solo con doble
elección (FR-005, FR-021); ningún dato de clientes finales, uso ni secretos en el fichero (FR-004);
registros sin textos (FR-024); fichero ≤ 5 MiB y estricto (FR-010); mismas reglas que el panel
(FR-007); nada de sectores ni clientes en `src/` (FR-025); migraciones de solo añadir; sesión y
CSRF del panel (FR-023).

**Scale/Scope**: un operador por instancia; ficheros típicos de decenas de KB (máx. 5 MiB); hasta
~2 000 filas de configuración por importación.

Cifras que la spec delegaba al plan: formato JSON v1 y nombre del fichero (R1); caducidad del
pendiente 30 min y máximo 5 (R10); huella SHA-256 del documento canónico (R9). No quedan
incógnitas técnicas.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Evaluación inicial (antes de Phase 0)

| Principio | Cumplimiento en esta feature | Estado |
|-----------|------------------------------|--------|
| **I. Base común única** | Spec de núcleo. El formato y el código son iguales para cualquier negocio (FR-025): secciones genéricas, sin nombres ni ramas por sector. Los ficheros de ejemplo solo en `tests/fixtures/`. El test de neutralidad recorre `src/config-transfer` y las vistas nuevas. | ✅ |
| **II. Configuración antes que código** | Refuerza el principio: la configuración de un negocio pasa a ser un artefacto portable entre instancias sin tocar código ni desplegar. | ✅ |
| **III. Personalizaciones aisladas** | Sin extensiones ni puntos de extensión. | ✅ (N/A) |
| **IV. Solo información registrada** | La cadena de respuesta no cambia: el bot sigue leyendo el snapshot sin caché, que tras importar refleja exactamente lo importado. Lo importado pasa las mismas reglas del dominio que lo registrado a mano (FR-007). | ✅ |
| **V. Siempre hay salida a una persona** | La importación pasa por la escritura protegida: en un negocio activo se rechaza si quedaría con un aviso crítico (`HANDOFF_UNREACHABLE`) (FR-018); la vista previa lo anticipa. Las derivaciones en curso no se tocan. | ✅ |
| **VI. El operador registra la información** | Función exclusiva del panel del operador, con su sesión y CSRF (FR-023); el negocio no tiene acceso. Importar es una forma más de que el operador registre la información, con validación y vista previa. | ✅ |
| Restricción: aislamiento | Solo viaja la configuración del negocio, por decisión del operador; nunca conversaciones, clientes, uso ni secretos (FR-004); los destinos internos de avisos solo con doble elección. No hay conexión entre instancias: el fichero lo mueve el operador. | ✅ |
| Flujo: pruebas de IV y V | No cambia la conversación; se añaden tests de que la importación no deja un negocio activo sin salida a una persona y de que el bot usa lo importado. | ✅ |

**Resultado**: sin violaciones. Se puede continuar con Phase 0.

### Re-evaluación tras el diseño (Phase 1)

Revisados [data-model.md](data-model.md) y [contracts/](contracts/):

- **I**: el contrato del formato usa secciones y ejemplos genéricos ("Negocio de ejemplo",
  "Servicio A"); mensajes y códigos sin sectores. ✅
- **IV**: las tres diferencias con el formulario (◆ en
  [config-file-format.md](contracts/config-file-format.md)) son más estrictas o equivalentes
  (duplicados rechazados, céntimos enteros) salvo el nombre vacío, que es el valor inicial que ya
  admite la BD y no introduce ningún dato inventado. ✅
- **V**: la regla de avisos críticos se evalúa dos veces (ensayo y confirmación) con el mismo
  `computeWarnings`; la confirmación se rechaza igual que cualquier guardado del panel. ✅
- **VI / aislamiento**: rutas bajo `requireOperator` + `csrfOnPost`; multipart limitado a una
  ruta; registros sin datos ([transfer-log.md](contracts/transfer-log.md)); la configuración
  anterior guardada vive en la BD de la propia instancia y viaja solo en sus copias cifradas. ✅

**Resultado**: sin violaciones. Complexity Tracking vacío.

**Consecuencias que conviene conocer** (no son violaciones):

- **Dependencia nueva** `@fastify/multipart` (R5), limitada a la ruta de subida.
- **Toda spec futura que añada configuración** debe subir `formatVersion` y añadir su
  actualizador (R4); lo vigila el test de cobertura de columnas. Conviene recogerlo en la guía.
- La vista previa toma el bloqueo del negocio durante el ensayo (< 1 s): un guardado del panel
  simultáneo espera ese tiempo. El bot no se ve afectado.
- La configuración anterior guardada contiene los destinos de avisos (un teléfono o correo del
  negocio): está en la BD de la instancia como `handoff_alerts` y en sus copias cifradas.
- Un reinicio entre la vista previa y la confirmación obliga a subir el fichero otra vez (R10).
- Los datos antiguos que ya no cumplan una regla actual se exportan tal cual y la importación los
  señalará como errores; se corrigen en el fichero o en el panel de origen.
- `README.md` y `docs/operacion-multicliente.md` (§1 "Para qué sirve tu localhost", §2.6
  configuración del negocio en producción, §9.1 con fecha, §9.2 y P2 marcada como hecha) se
  actualizan al cerrar la feature; se avisará al usuario antes de cambiar el README, como indica
  `CLAUDE.md`.

## Project Structure

### Documentation (this feature)

```text
specs/008-config-export-import/
├── plan.md              # Este fichero
├── research.md          # Phase 0: decisiones técnicas (R1–R13)
├── data-model.md        # Phase 1: documento, sobre, config_pre_import, vista previa, pendiente
├── quickstart.md        # Phase 1: guía de validación de extremo a extremo
├── contracts/
│   ├── config-file-format.md    # Formato del fichero v1 y reglas
│   ├── admin-config-transfer.md # Rutas y páginas /admin/config
│   └── transfer-log.md          # Eventos config_* del registro
├── checklists/
└── tasks.md             # Phase 2 (/speckit-tasks; no lo crea este comando)
```

### Source Code (repository root)

```text
src/
├── config-transfer/               # NUEVO módulo (sin HTTP)
│   ├── format.ts                  # tipos ConfigDocument/sobre, secciones y etiquetas, versión actual
│   ├── schema.ts                  # esquema Zod estricto v1 con los primitivos del dominio
│   ├── parse.ts                   # bytes → BOM, JSON, sobre, versión, actualizadores, validación → ImportIssue[]
│   ├── read.ts                    # estado de la BD (+ chat web y destinos) → ConfigDocument
│   ├── canonical.ts               # serialización canónica, nombre del fichero y huella (R9)
│   ├── diff.ts                    # diffConfig y destacados (R8), valores formateados para la vista
│   ├── replace.ts                 # replaceConfig(tx, doc, { importAlerts }) (R7)
│   ├── service.ts                 # exportConfig, previewImport (ensayo), applyImport, preImportCopy
│   ├── pending.ts                 # PendingImports en memoria (R10)
│   ├── errors.ts                  # ConfigChangedError, WebChatWouldBreakError, ImportRejected
│   └── log.ts                     # catálogo de eventos config_* (R12)
├── knowledge/services/guarded-write.ts  # + previewWrite(db, fn, opts): ensayo con ROLLBACK (R6)
├── knowledge/schemas/*, webchat/schemas.ts, handoff/schemas.ts
│                                  # extraer esquemas de campo reutilizables, sin cambiar el panel (R3)
├── db/schema.ts                   # + tabla configPreImport
├── db/migrations/0005_config_transfer.sql (+ meta)   # solo añadir
└── admin/
    ├── routes/config.ts           # /admin/config, export, import (multipart), vista previa, apply,
    │                              #   cancel, result, pre-import
    ├── routes/index.ts            # registrar configRoutes
    └── views/
        ├── config/index.eta       # exportar, importar, configuración anterior, errores de fichero
        ├── config/preview.eta     # metadatos, destacados, cambios, avisos, confirmar/cancelar
        ├── config/result.eta      # cambios aplicados, avisos, descarga de la anterior
        ├── partials/config-diff.eta, partials/import-issues.eta
        └── layout.eta             # + entrada "Exportar e importar"

tests/
├── unit/config-transfer/          # schema, parse, canonical, diff, pending, log, column-coverage
├── contract/admin/config.test.ts  # rutas, sesión, CSRF, códigos, registros sin datos
├── integration/config-transfer/   # round-trip (SC-001/002), privacy (SC-003), status (SC-004),
│                                  #   rollback (SC-005), critical, concurrent, ids, bot, perf (SC-007)
├── fixtures/config/               # ficheros de ejemplo válidos e inválidos (genéricos)
├── helpers/config-transfer.ts     # negocio completo de prueba, huella de tablas de configuración
└── unit/sector-neutrality.test.ts # el recorrido incluye src/config-transfer

package.json                       # + @fastify/multipart
docs/operacion-multicliente.md     # §1, §2.6, §9 (P2 hecha)
README.md                          # estado de la 008 (se avisa antes de cambiarlo)
```

**Structure Decision**: proyecto único, como las features anteriores. `src/config-transfer` es un
módulo de dominio sin HTTP, hermano de `src/backup` y `src/provisioning`: lee y escribe la BD con
los repositorios y la escritura protegida de `src/knowledge`, y usa `webchat/settings` y
`handoff/settings` para sus filas únicas. Las piezas de reglas (`schema`, `parse`, `diff`,
`canonical`) son puras y se prueban sin BD. `src/admin/routes/config.ts` solo compone sesión, subida,
almacén de pendientes, servicio y vistas; el plugin multipart se registra en un contexto
encapsulado con esa única ruta para que el resto del panel siga aceptando solo formularios
urlencoded de 256 KiB.

## Complexity Tracking

Sin violaciones de la constitución que justificar.
