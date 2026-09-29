# Data Model: Copias de seguridad y restauración por instancia

**Feature**: `006-instance-backup-restore` | **Plan**: [plan.md](plan.md) | **Research**: [research.md](research.md)

Esta feature **no añade tablas ni migraciones**. Todo lo que describe vive fuera de la base de
datos de la instancia: en ficheros del directorio de copias y en variables de entorno. Guardarlo
en la BD haría que una restauración lo sobrescribiera con el estado de la copia (research R8, R10).

---

## Copia (`BackupFile`)

Fichero `CBAK` v1 en `BACKUP_DIR`. Formato byte a byte en
[contracts/backup-file-format.md](contracts/backup-file-format.md).

| Campo (cabecera) | Tipo | Regla |
|------------------|------|-------|
| `format` | `"cbak"` | fijo |
| `formatVersion` | `1` | los núcleos futuros MUST seguir leyendo la v1 |
| `instanceId` | string | igual a `INSTANCE_ID` al hacer la copia |
| `schema` | `{ index: int ≥ 0, tag: string, hash: string }` | última migración aplicada en la instantánea (R5) |
| `coreVersion` | string semver | `version` del `package.json` del núcleo que hizo la copia |
| `createdAt` | ISO 8601 UTC | instante de la instantánea |
| `reason` | `manual` \| `premigration` \| `daily` | FR-004 |
| `tables` | `{ schema, name, rows }[]` | recuento por tabla en la misma instantánea (R2) |
| `salt` | 16 bytes, base64 | aleatoria por fichero |
| `keyId` | 8 bytes, hex | identifica la clave sin revelarla (R3) |

Atributos derivados (no guardados):

- **Nombre**: `<instanceId>__<schema.index 4 dígitos>_<schema.tag>__<createdAt AAAAMMDDTHHMMSSZ>__<reason>.cbak`.
  Patrón que reconoce el núcleo:
  `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?__\d{4}_[a-z0-9_]+__\d{8}T\d{6}Z__(manual|premigration|daily)\.cbak$`.
- **Tamaño**: bytes del fichero.
- **Propia**: nombre con el patrón, cabecera legible y `instanceId === INSTANCE_ID`.
- **Válida**: propia y su primer bloque descifra con alguna clave configurada (cabecera
  autenticada).
- **Edad**: `now − createdAt` (de la cabecera; nunca del nombre ni de `mtime`).

Estados del fichero en disco:

```text
(no existe) ──crear──▶ .<nombre>.partial ──fsync + rename──▶ <nombre>.cbak ──retención──▶ (borrado)
                               │
                               └─fallo──▶ (borrado; si queda huérfano, lo borra la siguiente copia a la hora)
```

Un `.partial` nunca cumple el patrón: no se lista, no se restaura, no cuenta para la retención
(FR-006).

---

## Informe de copia (`BackupReport`)

Lo que imprime `pnpm db:backup` y registra `backup_created` (FR-007).

| Campo | Tipo |
|-------|------|
| `file` | nombre (sin ruta) |
| `sizeBytes` | int |
| `schema` | `index_tag` |
| `reason` | motivo |
| `createdAt` | ISO UTC |
| `tables` | `{ name, rows }[]` |
| `durationMs` | int |
| `retention` | `{ deleted: int, kept: int }` |

Sin textos, teléfonos ni nombres de personas; los nombres de tabla son del esquema del núcleo.

---

## Informe de restauración y de comprobación (`RestoreReport`, `VerifyReport`)

| Campo | Restauración | Comprobación | Notas |
|-------|:---:|:---:|-------|
| `restorable` | — | ✓ | `true` \| `false` |
| `failure` | ✓ si falla | ✓ si `false` | código cerrado, ver abajo |
| `file` | ✓ | ✓ | nombre sin ruta |
| `sourceInstance` | ✓ | ✓ | `instanceId` de la cabecera |
| `schema` | ✓ | ✓ | de la cabecera |
| `installedSchema` | ✓ | ✓ | del núcleo que ejecuta |
| `coreVersion` | ✓ | ✓ | de la cabecera |
| `createdAt` | ✓ | ✓ | de la cabecera |
| `tables` | ✓ restauradas | ✓ restauradas en la temporal | recuento real, comparado con la cabecera |
| `expiredConversations` | ✓ | ✓ | conversaciones que ya superan los 30 días sin mensajes (se borran al arrancar, R11) |
| `pendingMigrations` | ✓ | — | las que aplicará el siguiente arranque |

Códigos de fallo (`RestoreFailure`), comunes a restauración y comprobación:

| Código | Cuándo | Cambia la BD |
|--------|--------|:---:|
| `not_a_backup` | no empieza por la firma `CBAK` o la cabecera no es JSON válido | no |
| `unsupported_format` | `formatVersion` desconocida | no |
| `key_missing` / `key_invalid` | sin `BACKUP_KEY` o con formato no válido | no |
| `wrong_key` | ninguna clave configurada tiene el `keyId` de la cabecera | no |
| `corrupted` | un bloque no se autentica, falta el bloque final, sobran bytes o el volcado está mal formado | no |
| `other_instance` | `instanceId` distinto y sin `--from-instance` igual a él | no |
| `schema_newer` | índice de esquema mayor que el instalado (el informe dice el `coreVersion` de la copia) | no |
| `schema_mismatch` | mismo índice o anterior pero con otro hash | no |
| `instance_running` | el bloqueo de instancia en marcha está tomado (solo restauración) | no |
| `count_mismatch` | tras cargar, algún recuento no coincide con la cabecera | no (ROLLBACK) |
| `db_error` | error de PostgreSQL durante la carga | no (ROLLBACK) |
| `verify_db_unavailable` | no se pudo crear la BD temporal (solo comprobación) | no |

---

## Política de retención (`RetentionPolicy`)

| Campo | Origen | Regla |
|-------|--------|-------|
| `days` | `BACKUP_RETENTION_DAYS` | entero 1–30, por defecto 7; fuera de rango → error de configuración (FR-018) |
| `keepLatestValid` | fijo | siempre `true` (FR-019) |

Función pura `selectExpired(backups, now, days) → BackupFile[]`:

1. Considera solo copias **propias**.
2. Marca como caducadas las de edad > `days × 24 h`.
3. Quita de las caducadas la más reciente **válida** de todas las propias (aunque esté caducada).
4. Devuelve el resto de caducadas. Las `premigration` y `daily` siguen la misma regla (US4-4).

---

## Programación de la copia diaria (`DailySchedule`)

| Campo | Origen | Regla |
|-------|--------|-------|
| `time` | `BACKUP_DAILY_TIME` | `HH:MM` 24 h, por defecto `03:00` |
| `timezone` | `business.timezone` (BD) | IANA; se lee en cada pasada |

Función pura `dueDailyBackup({ now, timezone, time, dailyToday, failedOn }) → boolean`:

- `localDate`, `localTime` = `now` en `timezone`.
- `true` si `localTime ≥ time`, no hay copia `daily` propia con `createdAt` en `localDate`
  (`dailyToday = false`) y `failedOn ≠ localDate`.

Estado en memoria del programador: `failedOn: LocalDate | null` (se pierde al reiniciar a
propósito: un arranque tardío vuelve a intentarlo, FR-027). `failedOn` no se fija cuando el fallo
es `busy`.

---

## Configuración de copias

Variables de entorno nuevas (se validan con Zod en `src/config/env.ts`).

| Variable | Tipo | Por defecto | Obligatoria | Regla |
|----------|------|-------------|-------------|-------|
| `INSTANCE_ID` | slug | — | en `production` | `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`; distinto por instancia |
| `BACKUP_DIR` | ruta absoluta | — | en `production` | debe existir, ser directorio y escribible en cada copia (FR-025) |
| `BACKUP_KEY` | 64 hex | — | en `production` | 32 bytes aleatorios; distinta de `SESSION_SECRET`; rechazo si parece no aleatoria (misma regla que `SESSION_SECRET`) |
| `BACKUP_KEYS_PREVIOUS` | lista de 64 hex | vacía | no | solo lectura (R4) |
| `BACKUP_RETENTION_DAYS` | int | `7` | no | 1–30 |
| `BACKUP_DAILY_TIME` | `HH:MM` | `03:00` | no | hora local del negocio |
| `BACKUP_VERIFY_URL` | URL postgres | `DATABASE_URL` | no | servidor donde `db:verify` crea la BD temporal; usuario con `CREATEDB` |

`Env.backup` agrupa las cuatro primeras como `BackupConfig | null`: van juntas `INSTANCE_ID`,
`BACKUP_DIR` y `BACKUP_KEY`, o ninguna (como `WHATSAPP_*`); en `production`, ninguna es un error.

---

## Bloqueos consultivos

No son datos, pero forman parte del estado compartido entre procesos (R7).

| Clave (constante del núcleo) | Quién lo toma | Mientras |
|------------------------------|---------------|----------|
| `instance_running` | servidor (antes de migrar) · `db:restore` | vida del proceso · duración de la restauración |
| `backup_in_progress` | toda copia (`manual`, `premigration`, `daily`) | duración de la copia |

---

## Relación con datos existentes

- La copia incluye **todas** las tablas de `public` y la de migraciones de `drizzle`, también
  conversaciones, mensajes, clientes finales, derivaciones y configuración de canales. No se
  enumeran a mano: se leen del catálogo, así que una tabla nueva de una migración futura entra sola.
- `conversation` y derivadas: tras restaurar, las de más de 30 días sin mensajes se borran con el
  `purge()` existente antes de escuchar (R11); sus mensajes, derivaciones y avisos caen en cascada
  como hoy.
- `business.status`, `web_chat_settings.enabled`, `handoff_alerts`: se restauran tal cual; nada se
  activa ni desactiva (FR-013). Si el estado restaurado tiene avisos críticos con el núcleo
  instalado, el panel los muestra (`computeWarnings` sigue sin guardarse).
