/**
 * Tipos del consumo y coste del modelo (010, data-model.md §2). Sin textos ni identificadores de
 * cliente o conversación (FR-003). Importes en enteros: precios en millonésimas por millón de
 * tokens, costes en billonésimas (`bigint`) y tope en céntimos (research R4).
 */
import type { Channel } from '../conversation/channels.js';

/**
 * Tokens que informa el proveedor en una llamada, o la suma de varias. Enteros ≥ 0.
 *
 * 017 (FR-024): en los dos conceptos de caché, `null` significa **el proveedor no informa de este
 * concepto**, que no es lo mismo que `0`, «cero medido».
 *
 * **El `null` sale de la tabla de capacidades del proveedor, nunca de un campo ausente en una
 * respuesta.** Anthropic sí informa de la escritura de caché; cuando una respuesta concreta no
 * escribió nada el campo llega ausente, y eso es un cero medido. Mapearlo a `null` haría que el
 * panel dijese «sin dato» de un proveedor que sí informa, que es justo al contrario de lo que
 * FR-024 pide.
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite: number | null;
  cacheRead: number | null;
}

/**
 * Consumo de una respuesta (R2; 017, FR-025).
 *
 * `calls` son las llamadas **con respuesta**, no las que informaron tokens: el significado se
 * precisa sin cambiar, porque hasta la 017 toda llamada con respuesta informaba tokens y el
 * histórico queda con `unmeasuredCalls = 0`, que es exactamente lo que ocurrió.
 */
export interface ResponseUsage {
  calls: number;
  /** De esas, las que no informaron ningún token. Invariante: `unmeasuredCalls <= calls`. */
  unmeasuredCalls: number;
  tokens: TokenUsage;
}

/** `transcription`: un audio transcrito, valorado por minutos (012, R6). */
export type UsagePurpose = 'reply' | 'handoff_summary' | 'transcription';

export interface UsageRecordInput {
  channel: Channel;
  purpose: UsagePurpose;
  model: string;
  usage: ResponseUsage;
  at: Date;
  /** Zona IANA del negocio: da el día local del registro (R6). */
  timezone: string;
}

/** Precio vigente de un modelo, en millonésimas de la moneda por millón de tokens. */
export interface ModelPrice {
  model: string;
  inputMicros: bigint;
  outputMicros: bigint;
  cacheWriteMicros: bigint;
  cacheReadMicros: bigint;
}

export interface UsageSettings {
  currency: string;
  capEnabled: boolean;
  monthlyCapCents: number | null;
}

export type SpendCapLevel = 'none' | 'normal' | 'warning' | 'reached';

export interface SpendCapState {
  level: SpendCapLevel;
  /** Gasto del mes local en la moneda actual, en billonésimas. */
  spentPico: bigint;
  capCents: number | null;
  currency: string;
  /** Porcentaje del tope consumido, redondeado hacia abajo; nulo sin tope. */
  percent: number | null;
}

// ---------------------------------------------------------------------------
// Protección frente a abuso (012, data-model.md §2.1 y §2.3)
// ---------------------------------------------------------------------------

/**
 * Motivos por los que los clientes finales reciben solo el contacto (FR-001, FR-004, FR-008).
 * `stt_unpriced` solo afecta a los audios.
 */
export type ContactOnlyReason =
  | 'cap_disabled'
  | 'model_unpriced'
  | 'stt_unpriced'
  | 'spend_unreadable'
  // 017 (FR-005b): el proveedor rechaza la credencial. Degrada por el mismo camino que un modelo
  // sin precio, y la instancia sale sola del degradado cuando la credencial vuelva a servir.
  | 'llm_key_rejected';

/** Por qué un canal no puede llamar al modelo ahora. */
export type CapReason = ContactOnlyReason | 'spend_cap' | 'whatsapp_daily';

/** Límites de las derivaciones de la instancia (`handoff_limits`, R7). */
export interface HandoffLimits {
  /** Derivaciones nuevas por día local (1–200). */
  dailyMax: number;
  /** Minutos entre avisos de una misma derivación (5–240). */
  forwardIntervalMinutes: number;
  /** Avisos al negocio por día local (10–500). */
  noticesDailyMax: number;
}

/** Estado de protección: se calcula en cada comprobación y nunca se guarda (R1, R2). */
export interface ProtectionState {
  production: boolean;
  contactOnly: ContactOnlyReason[];
  /** Nivel del tope de gasto (010); `null` si no se pudo leer. */
  spendCap: SpendCapState | null;
  whatsapp: { today: number; cap: number; reached: boolean } | null;
  /** Contadores de derivación del día local; `null` si no se pudieron leer. */
  handoffs: {
    started: number;
    refused: number;
    notices: number;
    held: number;
    limits: HandoffLimits;
  } | null;
  /** Modelos que nombran los avisos críticos (sin precio). */
  unpricedModels: { llm: string | null; stt: string | null };
}

/** Totales de un grupo de registros (un canal, los clientes finales o la instancia). */
export interface UsageRow {
  calls: number;
  replies: number;
  summaries: number;
  tokens: TokenUsage;
  /** Coste valorado por moneda, en billonésimas. */
  cost: Map<string, bigint>;
  /** Modelos con algún registro sin precio en el grupo (US2-4). */
  unpricedModels: string[];
}

export interface UsageSummary {
  period: { first: string; last: string };
  byChannel: Record<Channel, UsageRow>;
  /** WhatsApp + web. */
  customers: UsageRow;
  /** Los tres canales. */
  instance: UsageRow;
  byDay?: Array<{ day: string; row: UsageRow }>;
}

export const ZERO_TOKENS: TokenUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

/**
 * Suma de dos conceptos de caché tratando `null` como **sin dato**, no como cero (017, FR-024):
 * `null + null` sigue siendo `null`, y `null + n` es `n`, con lo que el concepto queda
 * **parcialmente medido**. Sumar el `null` como cero lo convertiría en un dato que nadie midió, y
 * el total diría que es exacto cuando no lo es.
 */
function addCacheConcept(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: addCacheConcept(a.cacheWrite, b.cacheWrite),
    cacheRead: addCacheConcept(a.cacheRead, b.cacheRead),
  };
}
