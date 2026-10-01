# Contrato: `GET /health`

Endpoint de salud de cada instancia (FR-001 – FR-006). Lo consumen un monitor o balanceador (nivel
público) y la orden `pnpm instance:versions` y el operador (nivel completo). Decisiones en
[research.md](../research.md) R1 – R3 y R8.

## Petición

```http
GET /health HTTP/1.1
Authorization: Bearer <HEALTH_SECRET>     # opcional
```

- Sin sesión del panel ni CSRF; no pertenece a `/admin`.
- Solo `GET` (y `HEAD` implícito). No acepta cuerpo ni parámetros de consulta; el secreto **nunca**
  va en la URL.
- Límite: 30 peticiones por minuto y por IP (respeta `TRUST_PROXY`). Superado: `429`. Un monitor o
  balanceador debe sondear cada **10 s o más**: con intervalos de 2 s o menos agota el límite y la
  instancia parecería caída. Si varios monitores salen por la misma IP, el intervalo se reparte.
- Es de **solo lectura**: no escribe en la BD ni cambia ningún estado.

## Respuestas

Todas con `Content-Type: application/json; charset=utf-8` y `Cache-Control: no-store`, más las
cabeceras de seguridad que ya añade la aplicación.

### Nivel sin credencial (sin cabecera `Authorization`)

| Estado | Código | Cuerpo |
|---|---|---|
| Correcto | `200` | `{"status":"ok"}` |
| Degradado | `503` | `{"status":"degraded"}` |
| No listo | `503` | `{"status":"not_ready"}` |

Nada más: sin versiones, sin `instanceId`, sin detalle del fallo (escenario 3 de la US1).

### Nivel completo (cabecera correcta)

```json
{
  "status": "ok",
  "instanceId": "cliente-x",
  "coreVersion": "1.4.0",
  "schema": {
    "applied": { "index": 5, "tag": "0005_config_transfer" },
    "expected": { "index": 5, "tag": "0005_config_transfer" }
  }
}
```

| Campo | Tipo | Reglas |
|---|---|---|
| `status` | `"ok"` \| `"degraded"` \| `"not_ready"` | `ok` ⇒ código 200; los otros ⇒ 503 |
| `instanceId` | texto \| `null` | `INSTANCE_ID` de la instancia; `null` si no está configurado |
| `coreVersion` | texto | Versión semántica de `package.json` |
| `schema.expected` | `{ index, tag }` | Última migración del núcleo instalado |
| `schema.applied` | `{ index, tag \| null }` \| `null` | Última migración aplicada en la BD; `tag: null` si este núcleo no la conoce (esquema más nuevo); `null` entero si la BD no responde o está vacía; `null` también en `not_ready` (no se consulta) |

Con `degraded` se mantienen `coreVersion` y las versiones de esquema que se hayan podido leer;
nunca se añade la causa (escenarios 2 y 6 de la US1). Ejemplos:

```json
// BD caída
{"status":"degraded","instanceId":"cliente-x","coreVersion":"1.4.0",
 "schema":{"applied":null,"expected":{"index":5,"tag":"0005_config_transfer"}}}

// Esquema por delante del núcleo (tras volver a una imagen anterior sin restaurar)
{"status":"degraded","instanceId":"cliente-x","coreVersion":"1.3.0",
 "schema":{"applied":{"index":6,"tag":null},"expected":{"index":5,"tag":"0005_config_transfer"}}}
```

### Errores

| Situación | Código | Cuerpo / cabeceras |
|---|---|---|
| Credencial incorrecta (cabecera `Bearer` con valor distinto o mal formada), o cualquier credencial enviada a una instancia sin `HEALTH_SECRET` | `401` | `{"error":"unauthorized"}` + `WWW-Authenticate: Bearer` |
| Límite de peticiones | `429` | Cuerpo del plugin de límite; sin datos de la instancia |
| Error interno inesperado | `503` | `{"status":"degraded"}` (nunca el detalle) |

Una credencial enviada a una instancia **sin** `HEALTH_SECRET` da `401`, exactamente igual que una
incorrecta: así, quien no tiene el secreto no puede saber si la instancia lo tiene configurado
(FR-001b). Sin cabecera, la instancia sin secreto responde el nivel sin credencial como cualquier
otra.

## Garantías (comprobables)

1. **Campos cerrados**: el cuerpo contiene solo los campos de este contrato; un recorrido de las
   claves de todas las respuestas, en todos los estados y niveles, no encuentra nada más (SC-003).
2. **Sin datos prohibidos** (FR-002): conversaciones, teléfonos, nombres de negocio o cliente,
   configuración, secretos, variables de entorno, rutas, direcciones o credenciales de BD, ni
   mensajes de error. Tampoco aparecen en los registros: la ruta registra a nivel `warn` y el valor de
   `Authorization` ya se oculta.
3. **Comparación del secreto** en tiempo constante (SHA-256 de ambos + `timingSafeEqual`).
4. **Acotado en tiempo**: la consulta a la BD usa un pool propio de una conexión y un tope de 2 s;
   pasado ese tiempo, `degraded`. No compite con el pool del bot (FR-006).
5. **El código decide**: una herramienta externa distingue correcto / no correcto solo por el código
   (FR-003); y una credencial rechazada (401) se distingue de una caída (sin respuesta o 5xx).

## Pruebas asociadas

`tests/contract/health.test.ts` (todas las filas de las tablas, sin credencial / correcta /
incorrecta / sin secreto, BD caída, esquema distinto, `not_ready`, 429, campos cerrados, sin
sesión ni CSRF, registros sin secreto) · `tests/integration/health/` (BD real: SC-004, solo
lectura, no retrasa al bot).
