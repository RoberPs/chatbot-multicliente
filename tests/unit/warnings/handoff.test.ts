import { describe, expect, it } from 'vitest';
import { effectiveHandoff } from '../../../src/knowledge/handoff.js';
import { computeWarnings } from '../../../src/knowledge/warnings.js';
import { configuredHandoff, emptyState } from '../../helpers/state.js';

const handoffCodes = (state: Parameters<typeof computeWarnings>[0]) =>
  computeWarnings(state)
    .filter((w) => w.target.kind === 'handoff')
    .map((w) => w.code);

describe('derivación efectiva y avisos de derivación', () => {
  it('instancia vacía: sin derivación y aviso crítico HANDOFF_UNREACHABLE', () => {
    const state = emptyState();
    expect(effectiveHandoff(state)).toEqual({ source: 'none', channels: [], hours: [] });
    const [warning] = computeWarnings(state);
    expect(warning).toMatchObject({ code: 'HANDOFF_UNREACHABLE', severity: 'critical' });
  });

  it('con teléfono del negocio: se usa como derivación y aviso normal HANDOFF_CONTACT_MISSING', () => {
    const state = emptyState();
    state.business.phone = '+34600123456';
    expect(effectiveHandoff(state)).toEqual({
      source: 'business_phone',
      channels: [{ type: 'phone', value: '+34600123456' }],
      hours: [],
    });
    expect(handoffCodes(state)).toEqual(['HANDOFF_CONTACT_MISSING']);
  });

  it('con medio configurado: ningún aviso de derivación', () => {
    const state = emptyState({ handoff: configuredHandoff() });
    expect(effectiveHandoff(state).source).toBe('configured');
    expect(handoffCodes(state)).toEqual([]);
  });

  it('un contacto sin medios no cuenta como configurado', () => {
    const state = emptyState({ handoff: { channels: [], hours: [], updatedAt: 'x' } });
    expect(effectiveHandoff(state).source).toBe('none');
  });
});
