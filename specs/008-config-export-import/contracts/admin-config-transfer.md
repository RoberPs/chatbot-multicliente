# Contrato: páginas "Exportar e importar" del panel

**Feature**: 008-config-export-import

Todas bajo `/admin`, con sesión de operador (`requireOperator`: sin sesión, 302 al login o 401 +
`HX-Redirect` con htmx) y token CSRF en todo `POST` (`_csrf` en el cuerpo o `x-csrf-token`), igual
que el resto del panel (FR-023). Respuestas con `Cache-Control: no-store` y las cabeceras de
seguridad comunes. Nueva entrada de navegación: **Exportar e importar** → `/admin/config`.

## `GET /admin/config`

Página con tres bloques:

1. **Exportar**: formulario `POST /admin/config/export` con la casilla
   `include_alerts` ("Incluir los destinos de los avisos de derivación", desmarcada) y el texto
   "El fichero no incluye conversaciones, clientes ni secretos de la instancia".
2. **Importar**: formulario `POST /admin/config/import` (`multipart/form-data`) con un campo
   `file` (`accept=".json,application/json"`) y el tamaño máximo (5 MB).
3. **Configuración anterior a la última importación**: si existe, fecha, instancia de origen del
   fichero importado y enlace de descarga a `GET /admin/config/pre-import`; si no, "Todavía no se
   ha aplicado ninguna importación".

## `POST /admin/config/export`

| Entrada | `include_alerts` (casilla, opcional) |
|---------|--------------------------------------|
| 200 | `application/json; charset=utf-8`, `Content-Disposition: attachment; filename="configuracion-<id>-<AAAAMMDD-HHMM>.json"`, cuerpo según [config-file-format.md](config-file-format.md). Se permite con el negocio en preparación o con avisos críticos (US1-4). Registra `config_exported`. |

## `POST /admin/config/import`

| Entrada | `file` (un fichero), `_csrf` |
|---------|------------------------------|
| 303 | Fichero válido → `Location: /admin/config/import/<pendingId>` |
| 413 | Más de 5 MiB → página `/admin/config` con "El fichero supera el tamaño máximo de 5 MB" sin analizarlo |
| 422 | Ilegible, no es una exportación, versión futura o no soportada, o errores de validación → página `/admin/config` con la **lista completa** de errores agrupada por sección (sección, elemento, campo, motivo) (FR-008) |
| 400 | Sin fichero → "Elige un fichero exportado desde el panel" |

Nunca modifica nada. Registra `config_import_rejected` (stage `upload`) en los rechazos.

## `GET /admin/config/import/:id[?alerts=1]`

Vista previa (R6): ensayo con reversión, nunca modifica nada (FR-014). Contenido:

- Metadatos del fichero: instancia y esquema de origen, fecha de exportación, "exportado de esta
  misma instancia" si procede.
- Destacados: cambio de zona horaria o de moneda; si el chat web del destino está activado,
  webs que dejarán de poder usar el chat y cambios de topes (FR-011).
- Si el fichero trae destinos de avisos: aviso "La instancia enviará los avisos de derivación a
  estos destinos" y la casilla `include_alerts` (desmarcada salvo `?alerts=1`); cambiarla vuelve a
  pedir la vista previa (htmx `hx-get` con `hx-trigger="change"`, o botón "Actualizar vista
  previa" sin JS) (FR-013).
- Cambios por sección: añadidos, modificados (campo: actual → nuevo) y eliminados, y "orden
  cambiado"; o "La configuración del fichero es igual a la actual".
- Avisos que tendría el negocio (críticos destacados) y el resultado previsto: "Se aplicará" o
  "Se rechazará: …" con los avisos o la condición del chat web que lo impiden (FR-012).
- Formulario de confirmación `POST /admin/config/import/:id/apply` con `base` (huella, oculto),
  `include_alerts` y `_csrf`; botón deshabilitado si el resultado previsto es rechazo.
- Formulario `POST /admin/config/import/:id/cancel`.

| 200 | vista previa |
| 404 | pendiente inexistente, caducado o de otra sesión → "La importación ha caducado; vuelve a subir el fichero" con enlace a `/admin/config` |

Registra `config_import_previewed` la primera vez que se muestra cada pendiente.

## `POST /admin/config/import/:id/apply`

| Entrada | `base`, `include_alerts`, `_csrf` |
|---------|-----------------------------------|
| 303 | Aplicada → `Location: /admin/config/import/<id>/result` |
| 409 | Configuración cambiada desde la vista previa (FR-019) → vista previa nueva con "La configuración ha cambiado desde la vista previa; revisa los cambios y vuelve a confirmar" |
| 409 | Negocio activo con avisos críticos (FR-018) o chat web activado sin webs o sin enlace → vista previa con el motivo; nada aplicado |
| 404 | pendiente inexistente o ya aplicado |

Registra `config_import_applied` o `config_import_rejected` (stage `confirm`).

## `GET /admin/config/import/:id/result`

Resultado (FR-020): cambios aplicados por sección, avisos vigentes y enlace para descargar la
configuración anterior (FR-022) con la fecha de la importación. 404 si no hay resultado.

## `POST /admin/config/import/:id/cancel`

Descarta el pendiente, registra `config_import_cancelled` (`operator`) y redirige (303) a
`/admin/config` con el aviso "Importación cancelada; no se ha cambiado nada".

## `GET /admin/config/pre-import`

| 200 | `application/json`, `Content-Disposition: attachment; filename="configuracion-anterior-<AAAAMMDD-HHMM>.json"`; el contenido guardado tal cual (incluye destinos de avisos). |
| 404 | no hay copia |
