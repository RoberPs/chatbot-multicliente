/** 003, FR-009 y SC-004: resúmenes de la portada (data-model, "Resumen de sección"). */
import { describe, expect, it } from 'vitest';
import { sectionSummaries } from '../../../src/admin/section-summaries.js';
import type { PoliciesRecord } from '../../../src/knowledge/types.js';
import { configuredHandoff, emptyState } from '../../helpers/state.js';

const T = '2026-09-24T10:00:00.000000Z';

const policies = (overrides: Partial<PoliciesRecord> = {}): PoliciesRecord => ({
  cancellationText: null,
  cancellationNoticeMinutes: null,
  minAdvanceMinutes: null,
  maxAdvanceMinutes: null,
  paymentMethods: [],
  updatedAt: T,
  ...overrides,
});

describe('sectionSummaries: Políticas', () => {
  const summary = (p: PoliciesRecord | null) =>
    sectionSummaries(emptyState({ policies: p })).policies;

  it('sin fila o con todos los campos vacíos → Sin configurar', () => {
    expect(summary(null)).toBe('Sin configurar');
    expect(summary(policies())).toBe('Sin configurar');
    expect(summary(policies({ cancellationText: '  ' }))).toBe('Sin configurar');
  });

  it('formas de pago en singular y plural, con o sin política de cancelación', () => {
    expect(summary(policies({ paymentMethods: ['Efectivo', 'Tarjeta', 'Transferencia'] }))).toBe(
      '3 formas de pago · sin política de cancelación',
    );
    expect(summary(policies({ paymentMethods: ['Efectivo'] }))).toBe(
      '1 forma de pago · sin política de cancelación',
    );
    expect(summary(policies({ cancellationText: 'Avisa con 24 h' }))).toBe(
      'sin formas de pago · con política de cancelación',
    );
    expect(summary(policies({ cancellationNoticeMinutes: 1440 }))).toBe(
      'sin formas de pago · con política de cancelación',
    );
    expect(summary(policies({ minAdvanceMinutes: 60 }))).toBe(
      'sin formas de pago · sin política de cancelación',
    );
  });
});

describe('sectionSummaries: Tono', () => {
  it('sin fila → Sin configurar', () => {
    expect(sectionSummaries(emptyState()).tone).toBe('Sin configurar');
  });

  it('trato de tú o de usted, con o sin estilo propio', () => {
    const tone = (addressForm: 'informal' | 'formal', styleDescription: string | null) =>
      sectionSummaries(emptyState({ tone: { addressForm, styleDescription, updatedAt: T } })).tone;
    expect(tone('informal', null)).toBe('trato de tú');
    expect(tone('formal', null)).toBe('trato de usted');
    expect(tone('formal', 'Cercano y breve')).toBe('trato de usted · con estilo propio');
  });
});

describe('sectionSummaries: Derivación', () => {
  it('configured, business_phone y none', () => {
    expect(sectionSummaries(emptyState({ handoff: configuredHandoff() })).handoff).toBe('1 medio');
    const two = configuredHandoff();
    two?.channels.push({ id: 'x', type: 'email', value: 'a@b.es', sortOrder: 1 });
    expect(sectionSummaries(emptyState({ handoff: two })).handoff).toBe('2 medios');
    const base = emptyState();
    expect(
      sectionSummaries(emptyState({ business: { ...base.business, phone: '+34600123456' } }))
        .handoff,
    ).toBe('usa el teléfono del negocio');
    expect(sectionSummaries(base).handoff).toBe('Sin configurar');
  });
});
