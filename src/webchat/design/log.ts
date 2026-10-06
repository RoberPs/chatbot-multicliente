/**
 * Registros del diseño del chat (011, research R12, FR-042).
 *
 * Catálogo cerrado: solo códigos del contrato. Nunca textos, colores, nombres de fichero ni
 * bytes (los da el operador).
 */
import { SLOTS, type Slot } from './defaults.js';
import type { IssueReason } from './schemas.js';

export interface DesignLogger {
  info(obj: object, msg?: string): void;
}

export type ImageOutcome = 'kept' | 'added' | 'replaced' | 'removed' | 'none';

const REASONS: readonly IssueReason[] = ['option', 'text', 'contrast', 'image'];
const IMAGE_OUTCOMES: readonly ImageOutcome[] = ['kept', 'added', 'replaced', 'removed', 'none'];

export function chatDesignSaved(
  log: DesignLogger,
  fields:
    | { outcome: 'saved'; images: Record<Slot, ImageOutcome> }
    | { outcome: 'rejected'; reasons: IssueReason[] },
): void {
  const entry: Record<string, unknown> = {
    channel: 'chat_design',
    event: 'chat_design_saved',
    outcome: fields.outcome,
  };
  if (fields.outcome === 'rejected') {
    entry.reasons = REASONS.filter((r) => fields.reasons.includes(r));
  } else {
    entry.images = Object.fromEntries(
      SLOTS.map((slot) => [
        slot,
        IMAGE_OUTCOMES.includes(fields.images[slot]) ? fields.images[slot] : 'none',
      ]),
    );
  }
  log.info(entry, 'chat_design_saved');
}

export function chatDesignReset(
  log: DesignLogger,
  fields: { outcome: 'reset' | 'nothing_to_reset' },
): void {
  log.info(
    { channel: 'chat_design', event: 'chat_design_reset', outcome: fields.outcome },
    'chat_design_reset',
  );
}
