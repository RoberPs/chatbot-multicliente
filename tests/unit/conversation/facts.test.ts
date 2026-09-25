import { describe, expect, it } from 'vitest';
import { buildAllowedFacts, deriveFacts, localNow } from '../../../src/conversation/facts.js';
import { buildSnapshot } from '../../../src/knowledge/snapshot.js';
import { activeSnapshot, activeState } from '../../helpers/snapshot.js';
import { service, slot } from '../../helpers/state.js';

const T = '2026-09-24T10:00:00.000000Z';
const closure = (
  startDate: string,
  endDate: string,
  reason: string | null,
  startTime: string | null = null,
  endTime: string | null = null,
) => ({ id: startDate, startDate, endDate, startTime, endTime, reason, updatedAt: T });

describe('hechos derivados: hora local', () => {
  it('fecha, hora y día en la zona del negocio', () => {
    // Jueves 24/09/2026 08:30 UTC = 10:30 en Madrid (CEST).
    expect(localNow(new Date('2026-09-24T08:30:00Z'), 'Europe/Madrid')).toEqual({
      date: '2026-09-24',
      time: '10:30',
      weekday: 4,
      timezone: 'Europe/Madrid',
    });
    // La misma hora en Nueva York es la víspera por la noche.
    expect(localNow(new Date('2026-09-24T02:00:00Z'), 'America/New_York')).toMatchObject({
      date: '2026-09-23',
      time: '22:00',
      weekday: 3,
    });
  });

  it('cambio de hora de verano (Madrid, 25/10/2026)', () => {
    // A las 01:00 UTC se pasa de CEST (+2) a CET (+1): las 02:30 locales se repiten.
    expect(localNow(new Date('2026-10-25T00:30:00Z'), 'Europe/Madrid').time).toBe('02:30');
    expect(localNow(new Date('2026-10-25T01:30:00Z'), 'Europe/Madrid').time).toBe('02:30');
    expect(localNow(new Date('2026-10-25T02:30:00Z'), 'Europe/Madrid').time).toBe('03:30');
    // Primavera (29/03/2026): de las 01:59 se pasa a las 03:00.
    expect(localNow(new Date('2026-03-29T00:59:00Z'), 'Europe/Madrid').time).toBe('01:59');
    expect(localNow(new Date('2026-03-29T01:00:00Z'), 'Europe/Madrid').time).toBe('03:00');
  });
});

describe('hechos derivados: abierto ahora y próximos 14 días', () => {
  // Jueves 24/09/2026. Semana típica: L–V 9–14 y 16–20, S 10–14.
  const at = (local: string) => new Date(`${local}+02:00`);

  it('abierto dentro de una franja; cerrado entre franjas y en domingo', () => {
    const snapshot = activeSnapshot();
    expect(deriveFacts(snapshot, at('2026-09-24T10:00:00')).openNow).toBe(true);
    expect(deriveFacts(snapshot, at('2026-09-24T15:00:00')).openNow).toBe(false);
    expect(deriveFacts(snapshot, at('2026-09-24T14:00:00')).openNow).toBe(false);
    expect(deriveFacts(snapshot, at('2026-09-27T11:00:00')).openNow).toBe(false);
  });

  it('cierre total y parcial', () => {
    const snapshot = buildSnapshot(
      activeState({
        closures: [
          closure('2026-09-24', '2026-09-24', 'Inventario'),
          closure('2026-09-25', '2026-09-25', 'Formación', '16:00', '20:00'),
        ],
      }),
    );
    expect(deriveFacts(snapshot, at('2026-09-24T10:00:00')).openNow).toBe(false);
    expect(deriveFacts(snapshot, at('2026-09-25T10:00:00')).openNow).toBe(true);
    expect(deriveFacts(snapshot, at('2026-09-25T17:00:00')).openNow).toBe(false);
  });

  it('next14Days con franjas efectivas y motivo del cierre', () => {
    const snapshot = buildSnapshot(
      activeState({
        closures: [
          closure('2026-09-26', '2026-09-26', 'Fiesta local'),
          closure('2026-09-28', '2026-09-28', null, '09:00', '14:00'),
        ],
      }),
    );
    const days = deriveFacts(snapshot, at('2026-09-24T10:00:00')).next14Days;
    expect(days).toHaveLength(14);
    expect(days[0]).toEqual({
      date: '2026-09-24',
      weekday: 4,
      intervals: [
        { start: '09:00', end: '14:00' },
        { start: '16:00', end: '20:00' },
      ],
      closureReason: null,
    });
    expect(days[2]).toEqual({
      date: '2026-09-26',
      weekday: 6,
      intervals: [],
      closureReason: 'Fiesta local',
    });
    expect(days[3]).toMatchObject({ date: '2026-09-27', weekday: 7, intervals: [] });
    expect(days[4]).toMatchObject({
      date: '2026-09-28',
      intervals: [{ start: '16:00', end: '20:00' }],
    });
    expect(days[13]?.date).toBe('2026-10-07');
  });

  it('horario del contacto de derivación como texto', () => {
    const snapshot = buildSnapshot(
      activeState({
        handoff: {
          channels: [{ id: 'a', type: 'phone', value: '+34911223344', sortOrder: 0 }],
          hours: [slot(1, '09:00', '13:00'), slot(2, '09:00', '13:00'), slot(3, '09:00', '13:00')],
          updatedAt: T,
        },
      }),
    );
    expect(deriveFacts(snapshot, at('2026-09-24T10:00:00')).handoffHoursText).toBe(
      'lunes a miércoles de 9:00 a 13:00',
    );
  });
});

describe('AllowedFacts', () => {
  const snapshot = buildSnapshot(
    activeState({
      closures: [closure('2026-12-25', '2026-12-26', 'Navidad')],
      faqs: [
        {
          id: 'f1',
          question: '¿Hay descuento?',
          answer:
            'Un 15 % los martes. Aparcamiento a 200 metros. Más info en https://example.com/info',
          sortOrder: 0,
          updatedAt: T,
        },
      ],
      policies: {
        cancellationText: 'Avisa con antelación.',
        cancellationNoticeMinutes: 1440,
        minAdvanceMinutes: 120,
        maxAdvanceMinutes: 43200,
        paymentMethods: ['efectivo'],
        updatedAt: T,
      },
    }),
  );
  const derived = deriveFacts(snapshot, new Date('2026-09-24T08:00:00Z'));
  const allowed = buildAllowedFacts(snapshot, derived);

  it('horas de las franjas y la hora actual', () => {
    for (const t of ['09:00', '14:00', '16:00', '20:00', '10:00'])
      expect(allowed.times).toContain(t);
  });

  it('fechas de los cierres y de los próximos 14 días', () => {
    for (const d of ['12-25', '12-26', '09-24', '10-07']) expect(allowed.dates).toContain(d);
  });

  it('duraciones y antelaciones en minutos y en horas o días', () => {
    // Duraciones de servicio: 30 y 90 minutos.
    for (const n of ['30', '90', '1.5', '1']) expect(allowed.numbers).toContain(n);
    // 1440 min = 24 h = 1 día; 120 min = 2 h; 43200 min = 720 h = 30 días.
    for (const n of ['1440', '24', '120', '2', '43200', '720'])
      expect(allowed.numbers).toContain(n);
    expect(allowed.numbers).toContain('30');
  });

  it('números de la dirección, de las FAQ y URLs', () => {
    for (const n of ['12', '28013', '3', '15', '200']) expect(allowed.numbers).toContain(n);
    expect(allowed.urls).toContain('https://example.com/info');
  });

  it('teléfonos del negocio y del contacto', () => {
    expect(allowed.phones).toContain('34910000000');
    expect(allowed.phones).toContain('910000000');
    expect(allowed.phones).toContain('34611222333');
  });

  it('importes de los servicios en céntimos y su valor en unidades', () => {
    // Básico 25 € fijo y Completo desde 40 €; Especial es "a consultar".
    expect([...allowed.amountsCents].sort()).toEqual([2500, 4000]);
    for (const n of ['25', '40']) expect(allowed.numbers).toContain(n);
  });
});

describe('hechos derivados: precios (US2)', () => {
  const ids = {
    fixed: '00000000-0000-4000-8000-00000000a001',
    from: '00000000-0000-4000-8000-00000000a002',
    onRequest: '00000000-0000-4000-8000-00000000a003',
    missing: '00000000-0000-4000-8000-00000000a004',
    decimals: '00000000-0000-4000-8000-00000000a005',
  };
  const base = activeState();
  const snapshot = buildSnapshot({
    ...base,
    services: [
      ...base.services,
      service({ id: ids.missing, name: 'Sin precio', priceType: 'fixed', priceCents: null }),
      service({ id: ids.decimals, name: 'Grande', priceType: 'fixed', priceCents: 125_050 }),
    ],
  });
  const derived = deriveFacts(snapshot, new Date('2026-09-24T08:00:00Z'));

  it('un texto por servicio según su tipo, en la moneda del negocio', () => {
    expect(derived.prices).toEqual([
      { serviceId: ids.fixed, text: '25,00 €' },
      { serviceId: ids.from, text: 'desde 40,00 €' },
      { serviceId: ids.onRequest, text: 'a consultar' },
      { serviceId: ids.missing, text: 'sin importe registrado' },
      { serviceId: ids.decimals, text: '1250,50 €' },
    ]);
  });

  it('otra moneda', () => {
    const usd = buildSnapshot({ ...base, business: { ...base.business, currency: 'USD' } });
    expect(deriveFacts(usd, new Date('2026-09-24T08:00:00Z')).prices[0]?.text).toBe('25,00 US$');
  });

  it('AllowedFacts incluye los importes registrados y nada de los que no tienen', () => {
    const allowed = buildAllowedFacts(snapshot, derived);
    expect([...allowed.amountsCents].sort((a, b) => a - b)).toEqual([2500, 4000, 125_050]);
    for (const n of ['25', '40', '1250.5']) expect(allowed.numbers).toContain(n);
  });
});
