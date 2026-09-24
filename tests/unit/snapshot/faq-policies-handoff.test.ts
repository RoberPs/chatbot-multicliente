import { describe, expect, it } from 'vitest';
import { buildSnapshot } from '../../../src/knowledge/snapshot.js';
import { emptyState, slot } from '../../helpers/state.js';

describe('snapshot: FAQ, políticas, tono y derivación (US4)', () => {
  it('FAQ en el orden recibido, sin ids', () => {
    const snap = buildSnapshot(
      emptyState({
        faqs: [
          { id: '1', question: '¿Aparcamiento?', answer: 'Sí', sortOrder: 0, updatedAt: 'x' },
          { id: '2', question: '¿Tarjeta?', answer: 'Sí', sortOrder: 1, updatedAt: 'x' },
        ],
      }),
    );
    expect(snap.faqs).toEqual([
      { question: '¿Aparcamiento?', answer: 'Sí' },
      { question: '¿Tarjeta?', answer: 'Sí' },
    ]);
  });

  it('políticas y tono guardados', () => {
    const snap = buildSnapshot(
      emptyState({
        policies: {
          cancellationText: 'Avisa con 24 h',
          cancellationNoticeMinutes: 1440,
          minAdvanceMinutes: 120,
          maxAdvanceMinutes: 43200,
          paymentMethods: ['Efectivo', 'Tarjeta'],
          updatedAt: 'x',
        },
        tone: { addressForm: 'formal', styleDescription: 'Cercano', updatedAt: 'x' },
      }),
    );
    expect(snap.policies).toEqual({
      cancellationText: 'Avisa con 24 h',
      cancellationNoticeMinutes: 1440,
      minAdvanceMinutes: 120,
      maxAdvanceMinutes: 43200,
      paymentMethods: ['Efectivo', 'Tarjeta'],
    });
    expect(snap.tone).toEqual({ addressForm: 'formal', styleDescription: 'Cercano' });
  });

  it('derivación configurada: canales por orden de preferencia y horario', () => {
    const snap = buildSnapshot(
      emptyState({
        handoff: {
          channels: [
            { id: 'b', type: 'email', value: 'a@b.es', sortOrder: 1 },
            { id: 'a', type: 'whatsapp', value: '+34611222333', sortOrder: 0 },
          ],
          hours: [slot(1, '10:00', '13:00')],
          updatedAt: 'x',
        },
      }),
    );
    expect(snap.handoff).toEqual({
      source: 'configured',
      channels: [
        { type: 'whatsapp', value: '+34611222333' },
        { type: 'email', value: 'a@b.es' },
      ],
      hours: [slot(1, '10:00', '13:00')],
    });
  });

  it('derivación con el teléfono del negocio', () => {
    const state = emptyState();
    state.business.phone = '+34600123456';
    expect(buildSnapshot(state).handoff).toEqual({
      source: 'business_phone',
      channels: [{ type: 'phone', value: '+34600123456' }],
      hours: [],
    });
  });

  it('sin derivación', () => {
    expect(buildSnapshot(emptyState()).handoff).toEqual({
      source: 'none',
      channels: [],
      hours: [],
    });
  });
});
