import type {
  BusinessStatus,
  EffectiveHandoff,
  HandoffChange,
  HandoffChannel,
  KnowledgeState,
} from './types.js';

/**
 * Contacto de derivación efectivo (FR-018, FR-019):
 * el configurado si tiene algún medio; si no, el teléfono del negocio; si no, ninguno.
 */
export function effectiveHandoff(state: KnowledgeState): EffectiveHandoff {
  const configured = state.handoff;
  if (configured && configured.channels.length > 0) {
    return {
      source: 'configured',
      channels: [...configured.channels]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((c) => ({ type: c.type, value: c.value })),
      hours: configured.hours,
    };
  }
  if (state.business.phone) {
    return {
      source: 'business_phone',
      channels: [{ type: 'phone', value: state.business.phone }],
      hours: [],
    };
  }
  return { source: 'none', channels: [], hours: [] };
}

const channelKey = (channels: HandoffChannel[]): string =>
  channels.map((c) => `${c.type}:${c.value}`).join('|');

/** Mismo medio y orden (003, FR-006). El horario de atención no cuenta. */
export function sameChannels(a: HandoffChannel[], b: HandoffChannel[]): boolean {
  return channelKey(a) === channelKey(b);
}

/** Dos contactos son el mismo si coinciden el origen y la lista ordenada de medios. */
export function sameContact(a: EffectiveHandoff, b: EffectiveHandoff): boolean {
  return a.source === b.source && sameChannels(a.channels, b.channels);
}

/** Cambio del contacto que usa el bot tras un guardado (003, FR-006, FR-007). */
export function describeHandoffChange(
  before: EffectiveHandoff,
  after: EffectiveHandoff,
  touched: boolean,
  status: BusinessStatus,
): HandoffChange {
  return { before, after, touched, status };
}
