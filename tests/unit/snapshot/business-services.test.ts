import { describe, expect, it } from 'vitest';
import { buildSnapshot } from '../../../src/knowledge/snapshot.js';
import { emptyState, service, typicalWeek } from '../../helpers/state.js';

describe('snapshot: negocio, horario y servicios (US1)', () => {
  it('datos del negocio con null en campos vacíos', () => {
    const state = emptyState();
    state.business.name = 'Mi negocio';
    state.business.address = '';
    const snap = buildSnapshot(state);
    expect(snap.business).toEqual({
      name: 'Mi negocio',
      address: null,
      directions: null,
      mapUrl: null,
      phone: null,
      email: null,
      timezone: 'Europe/Madrid',
      currency: 'EUR',
    });
    expect(snap.status).toBe('draft');
  });

  it('incluye horario y cierres', () => {
    const state = emptyState({
      businessHours: typicalWeek(),
      closures: [
        {
          id: 'c1',
          startDate: '2026-12-25',
          endDate: '2026-12-25',
          startTime: null,
          endTime: null,
          reason: 'Navidad',
          updatedAt: 'x',
        },
      ],
    });
    const snap = buildSnapshot(state);
    expect(snap.openingHours).toHaveLength(11);
    expect(snap.closures).toEqual([
      {
        startDate: '2026-12-25',
        endDate: '2026-12-25',
        startTime: null,
        endTime: null,
        reason: 'Navidad',
      },
    ]);
  });

  it('precio: fijo, desde, a consultar y no registrado', () => {
    const state = emptyState({
      services: [
        service({ name: 'A', priceType: 'fixed', priceCents: 2000 }),
        service({ name: 'B', priceType: 'from', priceCents: 4000 }),
        service({ name: 'C', priceType: 'on_request', priceCents: null }),
        service({ name: 'D', priceType: 'fixed', priceCents: null }),
      ],
    });
    expect(buildSnapshot(state).services.map((s) => s.price)).toEqual([
      { type: 'fixed', amountCents: 2000 },
      { type: 'from', amountCents: 4000 },
      { type: 'on_request' },
      { type: 'missing' },
    ]);
  });

  it('reservable efectivo sin recursos = activo + reservable + con duración', () => {
    const state = emptyState({
      services: [
        service({ name: 'A', bookable: true, durationMinutes: 30 }),
        service({ name: 'B', bookable: true, durationMinutes: null }),
        service({ name: 'C', bookable: false, durationMinutes: 30 }),
      ],
    });
    const snap = buildSnapshot(state);
    expect(snap.services.map((s) => [s.name, s.bookable, s.resourceIds])).toEqual([
      ['A', true, []],
      ['B', false, []],
      ['C', false, []],
    ]);
    expect(snap.scheduling).toEqual({ mode: 'single_agenda' });
  });

  it('excluye servicios inactivos y respeta el orden recibido (sort_order)', () => {
    const state = emptyState({
      services: [
        service({ name: 'Primero', sortOrder: 0 }),
        service({ name: 'Oculto', active: false, sortOrder: 1 }),
        service({ name: 'Segundo', sortOrder: 2 }),
      ],
    });
    expect(buildSnapshot(state).services.map((s) => s.name)).toEqual(['Primero', 'Segundo']);
  });

  it('sin políticas ni tono registrados: valores nulos, sin inventar', () => {
    const snap = buildSnapshot(emptyState());
    expect(snap.policies).toEqual({
      cancellationText: null,
      cancellationNoticeMinutes: null,
      minAdvanceMinutes: null,
      maxAdvanceMinutes: null,
      paymentMethods: [],
    });
    expect(snap.tone).toEqual({ addressForm: null, styleDescription: null });
    expect(snap.faqs).toEqual([]);
  });

  it('business.mapUrl es el enlace guardado (003, FR-014)', () => {
    const state = emptyState();
    state.business.mapUrl = 'https://maps.example.com/@40.41,-3.70,17z?q=Plaza+Mayor';
    expect(buildSnapshot(state).business.mapUrl).toBe(
      'https://maps.example.com/@40.41,-3.70,17z?q=Plaza+Mayor',
    );
  });
});
