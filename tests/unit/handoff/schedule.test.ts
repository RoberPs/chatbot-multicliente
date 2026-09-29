/**
 * Horario de atención de la derivación (005, R13): franja siguiente, 2 h de horario, cierres,
 * zonas horarias y cambios de hora. Referencias: 01/10/2026 es jueves y 05/10/2026, lunes.
 */
import { describe, expect, it } from 'vitest';
import {
  addOpenMinutes,
  applicableHours,
  attentionAt,
  describeOpening,
  isOpenAt,
  nextOpening,
} from '../../../src/handoff/schedule.js';
import type {
  DateRangeBlock,
  KnowledgeSnapshot,
  WeeklySlot,
} from '../../../src/knowledge/types.js';
import { activeSnapshot } from '../../helpers/snapshot.js';

const weekdays = (start: string, end: string): WeeklySlot[] =>
  ([1, 2, 3, 4, 5] as const).map((weekday) => ({ weekday, start, end }));

/** Lunes a viernes 9–14 y 16–20; sábado 10–14. */
const BUSINESS_HOURS: WeeklySlot[] = [
  ...weekdays('09:00', '14:00'),
  ...weekdays('16:00', '20:00'),
  { weekday: 6, start: '10:00', end: '14:00' },
];

function snapshot(
  opts: {
    hours?: WeeklySlot[];
    handoffHours?: WeeklySlot[];
    closures?: DateRangeBlock[];
    timezone?: string;
  } = {},
): KnowledgeSnapshot {
  const base = activeSnapshot();
  return {
    ...base,
    business: { ...base.business, timezone: opts.timezone ?? 'Europe/Madrid' },
    openingHours: opts.hours ?? BUSINESS_HOURS,
    closures: opts.closures ?? [],
    handoff: { ...base.handoff, hours: opts.handoffHours ?? [] },
  };
}

const closure = (
  startDate: string,
  endDate: string,
  startTime: string | null = null,
  endTime: string | null = null,
): DateRangeBlock => ({ startDate, endDate, startTime, endTime, reason: null });

const at = (iso: string) => new Date(iso);

describe('horario aplicable (FR-011)', () => {
  it('el del contacto de derivación si tiene franjas; si no, el del negocio', () => {
    const own = weekdays('10:00', '13:00');
    expect(applicableHours(snapshot({ handoffHours: own }))).toEqual(own);
    expect(applicableHours(snapshot())).toEqual(BUSINESS_HOURS);
  });

  it('manda el horario del contacto de derivación aunque el negocio esté abierto', () => {
    const s = snapshot({ handoffHours: weekdays('10:00', '13:00') });
    // Jueves 9:30 en Madrid: el negocio abre, el contacto de derivación todavía no.
    const now = at('2026-10-01T07:30:00Z');
    expect(isOpenAt(s, now)).toBe(false);
    expect(nextOpening(s, now)).toEqual(at('2026-10-01T08:00:00Z'));
  });
});

describe('nextOpening', () => {
  it('abierto ahora (franja ya empezada) → null', () => {
    const now = at('2026-10-01T08:00:00Z'); // jueves 10:00
    expect(isOpenAt(snapshot(), now)).toBe(true);
    expect(nextOpening(snapshot(), now)).toBeNull();
  });

  it('entre dos franjas del mismo día → la de la tarde', () => {
    const now = at('2026-10-01T13:00:00Z'); // jueves 15:00
    expect(isOpenAt(snapshot(), now)).toBe(false);
    expect(nextOpening(snapshot(), now)).toEqual(at('2026-10-01T14:00:00Z'));
  });

  it('el fin de la franja es exclusivo', () => {
    expect(isOpenAt(snapshot(), at('2026-10-01T12:00:00Z'))).toBe(false); // jueves 14:00
  });

  it('sábado por la noche → lunes a las 9:00', () => {
    const now = at('2026-10-03T19:00:00Z'); // sábado 21:00
    expect(nextOpening(snapshot(), now)).toEqual(at('2026-10-05T07:00:00Z'));
  });

  it('cierre de día completo mañana → primera franja después del cierre', () => {
    const s = snapshot({ closures: [closure('2026-10-02', '2026-10-02')] });
    const now = at('2026-10-01T19:00:00Z'); // jueves 21:00
    expect(nextOpening(s, now)).toEqual(at('2026-10-03T08:00:00Z')); // sábado 10:00
  });

  it('cierre puntual que tapa la próxima franja → la siguiente', () => {
    const s = snapshot({ closures: [closure('2026-10-02', '2026-10-02', '09:00', '14:00')] });
    const now = at('2026-10-01T19:00:00Z');
    expect(nextOpening(s, now)).toEqual(at('2026-10-02T14:00:00Z')); // viernes 16:00
  });

  it('cierre largo sin franja en 60 días → null en los dos cálculos', () => {
    const s = snapshot({ closures: [closure('2026-10-01', '2026-12-31')] });
    const now = at('2026-10-01T08:00:00Z');
    expect(isOpenAt(s, now)).toBe(false);
    expect(nextOpening(s, now)).toBeNull();
    expect(addOpenMinutes(s, now, 120)).toBeNull();
  });

  it('otra zona horaria (America/Mexico_City)', () => {
    const s = snapshot({ timezone: 'America/Mexico_City' });
    const now = at('2026-10-02T03:00:00Z'); // jueves 21:00 en Ciudad de México
    expect(nextOpening(s, now)).toEqual(at('2026-10-02T15:00:00Z')); // viernes 9:00
  });
});

describe('negocio sin franjas', () => {
  const s = snapshot({ hours: [] });
  const now = at('2026-10-03T19:00:00Z');

  it('se considera siempre abierto', () => {
    expect(isOpenAt(s, now)).toBe(true);
    expect(nextOpening(s, now)).toBeNull();
  });

  it('addOpenMinutes cuenta en tiempo real', () => {
    expect(addOpenMinutes(s, now, 120)).toEqual(at('2026-10-03T21:00:00Z'));
  });
});

describe('addOpenMinutes (FR-019)', () => {
  it('dentro de una franja', () => {
    expect(addOpenMinutes(snapshot(), at('2026-10-01T07:00:00Z'), 120)).toEqual(
      at('2026-10-01T09:00:00Z'),
    );
  });

  it('salta la noche', () => {
    // Jueves 19:00: queda 1 h; el resto, el viernes de 9:00 a 10:00.
    expect(addOpenMinutes(snapshot(), at('2026-10-01T17:00:00Z'), 120)).toEqual(
      at('2026-10-02T08:00:00Z'),
    );
  });

  it('salta el fin de semana', () => {
    // Sábado 13:00: queda 1 h; el resto, el lunes de 9:00 a 10:00.
    expect(addOpenMinutes(snapshot(), at('2026-10-03T11:00:00Z'), 120)).toEqual(
      at('2026-10-05T08:00:00Z'),
    );
  });

  it('empezando con el negocio cerrado', () => {
    // Sábado 21:00 → lunes de 9:00 a 11:00.
    expect(addOpenMinutes(snapshot(), at('2026-10-03T19:00:00Z'), 120)).toEqual(
      at('2026-10-05T09:00:00Z'),
    );
  });
});

describe('cambios de hora en Europe/Madrid', () => {
  it('octubre: la franja del lunes ya va en horario de invierno', () => {
    // Sábado 24/10 21:00 (CEST) → lunes 26/10 9:00 (CET = 08:00Z).
    expect(nextOpening(snapshot(), at('2026-10-24T19:00:00Z'))).toEqual(at('2026-10-26T08:00:00Z'));
    // Sábado 13:00 CEST: 1 h el sábado y 1 h el lunes en CET.
    expect(addOpenMinutes(snapshot(), at('2026-10-24T11:00:00Z'), 120)).toEqual(
      at('2026-10-26T09:00:00Z'),
    );
  });

  it('marzo: una franja que empieza en la hora que no existe arranca en el primer minuto válido', () => {
    // Domingo 29/03/2026 el reloj salta de 2:00 a 3:00. Franja del domingo de 2:30 a 4:00.
    const s = snapshot({ hours: [{ weekday: 7, start: '02:30', end: '04:00' }] });
    const saturdayNight = at('2026-03-28T22:00:00Z'); // sábado 23:00 CET
    expect(nextOpening(s, saturdayNight)).toEqual(at('2026-03-29T01:00:00Z')); // 3:00 CEST
    expect(addOpenMinutes(s, saturdayNight, 60)).toEqual(at('2026-03-29T02:00:00Z')); // 4:00 CEST
  });
});

describe('describeOpening', () => {
  const tz = 'Europe/Madrid';
  const now = at('2026-10-01T13:00:00Z'); // jueves 15:00

  it('hoy, mañana o fecha completa, en hora local', () => {
    expect(describeOpening(at('2026-10-01T14:00:00Z'), now, tz)).toBe('hoy a las 16:00');
    expect(describeOpening(at('2026-10-02T07:00:00Z'), now, tz)).toBe('mañana a las 9:00');
    expect(describeOpening(at('2026-10-05T07:00:00Z'), now, tz)).toBe(
      'el lunes 5 de octubre a las 9:00',
    );
  });

  it('mañana se calcula en la zona del negocio, no en UTC', () => {
    // Jueves 23:30 en Madrid (21:30Z) → viernes 9:00 es "mañana".
    expect(describeOpening(at('2026-10-02T07:00:00Z'), at('2026-10-01T21:30:00Z'), tz)).toBe(
      'mañana a las 9:00',
    );
  });
});

describe('attentionAt (FR-010)', () => {
  it('abierto, cerrado con franja y cerrado sin franja en 60 días', () => {
    expect(attentionAt(snapshot(), at('2026-10-01T08:00:00Z'))).toEqual({ open: true });
    expect(attentionAt(snapshot(), at('2026-10-03T19:00:00Z'))).toEqual({
      open: false,
      from: 'el lunes 5 de octubre a las 9:00',
    });
    const long = snapshot({ closures: [closure('2026-10-01', '2026-12-31')] });
    expect(attentionAt(long, at('2026-10-01T08:00:00Z'))).toEqual({ open: false, from: null });
  });
});
