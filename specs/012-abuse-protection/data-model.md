# Data Model: Protección frente a abuso y saturación

**Feature**: 012-abuse-protection · Migración de solo añadir **`0008_abuse_protection.sql`**.

Nada de esto es configuración del negocio: no entra en el fichero de la 008, **no sube
`formatVersion`** y la prueba `tests/unit/config-transfer/usage-tables.test.ts` amplía su lista de
tablas que no viajan (`transcription_price`, `whatsapp_usage_day`, `handoff_limits`,
`handoff_day`). Todo vive en la BD de la instancia y entra solo en las copias de la 006 (FR-036).

---

## 1. Cambios de esquema

### 1.1 Enums (solo `ADD VALUE`)

| Enum | Valor nuevo | Uso |
|---|---|---|
| `usage_purpose` | `transcription` | Consumo de una transcripción (R6) |
| `message_status` | `held` | Entrante retenido por los límites al terminar la derivación (R7.4) |
| `handoff_end_cause` | `interrupted` | Reintento que no sabe si la alerta salió (R10.4) |

`ALTER TYPE … ADD VALUE` no se puede usar en la misma transacción que lo añade: la migración no
usa los valores nuevos (ni en `CHECK` ni en el relleno).

### 1.2 `model_usage` (010, ampliada)

| Columna | Tipo | Regla |
|---|---|---|
| `audio_ms` | `integer` nulo | Duración del audio en ms; solo en `purpose = 'transcription'` (lo garantiza el dominio). `CHECK (audio_ms is null or audio_ms >= 0)` |

Para `transcription`: `calls = 1`, los cuatro contadores de tokens a 0, `model = STT_MODEL`,
`cost_pico = ceil(audio_ms × micros_per_minute × 50 / 3)` o nulo sin precio, `currency` como en la
010. Sigue sin textos ni identificadores de cliente o conversación.

### 1.3 `transcription_price` (nueva)

| Columna | Tipo | Regla |
|---|---|---|
| `model` | `text` PK | 1–200 caracteres, sin espacios a los lados |
| `micros_per_minute` | `bigint` not null | ≥ 0; millonésimas de la moneda por minuto de audio |
| `updated_at` | `timestamptz` not null | `clock_timestamp()` |

Misma moneda que `model_price` (`usage_settings.currency`; cambiarla exige también esta tabla vacía,
010 R13).

### 1.4 `usage_settings` (010, ampliada)

| Columna | Tipo | Defecto | Regla |
|---|---|---|---|
| `whatsapp_daily_cap` | `integer` not null | 200 | `CHECK (whatsapp_daily_cap between 1 and 10000)` |
| `whatsapp_cap_notified_day` | `date` nulo | — | Día local en que salió `whatsapp_quota_reached` (una vez al día) |

### 1.5 `whatsapp_usage_day` (nueva)

| Columna | Tipo | Regla |
|---|---|---|
| `day` | `date` PK | Día local del negocio |
| `replies` | `integer` not null | ≥ 0; respuestas de WhatsApp que llamaron al modelo |

Se suma en la transacción del saliente (R5). Retención: 400 días, en la misma pasada que
`web_usage_day`.

### 1.6 `handoff_limits` (nueva, fila única)

| Columna | Tipo | Defecto | Regla |
|---|---|---|---|
| `id` | `smallint` PK | 1 | `CHECK (id = 1)` |
| `daily_max` | `integer` not null | 20 | 1–200 |
| `forward_interval_minutes` | `integer` not null | 15 | 5–240 |
| `notices_daily_max` | `integer` not null | 60 | 10–500 |
| `updated_at` | `timestamptz` not null | `clock_timestamp()` | |

La migración inserta la fila. Los mínimos y máximos también están en el `CHECK` (no se pueden anular
ni desde SQL de la aplicación).

### 1.7 `handoff_day` (nueva)

| Columna | Tipo | Regla |
|---|---|---|
| `day` | `date` PK | Día local del negocio |
| `started` | `integer` not null default 0 | Derivaciones nuevas con plaza reservada |
| `refused` | `integer` not null default 0 | Peticiones sin aviso por `daily_max` (se ven en el panel) |
| `notices` | `integer` not null default 0 | Avisos al negocio con plaza reservada (uno por aviso, no por vía) |
| `notices_held` | `integer` not null default 0 | Avisos no enviados por `notices_daily_max` |
| `refused_logged` | `boolean` not null default false | `handoff_daily_limit` ya registrado ese día |
| `held_logged` | `boolean` not null default false | `business_notices_held` ya registrado ese día |

Todos los contadores `CHECK (… >= 0)`. Solo cuentan las derivaciones y avisos reales (no la vía
simulada de «Probar el bot»). Retención: 400 días.

**Reserva atómica** (R7): una sola sentencia

```sql
insert into handoff_day (day, notices) values ($day, 1)
on conflict (day) do update set notices = handoff_day.notices + 1
  where handoff_day.notices < $max
returning notices;
```

Sin fila devuelta = sin plaza → `notices_held + 1` en otra sentencia. Igual con `started`.

### 1.8 `conversation` (ampliada)

| Columna | Tipo | Defecto | Regla |
|---|---|---|---|
| `batch_attempts` | `smallint` not null | 0 | 0–5 |
| `process_after` | `timestamptz` nulo | — | El procesador no la reclama antes (reintento o reenvío agrupado) |

`claimReady` añade `and (c.process_after is null or c.process_after <= $now)`.

### 1.9 `handoff` (ampliada)

| Columna | Tipo | Regla |
|---|---|---|
| `alerts_sent_at` | `timestamptz` nulo | Avisos de inicio enviados (alguna vía entregó) |
| `customer_notified_at` | `timestamptz` nulo | Confirmación al cliente guardada |
| `last_notice_at` | `timestamptz` nulo | Último aviso a esta derivación (alerta, reenvío o recordatorio) |

Relleno de la migración para las derivaciones existentes: `alerts_sent_at = customer_notified_at =
started_at` y `last_notice_at = max(handoff_notice.created_at)` de la derivación (o `started_at`).

---

## 2. Entidades de dominio

### 2.1 Estado de protección (calculado, nunca guardado)

```ts
type ContactOnlyReason = 'cap_disabled' | 'model_unpriced' | 'stt_unpriced' | 'spend_unreadable';

interface ProtectionState {
  production: boolean;
  /** Motivos por los que los clientes finales reciben solo el contacto (FR-001, FR-004, FR-008). */
  contactOnly: ContactOnlyReason[];      // 'stt_unpriced' solo afecta a los audios
  spendCap: SpendCapState | null;        // 010; null si no se pudo leer
  whatsapp: { today: number; cap: number; reached: boolean } | null;
  handoffs: { started: number; refused: number; notices: number; held: number;
              limits: HandoffLimits } | null;
  /** Modelos que nombran los avisos críticos (sin precio). */
  unpricedModels: { llm: string | null; stt: string | null };
}
```

Reglas (tabla de casos en `tests/unit/usage/protection.test.ts`):

| Condición | `production` | Motivo |
|---|---|---|
| Tope desactivado | sí | `cap_disabled` |
| `LLM_MODEL` sin precio | sí | `model_unpriced` |
| Audios activados y `STT_MODEL` sin precio en `transcription_price` | sí | `stt_unpriced` |
| Consulta fallida o > 2 s | cualquiera | `spend_unreadable` (y el resto, `null`) |
| Tope desactivado / sin precio | no | — (010: opcional) |

**Puede llamar al modelo** un canal de clientes finales si `contactOnly` no tiene motivos que le
afecten, `spendCap.level !== 'reached'` y, en WhatsApp, `!whatsapp.reached` (y en web, el tope de la
004). **Puede transcribir** si además no está `stt_unpriced`.

### 2.2 Avisos de protección

| Código | Severidad | Cuándo | Mensaje (resumen) |
|---|---|---|---|
| `SPEND_CAP_REQUIRED` | crítico | `cap_disabled` | En producción el tope de gasto es obligatorio; mientras no lo actives, los clientes reciben solo el contacto. |
| `MODEL_UNPRICED` | crítico | `model_unpriced` | El modelo «X» no tiene precio… |
| `STT_MODEL_UNPRICED` | crítico | `stt_unpriced` | El modelo de transcripción «X» no tiene precio; los audios se responden con el contacto. |
| `SPEND_UNREADABLE` | crítico | `spend_unreadable` | No se puede leer el gasto; el bot responde solo con el contacto. |
| `BUSINESS_NOTICES_HELD` | normal | `handoffs.held > 0` hoy | N avisos al negocio retenidos hoy por el límite diario. |

`target.kind = 'instance'`. Calculados en cada página; nunca guardados; fuera de `computeWarnings`.

### 2.3 Límites de derivación

`HandoffLimits { dailyMax, forwardIntervalMinutes, noticesDailyMax }` con su esquema Zod
(`handoffLimitsSchema`): enteros en el rango de §1.6, error por campo con el rango en el mensaje.
Guardado en transacción (`saveHandoffLimits`); vale desde el siguiente mensaje (se lee sin caché).

### 2.4 Lote de una conversación

| Estado | Condición | Siguiente |
|---|---|---|
| listo | pendientes, espera de agrupado cumplida, `process_after` vencido o nulo | procesando |
| procesando | reclamado | hecho (attempts = 0) · fallo |
| fallo (n < 5) | `processConversation` lanzó | espera: `process_after = ahora + [5 s, 30 s, 2 min, 10 min][n−1]` |
| abandonado | quinto fallo | R-ERR una vez cubriendo los pendientes; attempts = 0 |
| esperando reenvío | derivación activa y último aviso hace < intervalo, o sin plaza diaria | `process_after = último aviso + intervalo` o inicio del día local siguiente |

### 2.5 Derivación nueva (inicio con «como mucho una vez»)

```text
reservar plaza diaria ──sin plaza──▶ R-HANDOFF-FAIL + CONTACTO (refused + 1)
      │
guardar derivación (alerts_sent_at = null) ─▶ enviar alertas ─▶ ninguna entrega ─▶ borrar derivación
      │                                                    └─▶ alguna entrega ─▶ alerts_sent_at = ahora
      ▼
transacción del saliente: confirmación + avisos + customer_notified_at = ahora

Reintento con derivación activa:
  alerts_sent_at nulo                       ─▶ terminar (interrupted) + R-HANDOFF-FAIL + CONTACTO
  alerts_sent_at y customer_notified_at nulo ─▶ solo la confirmación (sin volver a avisar)
```

### 2.6 Regla de enlaces

`displayLinks(text): LinkMatch[]` y `linkCandidates(text): LinkMatch[]` con
`LinkMatch { start, end, url }`; propiedad `displayLinks(t) ⊆ linkCandidates(t)` (mismo `start`,
`end` y `url`). Lista de dominios de primer nivel IANA embebida en `src/conversation/tlds.ts`.

### 2.7 Secretos

`SecretFinding { variable, rule: 'too_short' | 'example_value' | 'trivial' | 'reused' |
'health_secret_required' }`; el valor nunca sale de `secret-rules.ts`.

---

## 3. Eventos del registro de actividad (nuevos)

Catálogo cerrado, sin texto libre ni datos personales (contrato
[logging-and-startup.md](contracts/logging-and-startup.md)).

| Evento | Nivel | Campos |
|---|---|---|
| `protection_read_failed` | error | `errorClass` (como mucho uno por minuto) |
| `contact_only_reply` | warn | `reason` (`ContactOnlyReason` o `whatsapp_daily`) |
| `whatsapp_quota_reached` | warn | `cap` (una vez por día local) |
| `transcription_failed` | warn | `reason: 'blocked'` (valor nuevo) |
| `transcription_usage_failed` | error | — (como `usage_record_failed`) |
| `handoff_not_started` | warn | `reason: 'daily_limit'` (valor nuevo) |
| `handoff_daily_limit` | warn | `max` (una vez por día local) |
| `business_notices_held` | warn | `max` (una vez por día local) |
| `handoff_forward_deferred` | debug | `handoffId`, `messages`, `reason: 'interval' \| 'daily_limit'` |
| `handoff_ended` | info | `cause: 'interrupted'` (valor nuevo), `heldMessages` |
| `batch_retry_scheduled` | warn | `attempt`, `delayMs`, `errorClass` |
| `batch_abandoned` | error | `attempts`, `apologySent` |
| `login_throttled` | warn | `delayMs`, `queued`, `rejected` (sin dirección) |
| `weak_secrets` | warn | `findings: [{ variable, rule }]` (solo fuera de producción, al arrancar) |
