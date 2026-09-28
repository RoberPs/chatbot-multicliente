/**
 * Catálogo completo de avisos (contracts/warnings.md, SC-004): al menos un caso por código
 * y todas las filas de la tabla de ejemplos, encadenadas como en el contrato.
 */
import { describe, expect, it } from 'vitest';
import { computeWarnings } from '../../../src/knowledge/warnings.js';
import type { KnowledgeState, Warning } from '../../../src/knowledge/types.js';
import {
  bothAlertRoutes,
  configuredHandoff,
  emptyState,
  resource,
  service,
  slot,
  typicalWeek,
} from '../../helpers/state.js';

const codes = (state: KnowledgeState) => computeWarnings(state).map((w) => w.code);
const summary = (state: KnowledgeState) =>
  computeWarnings(state).map((w) => `${w.code}:${w.target.label}`);

describe('catálogo de avisos: tabla de ejemplos del contrato', () => {
  const state = emptyState();

  it('instancia recién creada', () => {
    expect(codes(state)).toEqual([
      'HANDOFF_UNREACHABLE',
      'BUSINESS_HOURS_MISSING',
      'HANDOFF_ALERTS_NONE',
    ]);
  });

  it('+ teléfono del negocio', () => {
    state.business.phone = '+34600123456';
    expect(codes(state).sort()).toEqual([
      'BUSINESS_HOURS_MISSING',
      'HANDOFF_ALERTS_NONE',
      'HANDOFF_CONTACT_MISSING',
    ]);
  });

  it('+ horario + contacto de derivación → solo falta avisar al negocio (005)', () => {
    state.businessHours = typicalWeek();
    state.handoff = configuredHandoff();
    expect(codes(state)).toEqual(['HANDOFF_ALERTS_NONE']);
  });

  it('+ las dos vías de aviso al negocio → ninguno', () => {
    state.handoffAlerts = bothAlertRoutes();
    expect(codes(state)).toEqual([]);
  });

  const corte = service({ name: 'Corte', bookable: true, durationMinutes: null });
  it('+ servicio "Corte" reservable sin duración', () => {
    state.services.push(corte);
    expect(summary(state)).toEqual(['SERVICE_DURATION_MISSING:Corte']);
    const [w] = computeWarnings(state);
    expect(w).toMatchObject({ target: { kind: 'service', id: corte.id }, field: 'duration' });
  });

  it('+ servicio "Revisión" precio fijo sin importe', () => {
    state.services.push(
      service({ name: 'Revisión', bookable: false, priceType: 'fixed', priceCents: null }),
    );
    expect(summary(state)).toContain('SERVICE_PRICE_MISSING:Revisión');
    expect(computeWarnings(state).find((w) => w.code === 'SERVICE_PRICE_MISSING')?.field).toBe(
      'price',
    );
  });

  it('+ servicio "Presupuesto" a consultar sin importe → ninguno nuevo', () => {
    const before = codes(state);
    state.services.push(
      service({ name: 'Presupuesto', bookable: false, priceType: 'on_request', priceCents: null }),
    );
    expect(codes(state)).toEqual(before);
  });

  const profesional = resource({ name: 'Profesional 1' });
  it('+ recurso que no presta "Corte" → SERVICE_WITHOUT_RESOURCE (Corte)', () => {
    state.resources.push(profesional);
    expect(summary(state)).toContain('SERVICE_WITHOUT_RESOURCE:Corte');
    expect(
      computeWarnings(state).filter((w) => w.code === 'SERVICE_WITHOUT_RESOURCE'),
    ).toHaveLength(1);
  });

  it('franja del recurso el sábado 16:00–18:00 con el negocio cerrado el sábado por la tarde', () => {
    profesional.hours = [slot(1, '09:00', '14:00'), slot(6, '16:00', '18:00')];
    const warning = computeWarnings(state).find(
      (w) => w.code === 'RESOURCE_HOURS_OUTSIDE_BUSINESS',
    );
    expect(warning).toMatchObject({
      severity: 'normal',
      target: { kind: 'resource', id: profesional.id, label: 'Profesional 1' },
      field: 'hours',
      details: { slots: [{ weekday: 6, start: '16:00', end: '18:00' }] },
    });
    expect(warning?.message).toContain('sáb 16:00–18:00');
  });

  it('se desactiva "Corte" → desaparecen sus avisos', () => {
    corte.active = false;
    expect(computeWarnings(state).filter((w) => w.target.label === 'Corte')).toEqual([]);
  });

  it('todos los recursos desactivados y "Corte" reservable activo → SERVICE_WITHOUT_RESOURCE', () => {
    corte.active = true;
    corte.durationMinutes = 30;
    profesional.serviceIds = [corte.id];
    expect(codes(state)).not.toContain('SERVICE_WITHOUT_RESOURCE');
    profesional.active = false;
    expect(summary(state)).toContain('SERVICE_WITHOUT_RESOURCE:Corte');
  });
});

describe('catálogo de avisos: reglas generales', () => {
  it('ordena críticos primero, después por tipo y nombre', () => {
    const state = emptyState({
      services: [
        service({ name: 'Zeta', durationMinutes: null }),
        service({ name: 'Alfa', durationMinutes: null }),
      ],
    });
    expect(summary(state)).toEqual([
      'HANDOFF_UNREACHABLE:Contacto de derivación',
      'BUSINESS_HOURS_MISSING:Negocio',
      'HANDOFF_ALERTS_NONE:Avisos al negocio',
      'SERVICE_DURATION_MISSING:Alfa',
      'SERVICE_DURATION_MISSING:Zeta',
    ]);
  });

  it('servicios y recursos inactivos no generan avisos', () => {
    const state = emptyState({
      businessHours: typicalWeek(),
      handoff: configuredHandoff(),
      handoffAlerts: bothAlertRoutes(),
      services: [service({ active: false, durationMinutes: null, priceCents: null })],
      resources: [resource({ active: false, hours: [slot(7, '10:00', '12:00')] })],
    });
    expect(codes(state)).toEqual([]);
  });

  it('RESOURCE_HOURS_OUTSIDE_BUSINESS no se evalúa sin horario del negocio', () => {
    const state = emptyState({
      handoff: configuredHandoff(),
      handoffAlerts: bothAlertRoutes(),
      resources: [resource({ hours: [slot(7, '10:00', '12:00')] })],
    });
    expect(codes(state)).toEqual(['BUSINESS_HOURS_MISSING']);
  });

  it('RESOURCE_HOURS_OUTSIDE_BUSINESS lista solo la parte fuera de horario', () => {
    const state = emptyState({
      businessHours: typicalWeek(),
      handoff: configuredHandoff(),
      handoffAlerts: bothAlertRoutes(),
      resources: [resource({ name: 'R', hours: [slot(1, '08:00', '15:00')] })],
    });
    const [w] = computeWarnings(state) as [Warning];
    expect(w.details).toEqual({
      slots: [
        { weekday: 1, start: '08:00', end: '09:00' },
        { weekday: 1, start: '14:00', end: '15:00' },
      ],
    });
  });

  it('sin recursos no hay aviso SERVICE_WITHOUT_RESOURCE (agenda única)', () => {
    const state = emptyState({ services: [service({ name: 'A' })] });
    expect(codes(state)).not.toContain('SERVICE_WITHOUT_RESOURCE');
  });

  it('HANDOFF_CONTACT_MISSING y HANDOFF_UNREACHABLE son excluyentes', () => {
    const none = emptyState();
    const phone = emptyState();
    phone.business.phone = '+34600123456';
    for (const s of [none, phone]) {
      const handoffCodes = codes(s).filter(
        (c) => c === 'HANDOFF_CONTACT_MISSING' || c === 'HANDOFF_UNREACHABLE',
      );
      expect(handoffCodes).toHaveLength(1);
    }
  });

  it('cada aviso identifica elemento, dato y mensaje', () => {
    const state = emptyState({ services: [service({ name: 'A', durationMinutes: null })] });
    for (const w of computeWarnings(state)) {
      expect(w.target.label).not.toBe('');
      expect(w.field).toBeTruthy();
      expect(w.message.length).toBeGreaterThan(10);
    }
  });

  it('el enlace a mapa no genera avisos, con o sin dirección (003, FR-015)', () => {
    const base = () => {
      const s = emptyState({
        businessHours: typicalWeek(),
        handoff: configuredHandoff(),
        handoffAlerts: bothAlertRoutes(),
      });
      s.business.phone = '+34600123456';
      return s;
    };
    const withoutUrl = base();
    const withUrl = base();
    withUrl.business.mapUrl = 'https://maps.example.com/@40.41,-3.70,17z?q=Plaza+Mayor';
    const withAddress = base();
    withAddress.business.address = 'Calle Mayor 1';
    expect(codes(withoutUrl)).toEqual([]);
    expect(codes(withUrl)).toEqual([]);
    expect(codes(withAddress)).toEqual([]);
  });
});
