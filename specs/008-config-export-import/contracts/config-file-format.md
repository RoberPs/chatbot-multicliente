# Contrato: formato del fichero de configuración, versión 1

**Feature**: 008-config-export-import

Fichero JSON en UTF-8 (sin BOM; al importar se acepta y se ignora), sangría de 2 espacios, claves
en el orden de este documento y salto de línea final. Tamaño máximo al importar: **5 MiB**.
Nombre al descargar: `configuracion-<INSTANCE_ID o "instancia">-<AAAAMMDD-HHMM>.json` (UTC).

Todos los objetos son **estrictos**: una clave que no está en este contrato hace que se rechace
el fichero (FR-010). Las listas conservan el orden de presentación del panel (FR-002).

## Ejemplo (valores ilustrativos)

```json
{
  "format": "business-config",
  "formatVersion": 1,
  "exportedAt": "2026-09-30T10:15:00.000Z",
  "source": { "instanceId": "demo-01", "schema": "0005_config_transfer" },
  "includesAlertDestinations": false,
  "info": { "businessStatus": "active", "webChatEnabled": true },
  "business": {
    "name": "Negocio de ejemplo",
    "address": "Calle Mayor 1",
    "directions": null,
    "mapUrl": "https://maps.example.com/abc",
    "phone": "+34910000000",
    "email": "hola@example.com",
    "timezone": "Europe/Madrid",
    "currency": "EUR"
  },
  "openingHours": [{ "weekday": 1, "start": "09:00", "end": "14:00" }],
  "closures": [
    { "startDate": "2026-12-24", "endDate": "2026-12-26", "startTime": null, "endTime": null, "reason": "Navidad" }
  ],
  "services": [
    {
      "name": "Servicio A",
      "description": null,
      "priceType": "fixed",
      "priceCents": 2500,
      "durationMinutes": 30,
      "bookable": true,
      "active": true
    }
  ],
  "resources": [
    {
      "name": "Recurso 1",
      "active": true,
      "services": ["Servicio A"],
      "hours": [{ "weekday": 1, "start": "09:00", "end": "14:00" }],
      "absences": [{ "startDate": "2026-08-01", "endDate": "2026-08-15", "startTime": null, "endTime": null }]
    }
  ],
  "faqs": [{ "question": "¿Hay aparcamiento?", "answer": "Sí, en la calle de atrás." }],
  "policies": {
    "cancellationText": "Avisa con un día de antelación.",
    "cancellationNoticeMinutes": 1440,
    "minAdvanceMinutes": 60,
    "maxAdvanceMinutes": 43200,
    "paymentMethods": ["Efectivo", "Tarjeta"]
  },
  "tone": { "addressForm": "informal", "styleDescription": null },
  "handoff": {
    "channels": [{ "type": "phone", "value": "+34910000000" }],
    "hours": []
  },
  "webChat": {
    "allowedOrigins": ["https://www.example.com"],
    "privacyUrl": "https://www.example.com/privacidad",
    "dailyCap": 200,
    "monthlyCap": 3000
  }
}
```

Con `includesAlertDestinations: true` se añade al final:

```json
  "alertDestinations": { "whatsapp": "+34600000000", "email": "avisos@example.com" }
```

## Sobre

| Clave | Tipo | Regla |
|-------|------|-------|
| `format` | `"business-config"` | si falta o es otro → rechazo `not_export` |
| `formatVersion` | entero | `1` en esta feature; mayor → `future_version`; no soportado → `unsupported_version` |
| `exportedAt` | texto ISO 8601 con `Z` | obligatorio |
| `source.instanceId` | texto o `null` | minúsculas, cifras y guiones (1–40), o `null` |
| `source.schema` | texto | etiqueta de migración; se muestra en la vista previa y en el rechazo por versión |
| `includesAlertDestinations` | booleano | `true` si y solo si está `alertDestinations` |
| `info.businessStatus` | `"draft"` \| `"active"` | informativo; **nunca se importa** |
| `info.webChatEnabled` | booleano | informativo; **nunca se importa** |

## Secciones y reglas (mismas que el panel salvo las diferencias marcadas ◆)

| Sección / campo | Regla |
|-----------------|-------|
| `business.name` | texto recortado ≤ 200; ◆ se admite `""` (valor inicial de una instancia nueva) |
| `business.address` | ≤ 500 o `null` |
| `business.directions` | ≤ 2000 o `null` |
| `business.mapUrl` | enlace `https://` ≤ 500 o `null` (reglas de la 003) |
| `business.phone` | teléfono válido en E.164 o `null` |
| `business.email` | email válido (se guarda en minúsculas) o `null` |
| `business.timezone` | zona IANA válida |
| `business.currency` | código ISO 4217 de 3 letras |
| `openingHours[]`, `resources[].hours[]`, `handoff.hours[]` | `weekday` 1–7, `start`/`end` `HH:MM`, fin > inicio, sin solapes el mismo día |
| `closures[]`, `resources[].absences[]` | fechas reales `AAAA-MM-DD`, fin ≥ inicio; horas las dos o ninguna, fin > inicio; `reason` ≤ 200 o `null` (solo cierres) |
| `services[].name` | 1–200; **único** sin distinguir mayúsculas |
| `services[].description` | ≤ 4000 o `null` |
| `services[].priceType` | `fixed` \| `from` \| `on_request` |
| `services[].priceCents` | ◆ entero ≥ 0 o `null`; con `on_request` debe ser `null` |
| `services[].durationMinutes` | entero 1–1440 o `null` |
| `services[].bookable`, `active` | booleanos |
| `resources[].name` | 1–200; **único** sin distinguir mayúsculas |
| `resources[].services[]` | nombres de servicios **del fichero**, sin repetir |
| `faqs[].question` / `answer` | 1–500 / 1–4000 |
| `policies` | objeto o `null`; minutos enteros: aviso ≥ 0, mínima ≥ 0, máxima > 0, mínima ≤ máxima; texto ≤ 4000; formas de pago ≤ 100 caracteres, ◆ **sin repetir** (el panel las descarta; el fichero las rechaza) |
| `tone` | objeto o `null`; `addressForm` `informal` \| `formal`; `styleDescription` ≤ 2000 o `null` |
| `handoff` | objeto o `null`; `channels[]` con `type` `phone` \| `whatsapp` \| `email` y `value` en E.164 o email; sin repetir tipo+valor |
| `webChat.allowedOrigins[]` | como máximo 10; `https://host[:puerto]` sin ruta (se admite `http` solo para `localhost` y `127.0.0.1`), sin repetir |
| `webChat.privacyUrl` | `https://…` o `null` |
| `webChat.dailyCap` / `monthlyCap` | enteros ≥ 1; mensual ≥ diario |
| `alertDestinations.whatsapp` / `email` | teléfono E.164 / email, o `null` |

Una sección de lista vacía (`[]`) significa "el negocio no tiene elementos en esa sección": al
importar se eliminan los del destino (caso límite).

## Condiciones que no son del fichero sino del destino

Se evalúan en la vista previa y otra vez al confirmar:

- Negocio del destino **activo** y la configuración resultante tiene avisos críticos → no se
  aplica (FR-018).
- Chat web del destino **activado** y el fichero no trae webs permitidas o enlace de privacidad →
  no se aplica ("desactiva antes el chat web o corrige el fichero").

## Evolución del formato

- Toda migración que añada o cambie configuración del negocio sube `formatVersion` y añade un
  actualizador `vN → vN+1` que rellena lo nuevo con su valor por defecto.
- Las versiones anteriores siguen aceptándose mientras exista su actualizador (FR-009).
- Un test compara las columnas de configuración de `src/db/schema.ts` con las cubiertas por el
  formato; una columna nueva sin tratar hace fallar la suite.
