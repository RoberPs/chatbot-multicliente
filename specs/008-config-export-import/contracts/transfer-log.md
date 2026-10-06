# Contrato: registro de exportaciones e importaciones

**Feature**: 008-config-export-import (FR-024)

Eventos del logger de la instancia con `channel: "config"`. Catálogo cerrado: ningún campo de texto
libre. Solo números, booleanos, códigos de este contrato y el `INSTANCE_ID` de origen validado con
`INSTANCE_ID_PATTERN` (o `null`). Nunca: nombres, preguntas, textos, teléfonos, correos, webs,
contenido del fichero ni su nombre.

`counts` = `{ business, openingHours, closures, services, resources, faqs, policies, tone,
handoff, webChat, alertDestinations }` con el número de elementos (0/1 en las filas únicas).
`changes` = por sección, `{ added, modified, removed }`.

| Evento | Nivel | Campos |
|--------|-------|--------|
| `config_exported` | info | `includesAlerts`, `counts` |
| `config_import_previewed` | info | `sourceInstance`, `formatVersion`, `sameInstance`, `counts`, `changes`, `outcome` (`will_apply` \| `blocked_critical` \| `blocked_web_chat`) |
| `config_import_applied` | info | `sourceInstance`, `formatVersion`, `includesAlerts`, `changes`, `criticalWarnings` (número, siempre 0 en activo), `warnings` (número) |
| `config_import_rejected` | warn | `stage` (`upload` \| `confirm`), `reason` (`too_large` \| `no_file` \| `unreadable` \| `not_export` \| `future_version` \| `unsupported_version` \| `invalid` \| `changed` \| `critical` \| `web_chat` \| `failed`), `issues` (número de errores, con `invalid`), `sourceInstance` (si se pudo leer) |
| `config_import_cancelled` | info | `reason` (`operator` \| `expired`), `sourceInstance` |

Un test de contrato captura los registros de todas las rutas y comprueba que no aparece ningún
valor de la configuración de prueba (nombres, teléfonos, correos, textos, webs).
