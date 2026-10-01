# Data Model: Consumo y coste por instancia

**Feature**: 010-usage-cost-cap | **Fecha**: 2026-10-01

Una migración de solo añadir, `0006_usage.sql` (generada con `pnpm db:generate`). Unidades y
cálculos en [research.md](research.md) (R4, R5). Ninguna tabla nueva es configuración del negocio:
no viajan en el fichero de la 008 ni suben `formatVersion` (R15).

## 1. Tablas

### `model_usage` — registro de consumo

Una fila por respuesta con modelo o por resumen de derivación (R2). **Sin** textos, teléfonos,
identificadores de cliente final ni de conversación, ni IP (FR-003): no tiene claves ajenas.

| Columna | Tipo | Reglas |
|---|---|---|
| `id` | `uuid` PK | `gen_random_uuid()` |
| `at` | `timestamptz` not null | momento del registro |
| `day` | `date` not null | día local del negocio en `at` (R6) |
| `channel` | `customer_channel` not null | enum existente: `whatsapp`, `web`, `playground` |
| `purpose` | `usage_purpose` not null | enum nuevo: `reply`, `handoff_summary` |
| `model` | `text` not null | `LLM_MODEL` con el que se llamó; 1–200 caracteres |
| `calls` | `smallint` not null | llamadas que informaron tokens; ≥ 1 |
| `input_tokens` | `integer` not null | ≥ 0 |
| `output_tokens` | `integer` not null | ≥ 0 |
| `cache_write_tokens` | `integer` not null | ≥ 0 |
| `cache_read_tokens` | `integer` not null | ≥ 0 |
| `cost_pico` | `bigint` null | billonésimas de `currency`; **null = sin precio** (FR-012) |
| `currency` | `char(3)` null | moneda con la que se valoró; null ⇔ `cost_pico` null |

Restricciones: `check` de no negativos y `calls >= 1`; `check ((cost_pico is null) = (currency is
null))`. Índice: `model_usage_day_idx (day)`.

Nunca se actualiza: el coste queda congelado al insertar (FR-011). Se borra por retención (R14).

### `model_price` — precio vigente por modelo

| Columna | Tipo | Reglas |
|---|---|---|
| `model` | `text` PK | identificador exacto del modelo; 1–200 caracteres, sin espacios a los lados |
| `input_micros_per_mtok` | `bigint` not null | ≥ 0 |
| `output_micros_per_mtok` | `bigint` not null | ≥ 0 |
| `cache_write_micros_per_mtok` | `bigint` not null | ≥ 0 |
| `cache_read_micros_per_mtok` | `bigint` not null | ≥ 0 |
| `updated_at` | `timestamptz` | convención del proyecto |

Sin histórico (Assumptions de la spec): solo el precio vigente. Vacía por defecto: el núcleo no trae
precios (FR-026).

### `usage_settings` — ajustes de consumo (fila única)

| Columna | Tipo | Reglas |
|---|---|---|
| `id` | `smallint` PK default 1 | `check (id = 1)` |
| `currency` | `char(3)` not null default `'USD'` | ISO 4217 en mayúsculas |
| `cap_enabled` | `boolean` not null default `false` | tope desactivado por defecto (FR-014) |
| `monthly_cap_cents` | `integer` null | > 0 cuando `cap_enabled`; se conserva al desactivar |
| `cap_notified_month` | `date` null | primer día del mes local en que ya se registró `spend_cap_reached` (R10) |
| `updated_at` | `timestamptz` | |

Restricción: `check (not cap_enabled or monthly_cap_cents > 0)`. La migración inserta la fila 1.

## 2. Tipos del dominio (`src/usage`)

```text
TokenUsage        { input, output, cacheWrite, cacheRead }            enteros ≥ 0
ResponseUsage     { calls, tokens: TokenUsage }                       suma de una respuesta
UsagePurpose      'reply' | 'handoff_summary'
UsageRecordInput  { channel, purpose, model, usage: ResponseUsage, at, timezone }
ModelPrice        { model, inputMicros, outputMicros, cacheWriteMicros, cacheReadMicros }
UsageSettings     { currency, capEnabled, monthlyCapCents | null }
SpendCapLevel     'none' | 'normal' | 'warning' | 'reached'
SpendCapState     { level, spentPico, capCents | null, currency, percent | null }
UsageRow          { calls, replies, summaries, tokens: TokenUsage, cost: Map<currency, pico>, unpricedModels: string[] }
UsageSummary      { period, byChannel: Record<Channel, UsageRow>, customers: UsageRow, instance: UsageRow, byDay?: Array<{ day, row }> }
```

- `customers` = WhatsApp + web; `instance` = los tres canales (US2-1).
- `replies` cuenta registros `purpose = reply`; `summaries`, los de `handoff_summary`.
- `unpricedModels`: modelos con algún registro `cost_pico is null` en el periodo (US2-4).

## 3. Reglas de cálculo

- **Coste de un registro** (R4/R5): `cost_pico = Σ tokens_tipo × precio_tipo` si hay precio para
  `model` al insertar; si no, `null`.
- **Gasto del mes** (FR-015): `Σ cost_pico` de los registros con `day` en el mes local en curso y
  `currency = usage_settings.currency`. Incluye playground y resúmenes; los sin precio no suman.
- **Nivel del tope** (en este orden):
  - `none` si `cap_enabled = false`;
  - `reached` si `gasto ≥ monthly_cap_cents × 10¹⁰`;
  - `warning` si `gasto × 100 ≥ monthly_cap_cents × 10¹⁰ × 80`;
  - si no, `normal`.
- **Porcentaje** mostrado: `floor(gasto × 100 / (cap × 10¹⁰))`, puede pasar de 100 (edge case de
  gasto por encima del tope).
- **Redondeo en pantalla**: los costes se muestran con 4 decimales, redondeo a la mitad hacia
  arriba sobre el entero exacto; los totales se suman **antes** de redondear (SC-002). La pantalla
  lo indica.

## 4. Validación (Zod, en el dominio; errores por campo, FR-013)

| Formulario | Campo | Regla |
|---|---|---|
| Precio | `model` | texto 1–200 tras recortar |
| Precio | cuatro precios | decimal ≥ 0, hasta 6 decimales, ≤ 1 000 000 por MTok → millonésimas |
| Ajustes | `currency` | 3 letras ISO 4217; si cambia, la tabla de precios debe estar vacía (R13) |
| Ajustes | `capEnabled` | si `true`: `monthlyCap` obligatorio y > 0, **y** `model_price` tiene fila para `LLM_MODEL` (FR-014; el error nombra el modelo) |
| Ajustes | `monthlyCap` | decimal > 0 con hasta 2 decimales, ≤ 10 000 000 → céntimos |

Cada guardado va en una transacción (FR-013). Borrar el precio del modelo actual con el tope activo
**se permite**: el panel pasa a mostrar el aviso de FR-021.

## 5. Estados del tope

```text
             activar (con precio)            gasto ≥ 80 %            gasto ≥ 100 %
  none ───────────────────────────► normal ───────────────► warning ───────────────► reached
   ▲                                  ▲  ▲                     │                        │
   │ desactivar (desde cualquiera)    │  └── subir el tope ────┴────────────────────────┤
   └──────────────────────────────────┴──────── empieza el mes local (gasto = 0) ───────┘
```

Nada se guarda: el nivel se calcula en cada comprobación (FR-020). Solo `cap_notified_month`
recuerda que el evento del mes ya se emitió.

## 6. Cambios en tipos existentes

| Dónde | Cambio |
|---|---|
| `ChatModel.reply` opts | `onUsage?: (u: TokenUsage) => void` (R1) |
| `HandoffSummarizer.summarize` opts | `onUsage?: (u: TokenUsage) => void` |
| `Response` (responder) | `usage?: ResponseUsage` |
| `ChannelPolicy` | `spendCap: boolean` — WhatsApp y web `true`, playground `false` |
| `REPLY_TEMPLATES` | + `R-CAP` (en `reply_trace`, jsonb: sin migración) |
| `HandoffService.start` input | `modelSummary: boolean` (R9) |
| `DiscardReason` | + `spend_cap` |
| `BotEvent` | + `spend_cap_reached { month }`, + `usage_record_failed { purpose }`; `handoff_summary_fallback.reason` + `spend_cap` |
| `HealthReport` | + `spendCap: SpendCapLevel \| null` (solo vista completa) |
| `VersionRow` (`instance:versions`) | + `spendCap: SpendCapLevel \| null` |

## 7. Retención

Borrado horario de `model_usage` con `day < primer día del mes local de hace 12 meses` (FR-006,
R14). Se conservan el mes en curso y los 12 anteriores.
