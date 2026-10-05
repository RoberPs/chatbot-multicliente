# Contrato: rutas públicas, base de datos y login

**Feature**: 012 · US3, US4 · FR-018 – FR-024 · research R9, R16. Amplía
[004 web-chat-http](../../004-web-channel/contracts/web-chat-http.md) y
[011 chat-design-http](../../011-chat-design/contracts/chat-design-http.md).

## Límites por dirección

Clave común `clientKey(request.ip)` para **todas** las rutas con límite (respeta `TRUST_PROXY`):

| IP | Clave |
|---|---|
| `203.0.113.7` | `203.0.113.7` |
| `::ffff:203.0.113.7` | `203.0.113.7` |
| `2001:db8:1:2:aaaa::1` | `2001:db8:1:2::/64` |
| `2001:0db8:0001:0002:ffff:…` | `2001:db8:1:2::/64` (normalizada) |

| Ruta | Límite | Al superarlo |
|---|---|---|
| `GET /chat/frame` | 60 / min | 429 `text/plain`, CSP de respaldo (sin incrustar), sin consultar la BD |
| `GET /chat/design.css` | 120 / min | 429 `text/plain`, sin consultar la BD |
| `GET /chat/design/:slot/:file` | 120 / min | 429 `text/plain`, sin consultar la BD |
| `/chat/api/*`, `/admin/login`, `/health`, `/handoff/*` | los actuales | sin cambios salvo la clave /64 |

Los rechazos del chat se registran como `web_rejected { reason: 'ip_limit' }`, sin la dirección.

## Imagen del diseño

`GET /chat/design/:slot/:file`:

1. Formato del nombre o hueco no válidos → 404 (sin BD).
2. `readDesignImageMeta(db, slot)` → `{ sha256, mimeType } | null` (sin los bytes).
3. Sin imagen, hash o extensión distintos → 404 `No encontrado` **sin leer los bytes**.
4. Coincide → se leen los bytes y se sirven con las cabeceras de la 011.

## Base de datos

| Pool | Usuarios | `max` | `statement_timeout` | Otros |
|---|---|---|---|---|
| Principal | panel, procesador, recepción, derivación, retención, copias programadas (lectura de zona) | 10 | 15 s | `connectionTimeoutMillis` 5 s; `idle_in_transaction_session_timeout` 60 s |
| Público | lecturas del chat web: frame, hoja y diseño, disponibilidad, historial y estado de la API | 3 | 5 s | `connectionTimeoutMillis` 2 s |
| Salud (009) | sondeo de `/health` | sin cambios | 2 s | — |

Migraciones, copias (`pg_dump`/restauración) y `db:verify` usan sus conexiones propias **sin**
`statement_timeout`. Agotado el pool público, el chat responde 503 `{ "error": "busy" }` (API) o la
vista «no disponible» con el último contacto conocido (frame), sin afectar al pool principal.

## Login del operador (`POST /admin/login`)

Orden de cada intento:

1. Límite por dirección: 5 / min (sin cambios salvo la clave /64) → 429 como hoy.
2. CSRF (sin cambios).
3. Retardo global: `min(5 000 ms, 250 ms × max(0, fallos_15min − 5))`, **salvo** cookie de
   navegador conocido válida.
4. Cola de verificación: 2 simultáneas; hasta 50 esperando; cola llena → 429 «Demasiados intentos.
   Inténtalo en unos segundos.» sin verificar y sin contar como fallo. Con cookie de navegador conocido: delante en la cola
   y nunca rechazado por cola llena.
5. Verificación Argon2id siempre + comparación del usuario en tiempo constante; error único
   «Usuario o contraseña incorrectos» (401).
6. Éxito: sesión (como hoy) y cookie `__Host-chatbot-device` (`Secure` en producción, `HttpOnly`,
   `SameSite=Strict`, `Path=/`, 90 días) con `v1.<caducidad>.<hmac>`; clave HKDF de
   `SESSION_SECRET` con la etiqueta `login-device`.

El contador global ya **no** devuelve 429 por sí mismo. `login_throttled` se registra cuando hay
retardo o cola (como mucho una vez por minuto), sin dirección ni usuario.
