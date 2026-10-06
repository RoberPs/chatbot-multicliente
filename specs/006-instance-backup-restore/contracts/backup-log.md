# Contrato: registros técnicos de copias

Catálogo cerrado en `src/backup/log.ts` (research R14). Mismo `LoggerLike` que el registro del bot,
con `channel: 'backup'`. Ningún evento tiene campos de texto libre (FR-024): nada de rutas
completas, mensajes de error de PostgreSQL, textos, teléfonos, nombres, la clave ni fragmentos del
volcado. El nombre del fichero sí se registra: solo lleva instancia, esquema, fecha y motivo.

| Evento | Nivel | Campos |
|--------|-------|--------|
| `backup_created` | info | `file`, `reason`, `sizeBytes`, `schema`, `durationMs`, `tables` (`{name, rows}[]`) |
| `backup_failed` | error | `reason`, `failure` (`key_missing` \| `key_invalid` \| `dir_missing` \| `dir_not_writable` \| `no_space` \| `busy` \| `db_error` \| `io_error`) |
| `backup_disabled` | warn | `missing` (`INSTANCE_ID` \| `BACKUP_DIR` \| `BACKUP_KEY`)[] — una vez al arrancar, solo fuera de `production` |
| `backup_retention_applied` | info | `deleted`, `kept`, `keptExpiredLatest` (bool: se conservó una caducada por ser la última válida) |
| `migration_blocked` | error | `pending` (etiquetas), `failure` (código de `backup_failed` o `backup_not_configured`) |
| `migration_failed` | error | `pending`, `premigrationFile` |
| `restore_completed` | warn | `file`, `sourceInstance`, `crossInstance` (bool), `schema`, `installedSchema`, `durationMs`, `tables`, `expiredConversations` |
| `restore_rejected` | warn | `file`, `failure` (código de restauración) |
| `verify_completed` | info | `file`, `restorable` (bool), `failure?`, `schema`, `durationMs` |

`restore_completed` es `warn` a propósito: una restauración cambia todos los datos de la instancia
y conviene que destaque al revisar los registros.

Prueba asociada: un test de integración ejecuta copia, restauración, comprobación, retención y
arranque bloqueado sobre una BD con datos de `tests/fixtures/` y comprueba que ningún registro
contiene nombres, teléfonos, textos de mensajes ni la clave de la fixture (SC-004).
