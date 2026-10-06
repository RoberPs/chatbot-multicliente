# Data Model: Exportar e importar la configuración del negocio

**Feature**: 008-config-export-import | **Fecha**: 2026-09-30

Una tabla nueva en la BD de la instancia (`config_pre_import`) y varias estructuras en memoria.
Las tablas de configuración existentes no cambian. Formato del fichero en
[contracts/config-file-format.md](contracts/config-file-format.md).

## 1. Documento de configuración (`ConfigDocument`, en memoria y en el fichero)

Forma del dominio de todo lo que se exporta (FR-002). Es a la vez lo que se serializa, lo que
devuelve la validación y lo que se compara en el diff.

| Sección | Origen en la BD | Clave de emparejamiento (diff) | Notas |
|---------|-----------------|--------------------------------|-------|
| `business` | `business` (sin `id`, `status`, `updated_at`) | fila única | `timezone` y `currency` incluidos |
| `openingHours` | `business_hours` | franjas por día | orden canónico día → inicio |
| `closures` | `closure` | `startDate`,`endDate`,`startTime`,`endTime` | `reason` es un campo |
| `services` | `service` | nombre normalizado | orden = `sort_order`; `priceCents`, `durationMinutes` |
| `resources` | `resource` + `resource_service` + `resource_hours` + `resource_absence` | nombre normalizado | `services` = nombres de servicio en el orden de los servicios |
| `faqs` | `faq` | pregunta normalizada (y orden entre repetidas) | orden = `sort_order` |
| `policies` | `policies` | fila única; `null` si no hay fila | minutos; `paymentMethods` en orden |
| `tone` | `tone` | fila única; `null` si no hay fila | |
| `handoff` | `handoff_contact` + `handoff_channel` + `handoff_hours` | medios por `type`+`value`; franjas por día | `null` si no hay contacto |
| `webChat` | `web_chat_settings` (sin `enabled`) | fila única | `allowedOrigins` normalizados |
| `alertDestinations` | `handoff_alerts` | fila única | **solo** si `includesAlertDestinations` |

Normalización de nombres y preguntas: `trim`, espacios internos colapsados y minúsculas
(`toLocaleLowerCase('es')`). Es la misma que se usa para las referencias recurso → servicio.

Excluido siempre (FR-004): `customer`, `conversation`, `message`, `handoff`, `handoff_notice`,
`web_usage_day`, `config_pre_import`, identificadores internos, `updated_at`, entorno y secretos.

## 2. Sobre del fichero (`ConfigFileEnvelope`)

| Campo | Tipo | Regla |
|-------|------|-------|
| `format` | `"business-config"` | obligatorio; otro valor → "no es una exportación" |
| `formatVersion` | entero ≥ 1 | `> CURRENT_FORMAT_VERSION` → rechazo `future_version`; no soportada → `unsupported_version` |
| `exportedAt` | ISO 8601 UTC | obligatorio |
| `source.instanceId` | `string \| null` | `INSTANCE_ID_PATTERN` o `null` |
| `source.schema` | `string` | etiqueta de migración (`0005_config_transfer`); solo informativa |
| `includesAlertDestinations` | booleano | `true` ⇔ existe `alertDestinations` |
| `info.businessStatus` | `"draft" \| "active"` | solo informativo; nunca se importa (FR-004) |
| `info.webChatEnabled` | booleano | solo informativo; nunca se importa |

## 3. Tabla nueva: `config_pre_import` (migración `0005_config_transfer`, solo añadir)

Configuración que tenía la instancia justo antes de la última importación aplicada (FR-022).

| Columna | Tipo | Restricción |
|---------|------|-------------|
| `id` | `smallint` PK, default 1 | `check (id = 1)`: una sola fila |
| `content` | `text` not null | fichero canónico (R1) **con** destinos de avisos |
| `imported_at` | `timestamptz` not null | hora de la importación a la que precede |
| `source_instance` | `text` null | `INSTANCE_ID` de origen del fichero importado |

- Se escribe solo dentro de la transacción de una importación aplicada
  (`INSERT … ON CONFLICT (id) DO UPDATE`); una importación rechazada revierte también esta
  escritura.
- No está en `allTableNames` (no participa en `max_updated_at`) ni en `conversationTableNames`.
- Entra en las copias de la 006 como cualquier tabla y se restaura con ellas.

## 4. Error de validación (`ImportIssue`)

| Campo | Tipo | Ejemplo |
|-------|------|---------|
| `section` | código de sección | `services` |
| `sectionLabel` | texto | `Servicios` |
| `item` | `string \| null` | `«Corte»` o `n.º 3`; `null` para el fichero o una fila única |
| `field` | `string \| null` | `priceCents` |
| `message` | texto en español | `El importe debe ser un número entero de céntimos, 0 o más` |

Rechazos antes de validar las secciones (un único `ImportIssue` con `section: 'file'`):
`too_large`, `unreadable` (no es JSON), `not_export` (sobre ausente o `format` distinto),
`future_version`, `unsupported_version`.

## 5. Vista previa (`ImportPreview`, en memoria; no se guarda)

| Campo | Contenido |
|-------|-----------|
| `pendingId` | identificador del fichero pendiente |
| `envelope` | metadatos del fichero (§2) |
| `sameInstance` | `true` / `false` / `null` (no se puede saber sin `INSTANCE_ID` en los dos) |
| `includeAlerts` | elección actual del operador (por defecto `false`) |
| `diff` | `SectionDiff[]` (§6) |
| `highlights` | `timezoneChanged`, `currencyChanged`, `alertDestinationsIncluded`, `webChat` (§6) |
| `warnings` | `Warning[]` de `computeWarnings` sobre el estado del ensayo (R6) |
| `outcome` | `will_apply` \| `blocked_critical` \| `blocked_web_chat` |
| `baseFingerprint` | huella de la configuración actual (R9) |

## 6. Diff (`SectionDiff`)

```text
SectionDiff {
  section, sectionLabel
  added:    Array<{ label }>
  modified: Array<{ label, fields: Array<{ field, fieldLabel, before, after }> }>
  removed:  Array<{ label }>
  reordered: boolean
}
WebChatHighlight { destinationEnabled, removedOrigins[], addedOrigins[], capsChanged }
```

`before` y `after` se guardan ya formateados para la vista (importes con la moneda, minutos en la
mayor unidad exacta como en el panel, franjas "lun 09:00–14:00"). Sin cambios en una sección →
no aparece; sin cambios en ninguna → "La configuración del fichero es igual a la actual" (SC-002).

## 7. Fichero pendiente (`PendingImport`, en memoria del proceso)

| Campo | Regla |
|-------|-------|
| `id` | 128 bits aleatorios en base64url |
| `epoch` | época de la sesión del operador; si cambia (salir, reinicio) la entrada no vale |
| `document` | `ConfigDocument` validado y actualizado a la versión actual |
| `envelope` | sobre del fichero |
| `createdAt` | caduca a los 30 min |
| `result` | tras aplicar: diff aplicado, avisos y hora; la entrada ya no admite otra confirmación |

Máximo 5 entradas; al añadir la sexta se descarta la más antigua (se registra como cancelada por
caducidad).

### Transiciones

```text
subida válida ──► pending ──(GET vista previa: ensayo)──► pending
                     │
                     ├─ confirmar ─► [huella distinta] ─► pending (409, nueva vista previa)
                     │            ├► [crítico en activo / chat web] ─► pending (409)
                     │            └► [aplicada] ─► applied (solo lectura del resultado)
                     ├─ cancelar ─► eliminada (config_import_cancelled: operator)
                     └─ 30 min / desplazada / época distinta ─► eliminada (… : expired)
subida inválida ──► no se crea entrada (config_import_rejected: stage upload)
```

## 8. Huella de la configuración (`configFingerprint`)

`sha256` (hex) del JSON canónico de `{ document con alertDestinations, businessStatus,
webChatEnabled }`, sin `exportedAt` ni `source`. Se calcula en la transacción de la vista previa y
de nuevo tras el bloqueo en la confirmación (R9).
