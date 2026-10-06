/**
 * Tipos del consumo y coste del modelo (010, data-model.md §2). Sin textos ni identificadores de
 * cliente o conversación (FR-003). Importes en enteros: precios en millonésimas por millón de
 * tokens, costes en billonésimas (`bigint`) y tope en céntimos (research R4).
 */
import type { Channel } from '../conversation/channels.js';

/** Tokens que informa el proveedor en una llamada, o la suma de varias. Enteros ≥ 0. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Consumo de una respuesta: llamadas que informaron tokens y su suma (R2). */
export interface ResponseUsage {
  calls: number;
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
export type ContactOnlyReason = 'cap_disabled' | 'model_unpriced' | 'stt_unpriced' | 'spend_unreadable';

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

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}
