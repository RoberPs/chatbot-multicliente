/** 003, FR-005 – FR-007 y SC-003: textos del contacto que usa el bot (contracts/admin-panel.md). */
import { describe, expect, it } from 'vitest';
import {
  effectiveHandoffNotice,
  formatChannels,
  handoffChangeMessage,
} from '../../../src/admin/handoff-notice.js';
import type { EffectiveHandoff, HandoffChange } from '../../../src/knowledge/types.js';

const configured: EffectiveHandoff = {
  source: 'configured',
  channels: [
    { type: 'phone', value: '+34600111222' },
    { type: 'whatsapp', value: '+34611222333' },
    { type: 'email', value: 'ayuda@ejemplo.es' },
  ],
  hours: [],
};
const businessPhone: EffectiveHandoff = {
  source: 'business_phone',
  channels: [{ type: 'phone', value: '+34600123456' }],
  hours: [],
};
const none: EffectiveHandoff = { source: 'none', channels: [], hours: [] };

const change = (
  before: EffectiveHandoff,
  after: EffectiveHandoff,
  touched: boolean,
): HandoffChange => ({ before, after, touched, status: 'draft' });

const CONTACT = 'Teléfono +34600111222, WhatsApp +34611222333, Email ayuda@ejemplo.es';

describe('formatChannels', () => {
  it('cada medio con su tipo, en orden', () => {
    expect(formatChannels(configured.channels)).toBe(CONTACT);
  });
});

describe('effectiveHandoffNotice (recuadro)', () => {
  it('configured', () => {
    expect(effectiveHandoffNotice(configured)).toEqual({
      lead: 'El bot pasa las conversaciones a:',
      contact: CONTACT,
      note: 'Origen: contacto de derivación configurado.',
      none: false,
    });
  });

  it('business_phone', () => {
    expect(effectiveHandoffNotice(businessPhone)).toEqual({
      lead: 'El bot pasa las conversaciones a:',
      contact: '+34600123456',
      note: 'Origen: teléfono del negocio, porque no hay contacto de derivación configurado.',
      none: false,
    });
  });

  it('none', () => {
    expect(effectiveHandoffNotice(none)).toEqual({
      lead: 'El bot no tiene a quién pasar las conversaciones.',
      contact: null,
      note: 'Registra un contacto de derivación o el teléfono del negocio.',
      none: true,
    });
  });
});

describe('handoffChangeMessage (flash)', () => {
  it('sin cambios en el contacto ni en teléfono o medios → Guardado', () => {
    expect(handoffChangeMessage(change(configured, configured, false), 'business')).toBe(
      'Guardado',
    );
    expect(handoffChangeMessage(change(none, none, false), 'handoff')).toBe('Guardado');
  });

  it('(a) nuevo origen configured', () => {
    expect(handoffChangeMessage(change(businessPhone, configured, true), 'handoff')).toBe(
      `Guardado. A partir de ahora el bot pasa las conversaciones al contacto de derivación configurado: ${CONTACT}.`,
    );
  });

  it('(a) nuevo origen business_phone', () => {
    expect(handoffChangeMessage(change(configured, businessPhone, true), 'handoff')).toBe(
      'Guardado. No hay contacto de derivación configurado, así que el bot pasa las conversaciones al teléfono del negocio: +34600123456.',
    );
  });

  it('(a) un teléfono del negocio distinto también es un contacto nuevo', () => {
    const other: EffectiveHandoff = {
      ...businessPhone,
      channels: [{ type: 'phone', value: '+34600999999' }],
    };
    expect(handoffChangeMessage(change(businessPhone, other, true), 'business')).toBe(
      'Guardado. No hay contacto de derivación configurado, así que el bot pasa las conversaciones al teléfono del negocio: +34600999999.',
    );
  });

  it('(a) nuevo origen none en preparación (FR-007)', () => {
    expect(handoffChangeMessage(change(businessPhone, none, true), 'business')).toBe(
      'Guardado. El negocio se ha quedado sin salida a una persona: el bot no tiene a quién pasar las conversaciones. No se podrá activar hasta que registres un contacto de derivación o el teléfono del negocio.',
    );
  });

  it('(b) Datos: cambia el teléfono y el origen sigue siendo configured', () => {
    expect(handoffChangeMessage(change(configured, configured, true), 'business')).toBe(
      `Guardado. El teléfono del negocio no se usa para pasar conversaciones porque hay un contacto de derivación configurado; el bot sigue pasándolas a: ${CONTACT}.`,
    );
  });

  it('(b) Derivación: cambian los medios guardados y el contacto no cambia', () => {
    expect(handoffChangeMessage(change(configured, configured, true), 'handoff')).toBe(
      `Guardado. El bot sigue pasando las conversaciones a: ${CONTACT} (contacto de derivación configurado).`,
    );
    expect(handoffChangeMessage(change(businessPhone, businessPhone, true), 'handoff')).toBe(
      'Guardado. El bot sigue pasando las conversaciones a: +34600123456 (teléfono del negocio).',
    );
  });
});
