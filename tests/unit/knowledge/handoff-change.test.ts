/** 003, FR-006: cuándo cambia el contacto que usa el bot. */
import { describe, expect, it } from 'vitest';
import { describeHandoffChange, sameContact } from '../../../src/knowledge/handoff.js';
import type { EffectiveHandoff } from '../../../src/knowledge/types.js';

const configured = (
  channels: EffectiveHandoff['channels'],
  hours: EffectiveHandoff['hours'] = [],
): EffectiveHandoff => ({ source: 'configured', channels, hours });

const wa = { type: 'whatsapp' as const, value: '+34611222333' };
const mail = { type: 'email' as const, value: 'a@b.es' };

describe('sameContact', () => {
  it('ignora el horario de atención', () => {
    expect(
      sameContact(
        configured([wa, mail]),
        configured([wa, mail], [{ weekday: 1, start: '10:00', end: '13:00' }]),
      ),
    ).toBe(true);
  });

  it('cambia si cambia el orden, un valor o el origen', () => {
    expect(sameContact(configured([wa, mail]), configured([mail, wa]))).toBe(false);
    expect(sameContact(configured([wa]), configured([{ ...wa, value: '+34611222334' }]))).toBe(
      false,
    );
    expect(
      sameContact(configured([{ type: 'phone', value: '+34600123456' }]), {
        source: 'business_phone',
        channels: [{ type: 'phone', value: '+34600123456' }],
        hours: [],
      }),
    ).toBe(false);
  });
});

describe('describeHandoffChange', () => {
  it('devuelve el antes, el después, si se tocó el teléfono o los medios y el estado', () => {
    const before = configured([wa]);
    const after: EffectiveHandoff = { source: 'none', channels: [], hours: [] };
    expect(describeHandoffChange(before, after, true, 'draft')).toEqual({
      before,
      after,
      touched: true,
      status: 'draft',
    });
  });
});
