/**
 * Puertos del dominio de la derivación (contracts/handoff-flow.md § Puertos). `src/handoff`
 * solo habla con WhatsApp, el email y el modelo a través de estas interfaces.
 */
import type { DbOrTx } from '../conversation/repositories/customer.js';
import type { TokenUsage } from '../usage/types.js';
import type { BusinessNotice, HandoffKind, RouteName } from './types.js';

export type AlertSendResult =
  { ok: true; ref: string | null; body?: string } | { ok: false; failure: string };

export interface AlertRoute {
  readonly name: RouteName;
  /** Aceptado por el proveedor = entregado (R5). No lanza: devuelve el fallo. */
  send(notice: BusinessNotice, opts: { signal: AbortSignal }): Promise<AlertSendResult>;
}

export interface HandoffSummarizer {
  /**
   * Solo textos del cliente (R4). Lanza si no hay respuesta válida en el plazo. Si el proveedor
   * responde (aunque se descarte), llama una vez a `onUsage` con sus tokens (010, R1).
   */
  summarize(
    input: { kind: HandoffKind; customerTexts: string[] },
    opts: { signal: AbortSignal; onUsage?: (usage: TokenUsage) => void },
  ): Promise<{ summary: string }>;
}

/** Vías que se pueden usar ahora: lee `handoff_alerts` sin caché y cruza con la instancia. */
export interface AlertRoutesProvider {
  /** `[]` si no hay ninguna. Con `simulate` (playground) solo la vía simulada. */
  available(tx: DbOrTx, opts: { simulate: boolean }): Promise<AlertRoute[]>;
}
