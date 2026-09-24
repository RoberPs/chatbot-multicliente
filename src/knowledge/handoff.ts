import type { EffectiveHandoff, KnowledgeState } from './types.js';

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
