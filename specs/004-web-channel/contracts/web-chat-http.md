# Contrato: chat web público (HTTP)

**Feature**: `004-web-channel` | Fuente: FR-014 – FR-029 | Research: R3, R4, R5, R9, R10

Rutas públicas bajo `/chat`, registradas cuando hay bot (`ANTHROPIC_API_KEY`). Plugin
encapsulado de Fastify: el parser JSON solo existe aquí (el resto de la app sigue sin API
JSON), con `bodyLimit` de 8 KB.

## Recursos estáticos

### `GET /chat/widget.js`

- Siempre `200`, `text/javascript`, `Cache-Control: public, max-age=3600`. No depende de que el
  chat esté activado (el iframe decide).
- Comportamiento: añade al final del `<body>` un `<iframe src="{origen}/chat/frame"
  title="Chat con el asistente" allow="">`, fijo abajo a la derecha, tamaño cerrado
  (botón) por defecto. Escucha `message` **solo** de `{origen}` con `{type: "chat:resize",
  open: boolean}` para agrandarlo o encogerlo. No lee cookies ni el DOM de la web.
- El fragmento para el negocio (FR-016):

  ```html
  <script src="https://<instancia>/chat/widget.js" defer></script>
  ```

### `GET /chat/frame`

HTML de la interfaz del chat (Eta), con su JS y CSS propios servidos en
`/chat/assets/frame.js` y `/chat/assets/frame.css`.

| Situación | Respuesta |
|-----------|-----------|
| Chat activado | `200`, `Content-Security-Policy: … frame-ancestors <orígenes permitidos>`; vista del chat |
| `Referer` presente con origen no permitido | `200` con la vista "no disponible" y `frame-ancestors 'none'` (FR-027) |
| Chat desactivado, negocio no activo o sin bot | `200` con la vista "no disponible" y el contacto (FR-022) |

CSP del frame: `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self';
img-src 'self' data:; frame-ancestors …; base-uri 'none'; form-action 'none'; object-src
'none'`. Sin `X-Frame-Options` en `/chat/frame` (lo sustituye `frame-ancestors`); se mantiene
`DENY` en el resto de la app. `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.

La vista del chat muestra antes del primer mensaje el aviso fijo (FR-017, SC-005):

> Estás hablando con el asistente automático de **{nombre del negocio}**. Tus mensajes se
> usan para responderte y se borran a los 30 días. [Política de privacidad]({privacy_url})

## API JSON (`/chat/api/*`)

### Reglas comunes

- **Origen** (FR-027): se exige `Origin` igual al origen de la instancia en los `POST`, y se
  rechaza cualquier petición con `Sec-Fetch-Site` distinto de `same-origin` cuando la cabecera
  llega. Si no se cumple: `403 {"error":"forbidden"}`, sin guardar nada; evento
  `web_rejected{reason:"origin"}`.
- **Sesión**: todas salvo `POST /session` exigen `Authorization: Bearer <token>` con firma
  válida (R4); si no, `401 {"error":"session"}` y el iframe pide otra sesión.
- **Sin datos de la persona en URL**: el token nunca va en la URL ni en una cookie.
- **Respuestas**: `Content-Type: application/json`, `Cache-Control: no-store`.
- **No disponible** (`unavailable`): objeto común en las respuestas que lo necesiten:

  ```json
  { "reason": "disabled" | "not_active" | "quota" | "ip_limit" | "no_bot",
    "message": "Ahora mismo el chat no está disponible.",
    "contact": "Puedes contactar con {negocio} en … (texto de CONTACTO)" }
  ```

  `contact` es el bloque de contacto de la 002 si el snapshot se puede leer y tiene canales; si
  no, el contacto de emergencia de la instancia (FR-022). Es texto plano: el iframe lo pinta con
  `textContent`.

### `POST /chat/api/session`

Crea una sesión anónima (FR-018). Límite por IP: 20 por hora (FR-025).

| Caso | Respuesta |
|------|-----------|
| Chat disponible | `201 {"token":"<id>.<firma>"}`; evento `web_session_created` |
| Chat no disponible | `200 {"unavailable":{…}}`, sin token |
| Límite por IP superado | `429 {"unavailable":{"reason":"ip_limit",…}}` + `Retry-After`; `web_rejected{reason:"session_limit"}` |

### `GET /chat/api/state`

Estado para pintar el iframe al abrir. Sin efectos.

```json
{
  "available": true,
  "businessName": "…",
  "privacyUrl": "https://…",
  "contact": "…",              // siempre presente: se usa para la disculpa del iframe (FR-021)
  "maxLength": 1000,
  "unavailable": null           // o el objeto común
}
```

### `GET /chat/api/messages?after=<cursor>`

Mensajes de la conversación vigente del visitante (la más reciente con último entrante hace
menos de 24 h; si no hay, lista vacía).

```json
{
  "messages": [
    { "id": "…", "from": "visitor" | "bot", "text": "…", "at": "2026-09-25T10:00:00Z" }
  ],
  "cursor": "<opaco>",
  "waiting": true                // hay entrantes del visitante aún pendientes de respuesta
}
```

- Entrantes con estado `pending`, `answered` o `rate_limited`; salientes `sent`. Nunca
  `reply_trace`.
- `after` devuelve solo lo posterior al cursor; sin `after`, toda la conversación vigente.
- `text` es siempre texto plano, sin marcado. El iframe pinta los mensajes del visitante con
  `textContent` y los del bot con `ChatLinks.split` (R15): cada enlace `https://` válido es un
  `<a target="_blank" rel="noopener noreferrer nofollow">` creado con `createElement`, y el
  resto, nodos de texto (FR-020a).
- El iframe consulta cada 1,5 s mientras `waiting = true` (R5) y muestra "escribiendo…"
  (FR-021). Si pasan 45 s con `waiting = true`, muestra R-ERR con `contact` y deja de consultar.

### `POST /chat/api/messages`

```json
{ "clientMessageId": "<uuid v4>", "text": "¿Abrís el sábado?" }
```

Validación (Zod): `clientMessageId` UUID; `text` recortado, 1 – 1 000 caracteres (FR-020). Límite
por IP: 120 cada 15 min (FR-025).

| Caso | Respuesta | Guarda |
|------|-----------|--------|
| Aceptado (o repetido: mismo `clientMessageId`) | `202 {"accepted":true}` | entrante `pending` (una vez) |
| Texto vacío o demasiado largo | `400 {"error":"text","maxLength":1000}` | nada |
| Chat desactivado / negocio no activo | `200 {"accepted":false,"unavailable":{…}}` | nada; `message_discarded{reason:"disabled"\|"not_active"}` |
| Tope diario o mensual alcanzado | `200 {"accepted":false,"unavailable":{"reason":"quota",…}}` | nada; `message_discarded{reason:"quota"}` |
| Límite por visitante superado (FR-024) | `202 {"accepted":true}` | entrante `rate_limited`; R-LIMIT una vez por ventana, como saliente |
| Límite por IP superado | `429 {"unavailable":{"reason":"ip_limit",…}}` + `Retry-After` | nada |
| Snapshot ilegible | `503 {"unavailable":{"reason":"no_bot",…}}` con contacto de emergencia | nada |

El entrante se guarda con `sent_at = received_at = ahora` (hora del servidor) y
`channel_message_id = "web:<channel_user_id>:<clientMessageId>"` (FR-023).

## Garantías verificables (tests de contrato con `fastify.inject`)

1. Chat desactivado por defecto: `frame` sin chat, `POST /messages` no guarda (FR-014, US2-1).
2. `frame-ancestors` contiene exactamente los orígenes configurados (FR-015).
3. Petición con `Origin` ajeno o `Sec-Fetch-Site: cross-site` → `403` y cero filas nuevas
   (FR-027, SC-006).
4. Token con firma alterada → `401`.
5. Mismo `clientMessageId` dos veces → una sola fila (FR-023).
6. 21.ª sesión en una hora desde la misma IP → `429` con contacto (FR-025, SC-007).
7. Tope alcanzado → `accepted:false` con `quota` y ninguna llamada al modelo (SC-006).
8. Ningún registro contiene el token, el texto ni la IP (SC-008).
9. El texto con `<script>` se devuelve tal cual en JSON; un test estático falla si los
   scripts de `src/channels/web/assets/` usan `innerHTML`, `outerHTML`,
   `insertAdjacentHTML` o `document.write`, y el quickstart lo comprueba en el navegador. La
   única salida distinta de texto son los enlaces `https://` de las respuestas del bot (R15,
   FR-020a): una tabla de casos común comprueba que `links.js` y `message-links.ts` parten
   igual el texto y que `javascript:`, `data:`, `http://` y los enlaces del visitante nunca
   son enlaces.
