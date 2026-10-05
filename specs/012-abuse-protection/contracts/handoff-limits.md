# Contrato: límites de las derivaciones y texto del cliente en los avisos

**Feature**: 012 · US2 · FR-012 – FR-017 · research R7, R8, R10.4. Amplía
[005 handoff-flow](../../005-handoff-to-business/contracts/handoff-flow.md) y
[005 business-alerts](../../005-handoff-to-business/contracts/business-alerts.md).

## Límites (`handoff_limits`, data-model §1.6)

| Límite | Defecto | Rango |
|---|---|---|
| Derivaciones nuevas por día local | 20 | 1–200 |
| Minutos entre avisos de una derivación | 15 | 5–240 |
| Avisos al negocio por día local | 60 | 10–500 |

Solo derivaciones y avisos reales; la vía simulada de «Probar el bot» ni cuenta ni se limita.

## Derivación nueva

| Situación | Negocio | Cliente final | Registro |
|---|---|---|---|
| Hay plaza diaria y plaza de aviso | alerta (como en la 005) | R-HANDOFF-OK / R-HANDOFF-COMPLAINT | `handoff_started` |
| Sin plaza de derivaciones (`started >= daily_max`) | nada | R-HANDOFF-FAIL + CONTACTO | `handoff_not_started { reason: 'daily_limit' }`; `refused + 1`; `handoff_daily_limit` una vez al día |
| Hay plaza de derivación pero no de aviso | nada | R-HANDOFF-FAIL + CONTACTO | `handoff_not_started { reason: 'daily_limit' }`; `notices_held + 1`; `business_notices_held` una vez al día |
| La conversación ya tiene derivación activa | — | — (reenvío) | no es derivación nueva |

## Reenvío durante la derivación

1. Con pendientes y derivación activa, si `now − last_notice_at < forward_interval_minutes`: no se
   envía; los entrantes siguen `pending`; `conversation.process_after = last_notice_at + intervalo`;
   `handoff_forward_deferred { reason: 'interval' }`.
2. Al vencer: **un** aviso con todos los pendientes acumulados (en el email, cada uno con su hora;
   en la plantilla, unidos y recortados a 700 caracteres como en la 005).
3. Sin plaza de aviso diaria: no se envía; `notices_held + 1`; `process_after` = 00:00 locales del
   día siguiente; `handoff_forward_deferred { reason: 'daily_limit' }`.
4. Antes de enviar: entrantes a `forwarded`, plaza reservada y `last_notice_at = now` en una
   transacción; después se envía (como mucho una vez, R10).
5. Al terminar la derivación (cualquier causa) los pendientes de esa conversación anteriores al fin
   pasan a `held`; se ven en el panel y en «Probar el bot» como «retenido (no reenviado)».
6. El cliente final no recibe nada distinto de lo habitual en 1–3.
7. Límite por cliente (FR-012): los entrantes por encima del límite de la recepción quedan
   `rate_limited` y nunca se reenvían; R-LIMIT una vez por ventana, como sin derivación.

## Recordatorios

Cuentan en el tope diario. Sin plaza: no se envían y no se acumulan (`notices_held + 1`); el cliente
recibe igualmente R-HANDOFF-LATE si toca (no es un aviso al negocio).

## Texto del cliente (`customerQuote`)

Se aplica a: texto reenviado, resumen (del modelo o literal) y nombre de contacto/perfil.

| Entrada | Salida |
|---|---|
| `mira https://ejemplo.com/oferta` | `mira ejemplo[.]com/oferta` |
| `www.ejemplo.es` | `www[.]ejemplo[.]es` |
| `escribe a ana@ejemplo.com` | `escribe a ana[@]ejemplo[.]com` |
| `ejemplo.com.` | `ejemplo[.]com.` |
| `HTTP://EJEMPLO.COM` | `EJEMPLO[.]COM` |
| `3.5 kg` / `p.ej.` | sin cambios (no es dirección: R12) |

Delimitado:

- **Email** (texto plano): `El cliente escribió:` y debajo cada línea sangrada 4 espacios, entre
  `«` y `»`; nada del cliente empieza en la columna 0. El motivo, `Motivo (según el cliente): «…»`.
- **Plantillas de WhatsApp**: el texto de la variable empieza por `El cliente escribió: «` y acaba en
  `»` (el resumen, `Según el cliente: «…»`). Las plantillas aprobadas no cambian.

## Panel

- «Derivaciones»: pendientes de reenviar por el intervalo (con la hora prevista) y mensajes
  `held`.
- «Consumo» → sección «Límites de derivación»: formulario de los tres límites (ver
  [admin-protection.md](admin-protection.md)) y los contadores de hoy: derivaciones nuevas
  `started / daily_max`, peticiones sin aviso (`refused`), avisos `notices / notices_daily_max`,
  retenidos (`notices_held`).
- Banda común: `BUSINESS_NOTICES_HELD` cuando `notices_held > 0` hoy.
