# Contrato: resultado de `instance:check`

**Feature**: `007-instance-provisioning` | FR-001 a FR-009, FR-026a

## Salida `--json`

Una sola línea JSON por la salida estándar. Código de salida **0** si `ok`, **1** si no, **2** si
el fichero de entorno no existe o no se puede leer, o los argumentos no son válidos (entonces no
hay JSON, solo el mensaje por la salida de errores).

```json
{
  "ok": false,
  "instanceId": "demo-02",
  "profile": "production",
  "compared": true,
  "comparedWith": 3,
  "errors": [
    {
      "code": "duplicate_secret",
      "variable": "SESSION_SECRET",
      "otherInstance": "demo-01",
      "otherVariable": "SESSION_SECRET",
      "otherCurrent": true,
      "message": "SESSION_SECRET es igual a SESSION_SECRET de la instancia demo-01.",
      "action": "Genera uno nuevo con openssl rand -hex 32."
    },
    {
      "code": "missing",
      "variable": "BACKUP_KEY",
      "message": "Falta BACKUP_KEY.",
      "action": "Genérala con openssl rand -hex 32 y guárdala en el gestor de secretos, fuera de BACKUP_DIR."
    }
  ],
  "warnings": [
    {
      "code": "pending_optional",
      "variable": "SMTP_URL",
      "message": "SMTP_URL y SMTP_FROM están vacías: no habrá avisos de derivación por email.",
      "action": "Complétalas si el negocio quiere avisos por email."
    }
  ]
}
```

Reglas: ninguna cadena contiene el valor de una variable secreta ni una URL con credenciales;
`otherInstance`, `otherVariable` y `otherCurrent` solo aparecen en las coincidencias; `variable`
puede ser `null` en los errores del inventario.

## Salida para personas

```text
Validación de demo-02 (perfil production, comparado con 3 instancias)

ERRORES (2)
  ✗ SESSION_SECRET: es igual a SESSION_SECRET de la instancia demo-01.
      → Genera uno nuevo con openssl rand -hex 32.
  ✗ BACKUP_KEY: falta.
      → Genérala con openssl rand -hex 32 y guárdala en el gestor de secretos, fuera de BACKUP_DIR.

ADVERTENCIAS (1)
  ! SMTP_URL: SMTP_URL y SMTP_FROM están vacías: no habrá avisos de derivación por email.
      → Complétalas si el negocio quiere avisos por email.

NO APTO para desplegar.
```

Sin errores termina con `APTO para desplegar.` (con o sin advertencias).

## Catálogo de códigos

### Errores

| Código | Cuándo | Requisito |
|---|---|---|
| `missing` | Falta una variable obligatoria en el perfil (incluidas `INSTANCE_ID`, `BACKUP_DIR`, `BACKUP_KEY`, `DATABASE_URL`, `OPERATOR_PASSWORD_HASH`, `SESSION_SECRET`, `PUBLIC_BASE_URL`, `EMERGENCY_CONTACT_PHONE` con bot) | FR-002 |
| `core_rule` | El esquema del arranque (`checkEnv` de `env.ts`) rechaza la variable; `message` es el del núcleo | FR-003 |
| `not_production` | `NODE_ENV` distinto de `production` (perfil `production`) | FR-002 |
| `public_url_not_https` | `PUBLIC_BASE_URL` sin `https` o con `localhost` (perfil `production`) | FR-003 |
| `whatsapp_incomplete` | Parte de las `WHATSAPP_*`; `variable` = cada una que falta | FR-003 |
| `smtp_incomplete` | `SMTP_URL` sin `SMTP_FROM` o al revés | FR-003 |
| `llm_key_required` | WhatsApp configurado sin `ANTHROPIC_API_KEY` | FR-003 |
| `trust_proxy_all` | `TRUST_PROXY=true` | FR-003 |
| `backup_key_equals_session` | `BACKUP_KEY` igual a `SESSION_SECRET` | FR-003 |
| `weak_secret` | Secreto vacío, de relleno, corto o no aleatorio según su tipo (R3) | FR-004 |
| `example_database` | `DATABASE_URL` es la de `.env.example` (usuario y contraseña `chatbot`) | FR-004 |
| `secret_reused_within` | Dos variables secretas del mismo entorno tienen el mismo valor | FR-005 |
| `duplicate_instance_id` | `INSTANCE_ID` de otra instancia del inventario | FR-005 |
| `duplicate_database` | Mismo servidor, puerto y nombre de BD que otra instancia | FR-005 |
| `duplicate_database_user` | Mismo usuario de BD (en el mismo servidor y puerto) que otra instancia | FR-005 |
| `duplicate_public_url` | Misma `PUBLIC_BASE_URL` que otra instancia | FR-005 |
| `duplicate_whatsapp_phone` | Mismo `WHATSAPP_PHONE_NUMBER_ID` que otra instancia | FR-005 |
| `duplicate_secret` | Un secreto igual a cualquier secreto (vigente o anterior) de otra instancia | FR-005 |
| `inventory_key_missing` | Hay inventario pero no `INSTANCE_INVENTORY_KEY` | FR-026a |
| `inventory_key_wrong` | La clave no es la del inventario | FR-026a |
| `inventory_unreadable` | El inventario existe pero no se puede leer o no es válido | caso límite |

Los códigos de coherencia específicos (`whatsapp_incomplete`, `smtp_incomplete`, …) sustituyen al
`core_rule` equivalente para dar una acción concreta; el resto de incidencias del núcleo sale como
`core_rule` con su mensaje original, de modo que una regla nueva del arranque aparece en la
validación sin tocar esta feature.

### Advertencias

| Código | Cuándo |
|---|---|
| `not_compared` | No hay inventario: solo se ha comprobado la coherencia |
| `not_registered` | El `INSTANCE_ID` no está en el inventario (se comparó igualmente) |
| `pending_optional` | Grupo opcional vacío: `ANTHROPIC_API_KEY` (instancia sin bot), `SMTP_*` (sin avisos por email), `WHATSAPP_*` (sin WhatsApp) |
| `shared_smtp` | `SMTP_URL` igual a la de otra instancia |
| `shared_backup_dir` | `BACKUP_DIR` igual al de otra instancia |
| `trust_proxy_empty` | `TRUST_PROXY` vacío en production (con `https` suele haber un proxy delante) |
| `database_superuser` | El usuario de `DATABASE_URL` es `postgres` |
| `database_localhost` | `DATABASE_URL` apunta a `localhost`/`127.0.0.1` en production |
| `llm_key_format` | `ANTHROPIC_API_KEY` no empieza por `sk-ant-` |
| `weak_argon2_params` | Hash Argon2id con parámetros por debajo de los mínimos OWASP |
| `retired_instance` | El entorno es de una instancia dada de baja |

### Perfil `testing`

Si el `INSTANCE_ID` está en el inventario con estado `testing`: `not_production`,
`public_url_not_https`, `trust_proxy_empty` y `database_localhost` no se aplican. Todo lo demás,
sí.

## Garantías

- `instance:check` **no escribe** el entorno ni el inventario (FR-009): los abre solo para leer y
  no toma el bloqueo de escritura (lee una versión completa gracias al `rename` atómico).
- La propia instancia (mismo `INSTANCE_ID`) no cuenta como coincidencia (US1-6).
