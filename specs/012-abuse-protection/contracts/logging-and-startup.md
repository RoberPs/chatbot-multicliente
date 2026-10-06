# Contrato: registros sin datos y arranque seguro

**Feature**: 012 · US8 · FR-032 – FR-035 · research R13, R14. Amplía
[007 check-result](../../007-instance-provisioning/contracts/check-result.md).

## Registros

- Serializador `err` del logger: `{ type, code?, statusCode? }`. Nunca `message`, `stack`, `cause`
  ni propiedades del error.
- `req.url` registrada: ruta + nombres de los parámetros de consulta, sin valores
  (`/webhooks/whatsapp?hub.mode&hub.verify_token&hub.challenge`); `/handoff/<token>` sigue como
  `/handoff/:token`.
- Eventos del bot: catálogo cerrado de `activity-log.ts` (data-model §3).
- Prueba estática: en `src/` ningún logger recibe `error.message`, `.stack` ni un error fuera de la
  clave `err`.

## Reglas de secretos (`src/config/secret-rules.ts`)

| Variable | Mínimo |
|---|---|
| `SESSION_SECRET`, `BACKUP_KEY`, `BACKUP_KEYS_PREVIOUS` (cada una), `HEALTH_SECRET` | 64 hex, > 8 caracteres distintos |
| `WHATSAPP_VERIFY_TOKEN` | 32 caracteres, 10 distintos |
| `WHATSAPP_APP_SECRET` | 32 |
| `WHATSAPP_ACCESS_TOKEN`, `ANTHROPIC_API_KEY` | 40 |
| `STT_API_KEY` | 20 |
| Contraseña de `DATABASE_URL`, contraseña de `SMTP_URL` | 16 |

| Regla | Cuándo |
|---|---|
| `too_short` | por debajo del mínimo de longitud o de variedad |
| `example_value` | igual a un valor de ejemplo de `.env.example` o de la documentación (p. ej. la contraseña `chatbot`) |
| `trivial` | relleno, un carácter repetido o una secuencia (reglas a–d de la 007) |
| `reused` | igual a otro secreto de la tabla (sin distinguir mayúsculas) |
| `health_secret_required` | falta `HEALTH_SECRET` |

## Arranque

| Entorno | Resultado |
|---|---|
| `production` con alguna incidencia | no arranca; `Configuración de la instancia no válida:` y una línea por incidencia `- <VARIABLE>: <regla en español>` sin el valor |
| `production` sin `BACKUP_*` o sin `HEALTH_SECRET` | no arranca; nombra la variable que falta |
| `development` / `test` con secretos débiles | arranca; `weak_secrets { findings: [{ variable, rule }] }` en el registro de arranque |

## `pnpm instance:check`

Usa `checkEnv` (que ya incluye estas reglas cuando el entorno es `production`) y deja de calcular la
calidad por su cuenta: mismas incidencias y mismo veredicto que el arranque para el mismo entorno
(FR-035; prueba de paridad sobre la batería de SC-010). Las comprobaciones propias de la 007 que no
son del arranque (inventario, huellas, comparación con otras instancias) no cambian.
