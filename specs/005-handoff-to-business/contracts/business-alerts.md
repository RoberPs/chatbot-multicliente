# Contrato: avisos al negocio y sus respuestas

**Feature**: `005-handoff-to-business` | Research: R5–R10 | Data model: [data-model.md](../data-model.md)

Lo que recibe el negocio (WhatsApp y email), cómo contesta ("Le atiendo" / "Terminado") y qué
pasa si escribe otra cosa. Los textos son fijos y genéricos (FR-024): solo varían los datos del
cliente y de la derivación. El negocio siempre se trata de tú.

## Contenido común de un aviso

| Dato | Origen | Formato |
|------|--------|---------|
| Nombre | `conversation.contact_name` | una línea, ≤ 80 car. |
| Teléfono | `conversation.contact_phone` | `displayPhone` ("+34 611 22 23 33") |
| Canal | `customer.channel` | "WhatsApp" · "chat de la web" · "prueba del panel" |
| Tipo | `handoff.kind` | "quiere hablar con una persona" · "consulta sin resolver" · "queja o reclamación" |
| Motivo | `handoff.summary` | ≤ 300 car., una línea |
| Desde | `handoff.started_at` | hora local del negocio ("hoy a las 21:40", "ayer a las 18:05") |

## WhatsApp: plantillas (R6)

Categoría `UTILITY`, idioma `WHATSAPP_TEMPLATE_LANG` (por defecto `es`), sin cabecera ni pie,
cuerpo con variables posicionales y **dos botones `QUICK_REPLY`** en este orden: `Le atiendo`,
`Terminado`. `pnpm handoff:templates` imprime el JSON para `POST /{waba-id}/message_templates`.

### `derivacion_aviso`

```text
Nueva derivación del asistente: {{1}} ({{2}}), por {{3}}, {{4}}.
Motivo: {{5}}
Contacta con el cliente desde tu teléfono. Pulsa «Le atiendo» cuando lo hagas y «Terminado» cuando acabes; mientras tanto el asistente no le responde.
```

`{{1}}` nombre · `{{2}}` teléfono · `{{3}}` canal · `{{4}}` tipo · `{{5}}` motivo.

### `derivacion_recordatorio`

```text
Recordatorio: {{1}} ({{2}}) sigue esperando respuesta desde {{3}}.
Motivo: {{4}}
Le hemos dado tu contacto directo. Pulsa «Le atiendo» si ya le estás atendiendo o «Terminado» si ya acabaste.
```

### `derivacion_mensaje`

```text
Mensaje nuevo de {{1}} ({{2}}) durante la derivación:
«{{3}}»
Contéstale desde tu teléfono; el asistente no le responde mientras tanto.
```

`{{3}}`: los textos del lote separados por " / "; ≤ 700 car.; si se recorta, termina en
"… (mensaje recortado; el texto completo está en el email)" cuando la vía email está disponible,
o en "… (mensaje recortado)" si no.

### Envío (`src/channels/whatsapp/template-sender.ts`)

```json
{
  "messaging_product": "whatsapp",
  "to": "<whatsapp_phone sin +>",
  "type": "template",
  "template": {
    "name": "derivacion_aviso",
    "language": { "code": "es" },
    "components": [
      { "type": "body", "parameters": [{ "type": "text", "text": "…" }] },
      { "type": "button", "sub_type": "quick_reply", "index": "0",
        "parameters": [{ "type": "payload", "payload": "h1:attend:<token>" }] },
      { "type": "button", "sub_type": "quick_reply", "index": "1",
        "parameters": [{ "type": "payload", "payload": "h1:end:<token>" }] }
    ]
  }
}
```

- Saneado de cada variable: saltos de línea y tabuladores → espacio; espacios repetidos → uno;
  sin variables vacías (→ "—").
- Mismos reintentos que `sendText` de la 002 (429, 5xx, red); un 4xx (plantilla inexistente o
  rechazada, número no válido) no se reintenta y se registra con `failure` = `template_rejected`
  o `recipient_invalid`.
- `ok` con el `wamid` devuelto; plazo total 15 s.

## WhatsApp: lo que escribe el negocio al número del bot (R10)

`payload.ts` pasa a extraer:

- `contacts[].profile.name` → `InboundEvent.profileName` (por `wa_id`).
- `type = "button"` → `kind = 'other'`, `otherType = 'button'`, `buttonPayload = button.payload`.
- `type = "interactive"` con `button_reply` → igual, con `button_reply.id`.

Enrutador (`src/bot.ts`, antes de `intake.handle`), por cada evento:

| Evento | Acción |
|--------|--------|
| `buttonPayload` con formato `h1:(attend\|end):<token>` (de cualquier número) | `handoff.act(token, action, 'whatsapp')` y acuse al remitente |
| remitente = `handoff_alerts.whatsapp_phone` (cualquier otro mensaje) | ayuda al negocio (como mucho una vez cada 15 min por número); no entra en la recepción |
| resto | recepción normal de cliente; `profileName` se guarda en `conversation.contact_name` |

Acuses y ayuda (texto libre; la ventana del negocio está abierta porque acaba de escribir):

| Resultado | Texto |
|-----------|-------|
| `attend` hecho | "Anotado: atiendes a {nombre}. Pulsa «Terminado» cuando acabes." |
| `end` hecho | "Anotado: derivación de {nombre} terminada. El asistente vuelve a atenderle." |
| ya confirmada (`attend`) | "Ya estaba anotado que atiendes a {nombre}." |
| ya terminada | "Esa derivación ya había terminado; no se ha cambiado nada." |
| token no válido | "No reconozco ese botón; no se ha cambiado nada." |
| ayuda (FR-008b) | "Este número es el del asistente automático y no reenvía lo que escribes al cliente. Contesta al cliente desde tu teléfono y usa los botones «Le atiendo» y «Terminado» de cada aviso." |

## Email (R7)

`src/mail/smtp-mailer.ts` (nodemailer). De `SMTP_FROM` al `handoff_alerts.email`. Texto plano y
HTML equivalente; todo contenido del cliente escapado en el HTML.

| Tipo | Asunto |
|------|--------|
| aviso | `Derivación: {nombre} ({tipo})` |
| recordatorio | `Recordatorio: {nombre} sigue esperando` |
| reenvío | `Mensaje de {nombre} durante la derivación` |

Cuerpo del aviso (texto):

```text
El asistente ha pasado una conversación a tu negocio.

Cliente: {nombre}
Teléfono: {teléfono}
Canal: {canal}
Tipo: {tipo}
Desde: {desde}
Motivo: {motivo}

Contacta con el cliente desde tu teléfono. Mientras tanto el asistente no le responde.

Le atiendo: {PUBLIC_BASE_URL}/handoff/{token}/attend
Terminado:  {PUBLIC_BASE_URL}/handoff/{token}/end

Si no confirmas en 2 horas de tu horario de atención, te enviaremos un recordatorio y daremos al
cliente tu contacto directo. Si el cliente no escribe en 24 horas, la conversación vuelve al
asistente.
```

- El reenvío lleva el texto completo de cada mensaje del lote (sin recortar), en orden, con su
  hora local, y los mismos dos enlaces.
- Recordatorio y reenvíos: `In-Reply-To` y `References` = `Message-ID` del aviso
  (`handoff_notice.provider_ref` del aviso por email).
- `ok` cuando el servidor SMTP acepta el mensaje; plazo 15 s; sin reintentos propios.

## Enlaces del email (`src/channels/handoff-links/routes.ts`, R8)

Registrado en `/handoff` solo si hay bot. Sin sesión ni cookies. Cabeceras en todas las
respuestas: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
`X-Robots-Tag: noindex, nofollow`, CSP `default-src 'none'; style-src 'self'; form-action 'self'`.
Límite por IP: 30 peticiones / 15 min (en memoria, como el chat web; la IP no se registra).

### `GET /handoff/:token/:action`

`action ∈ {attend, end}`; `token` = 22 caracteres base64url. **No cambia nada.**

| Caso | Respuesta |
|------|-----------|
| formato no válido o token desconocido | `404`, página "Este enlace no es válido." |
| derivación terminada | `200`, "Esta derivación ya ha terminado." sin botón |
| `attend` y ya confirmada | `200`, "Ya está anotado que atiendes a {nombre}." + botón "Terminado" (a `…/end`) |
| resto | `200`, "{nombre} ({teléfono}) · {tipo} · desde {desde}" y un formulario `POST` a la misma URL con el botón "Le atiendo" o "Terminado" |

### `POST /handoff/:token/:action`

Cuerpo vacío o `application/x-www-form-urlencoded` ignorado. Llama a
`handoff.act(token, action, 'email')` y responde `200` con el resultado
("Anotado: atiendes a {nombre}.", "Anotado: derivación terminada. El asistente vuelve a atender a
{nombre}.", "Ya estaba…", "Esta derivación ya había terminado; no se ha cambiado nada."), o `404`
si el token no es válido. Repetir el `POST` no cambia nada (idempotente).

## Garantías verificables (contrato e integración)

- **FR-008**: con las dos vías disponibles, un inicio produce exactamente un `alert` por vía; con
  una, solo por esa; sin ninguna, ninguno (y no hay derivación).
- **FR-008a / SC-010**: con dos derivaciones activas, el botón o enlace de una solo cambia esa.
- **FR-008b**: un texto del WhatsApp de avisos no crea `customer`, `conversation` ni `message` y
  no cambia ninguna derivación; recibe la ayuda una vez cada 15 min.
- **FR-016**: "Terminado" confirma y termina; "Le atiendo" y "Terminado" por email y WhatsApp a la
  vez → solo cuenta el primero (`UPDATE … WHERE status = 'active'`).
- **R8**: un `GET` de un enlace nunca cambia la BD.
- **Variables de plantilla**: ninguna contiene `\n`, `\t` ni 5 espacios seguidos, ni está vacía.
- **Privacidad**: el email y la plantilla no contienen datos del negocio que no sean su propio
  flujo; ningún texto del cliente llega a los registros.
