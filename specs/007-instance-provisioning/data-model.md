# Data Model: Aprovisionamiento de instancias

**Feature**: `007-instance-provisioning` | **Plan**: [plan.md](plan.md) | **Research**: [research.md](research.md)

Esta feature **no cambia el esquema de la base de datos** de las instancias ni añade migraciones.
Sus datos viven en el equipo del operador: el inventario (un fichero JSON) y los ficheros de
entorno de cada instancia. Formato exacto del inventario en
[contracts/inventory-format.md](contracts/inventory-format.md).

---

## Fichero de entorno de instancia

Fichero `KEY=valor` con el formato de `.env.example`, leído con `util.parseEnv` (R7). Contiene
secretos en claro; vive fuera del repositorio, en el gestor de secretos del operador.

| Grupo | Variables | Origen en `instance:new` |
|---|---|---|
| Identidad | `INSTANCE_ID`, `PUBLIC_BASE_URL`, `NODE_ENV=production` | Datos del operador |
| Negocio | `DEFAULT_TIMEZONE`, `DEFAULT_PHONE_REGION`, `DEFAULT_CURRENCY`, `EMERGENCY_CONTACT_PHONE` | Datos del operador |
| Secretos generados | `SESSION_SECRET`, `BACKUP_KEY`, `OPERATOR_PASSWORD_HASH`, `WHATSAPP_VERIFY_TOKEN` (si WhatsApp) | `node:crypto` + Argon2id |
| Copias | `BACKUP_DIR` (por defecto `/var/lib/chatbot/backups`), `BACKUP_RETENTION_DAYS`, `BACKUP_DAILY_TIME` | Operador / plantilla |
| Base de datos | `DATABASE_URL` | **Pendiente** hasta `instance:db` |
| Terceros | `ANTHROPIC_API_KEY`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_GRAPH_VERSION`, `SMTP_URL`, `SMTP_FROM` | **Pendientes**, con `# PENDIENTE:` encima |
| Resto | `OPERATOR_USER`, `PORT`, `TRUST_PROXY`, `LLM_*`, `AUDIO_TRANSCRIPTION`, `STT_*`, `WHATSAPP_TEMPLATE_LANG`, `BACKUP_KEYS_PREVIOUS`, `BACKUP_VERIFY_URL`, y cualquier variable nueva de la plantilla | Valor por defecto de la plantilla |

**Reglas**: se escribe con `flag: 'wx'` y modo `0600`; `instance:db` solo reescribe la línea
`DATABASE_URL` (escritura atómica). Las herramientas nunca escriben ninguna otra variable de un
entorno existente.

---

## Datos mínimos de una instancia nueva

Entrada de `instance:new` (FR-010), validada antes de escribir nada (FR-014):

| Campo | Opción | Validación |
|---|---|---|
| Identificador | `--id` | `INSTANCE_ID_PATTERN` (1–40, minúsculas, cifras y guiones); no usado en el inventario, tampoco por instancias dadas de baja |
| Cliente | `--client` | Texto no vacío, ≤ 120 caracteres; **solo** va al inventario |
| URL pública | `--url` | `https://host[:puerto]` sin ruta; no `localhost`; no usada por otra instancia |
| Zona horaria | `--timezone` | `isValidTimezone` (IANA) |
| Región telefónica | `--region` | 2 letras (ISO 3166-1) |
| Moneda | `--currency` | 3 letras (ISO 4217) |
| Teléfono de emergencia | `--emergency-phone` | Válido con `libphonenumber-js` en la región; se guarda en E.164 |
| WhatsApp | `--whatsapp` | Indicador; añade `WHATSAPP_VERIFY_TOKEN` y los pendientes de WhatsApp |
| Directorio de copias | `--backup-dir` | Ruta absoluta POSIX; por defecto `/var/lib/chatbot/backups` |
| Ruta de salida | `--out` | No existe; fuera del repositorio o excluida por `git check-ignore`; por defecto `<dir. inventario>/envs/<id>.env` |

Si falta un dato obligatorio y hay terminal, se pregunta; sin terminal, `new` se rechaza (R7).

---

## Inventario

Un único fichero JSON (R6). Raíz:

| Campo | Tipo | Notas |
|---|---|---|
| `format` | `"chatbot-inventory"` | Identifica el fichero |
| `version` | `1` | Versión del formato |
| `keyCheck` | string (base64url, 22) | HMAC de una constante con la clave; comprueba la clave sin revelarla (R4) |
| `createdAt` | `YYYY-MM-DD` | |
| `instances` | `Instance[]` | Ordenadas por `id` |

**Reglas**: nunca contiene secretos, contraseñas ni direcciones de conexión con contraseña
(FR-027); nunca se sobrescribe si no se ha podido leer y validar (FR-031); toda escritura va bajo
bloqueo y por `rename` atómico.

### Instance

| Campo | Tipo | Notas |
|---|---|---|
| `id` | string | `INSTANCE_ID`; único en el inventario, para siempre |
| `client` | string | Nombre del cliente (solo aquí, nunca en el repositorio, FR-033) |
| `status` | `provisioning` \| `active` \| `testing` \| `retired` | Ver transiciones |
| `publicUrl` | string \| null | Origen `https://…` vigente |
| `imageVersion` | string \| null | Anotada a mano (`update --image`) |
| `llmWorkspace` | string \| null | Espacio de trabajo del proveedor del modelo (texto) |
| `backupKeyLocation` | string \| null | Dónde está guardada la `BACKUP_KEY` (texto descriptivo, nunca la clave) |
| `backupDir` | string \| null | `BACKUP_DIR` vigente |
| `database` | `DatabaseIdentity` \| null | Sin contraseña |
| `dates.provisioned` | `YYYY-MM-DD` | Alta (`new` o `register`) |
| `dates.retired` | `YYYY-MM-DD` \| null | Baja |
| `dates.dataDeleted` | `YYYY-MM-DD` \| null | Borrado de BD y copias, anotado por el operador |
| `lastVerification` | `Verification` \| null | Última verificación anotada |
| `lastSuccessfulVerificationAt` | ISO 8601 \| null | Última con `restorable` |
| `fingerprints` | `Fingerprint[]` | Vigentes y anteriores; nunca se borran |

### DatabaseIdentity

| Campo | Tipo | Notas |
|---|---|---|
| `host` | string | En minúsculas, tal como se escribe (sin resolver alias) |
| `port` | number | 5432 si la URL no lo indica |
| `name` | string | Nombre de la base de datos |
| `user` | string | Usuario propietario |

### Verification

| Campo | Tipo | Notas |
|---|---|---|
| `at` | ISO 8601 con desfase | Momento en que se anotó |
| `file` | string | Nombre del fichero de copia (sin ruta) |
| `result` | `"restorable"` \| código de fallo de la 006 | `wrong_key`, `corrupted`, `schema_newer`… |

### Huella

`Fingerprint` (R4):

| Campo | Tipo | Notas |
|---|---|---|
| `variable` | string | Variable de origen (`SESSION_SECRET`, `BACKUP_KEYS_PREVIOUS`, `DATABASE`, …) |
| `class` | `secret` \| `database` \| `database_user` \| `public_url` \| `backup_dir` \| `whatsapp_phone` | Ámbito de comparación |
| `value` | string (base64url, 22) | 16 bytes de HMAC-SHA256 |
| `current` | boolean | `false` si el valor fue sustituido (rotación) o es una clave anterior de copias |
| `since` | `YYYY-MM-DD` | Fecha en que se registró |

Variables huelladas y su clase:

| Variable del inventario | Valor normalizado | Clase | Coincidencia con otra instancia |
|---|---|---|---|
| `SESSION_SECRET` | hex en minúsculas | `secret` | Error |
| `BACKUP_KEY` | hex en minúsculas | `secret` | Error |
| `BACKUP_KEYS_PREVIOUS` | cada clave, hex en minúsculas (`current: false`) | `secret` | Error |
| `OPERATOR_PASSWORD_HASH` | el hash tal cual | `secret` | Error |
| `ANTHROPIC_API_KEY` | recortado | `secret` | Error |
| `WHATSAPP_ACCESS_TOKEN` | recortado | `secret` | Error |
| `WHATSAPP_APP_SECRET` | recortado | `secret` | Error |
| `WHATSAPP_VERIFY_TOKEN` | recortado | `secret` | Error |
| `STT_API_KEY` | recortado | `secret` | Error |
| `DATABASE_PASSWORD` | contraseña de `DATABASE_URL` | `secret` | Error |
| `SMTP_URL` | URL completa recortada | `secret` | **Advertencia** si la otra también es `SMTP_URL`; error con cualquier otra variable |
| `DATABASE` | `host:puerto/nombre` | `database` | Error |
| `DATABASE_USER` | `host:puerto/usuario` | `database_user` | Error |
| `PUBLIC_BASE_URL` | origen | `public_url` | Error |
| `WHATSAPP_PHONE_NUMBER_ID` | recortado | `whatsapp_phone` | Error |
| `BACKUP_DIR` | ruta sin barra final | `backup_dir` | **Advertencia** |

`INSTANCE_ID` no se huella: es el `id` en claro.

### Transiciones de estado

```text
            instance:new                 update --status active|testing
   (nada) ───────────────▶ provisioning ─────────────────────────────▶ active ◀──▶ testing
      │                                                                   │           │
      └── instance:register ──────────────────────────────▶ active|testing│           │
                                                                          ▼           ▼
                                                   instance:retire ───▶ retired (final)
```

- `provisioning`, `active` y `testing` pueden pasar a `retired`; `retired` es final.
- `update --data-deleted` solo en `retired`.
- `instance:db` solo en instancias con `database = null` y no `retired`.
- Una instancia `retired` sigue contando en todas las comparaciones (FR-029).

---

## Resultado de validación

Salida de `instance:check` (FR-001, FR-008). Formato exacto en
[contracts/check-result.md](contracts/check-result.md).

| Campo | Tipo | Notas |
|---|---|---|
| `ok` | boolean | `true` = apto (sin errores) |
| `instanceId` | string \| null | Del entorno, si es válido |
| `profile` | `production` \| `testing` | R2 |
| `compared` | boolean | `false` si no había inventario |
| `comparedWith` | number | Instancias comparadas (sin contar la propia) |
| `errors` | `Finding[]` | Impiden desplegar |
| `warnings` | `Finding[]` | Conviene revisarlas |

`Finding`: `code` (catálogo cerrado), `variable`, `message`, `action`, y en las coincidencias
`otherInstance`, `otherVariable` y `otherCurrent`. Nunca un valor.

---

## Creación de base de datos

Resultado interno de `instance:db` (R8):

| Campo | Tipo | Notas |
|---|---|---|
| `database` | `DatabaseIdentity` | Lo que se creó (o se creará, en `--print-sql`) |
| `steps` | `('role' \| 'database' \| 'revoke' \| 'probe')[]` | Pasos completados |
| `rolledBack` | `('role')[]` | Deshecho tras un fallo |
| `failure` | código \| null | `db_exists`, `role_exists`, `admin_connect_failed`, `permission_denied`, `step_failed`, `probe_failed` |

Si `steps` incluye `database` y hay `failure`, el informe dice que la base de datos existe vacía y
no se ha borrado, y da las órdenes para completarla o retirarla a mano.
