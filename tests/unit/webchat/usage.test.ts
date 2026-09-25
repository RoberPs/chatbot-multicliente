/** Cuentas del chat web en hora local del negocio (FR-026, garantía 8). */
import { describe, expect, it } from 'vitest';
import { capReached, localDay, localMonthRange } from '../../../src/webchat/usage.js';

const MADRID = 'Europe/Madrid';

describe('día local', () => {
  it('23:59 y 00:00 de Madrid caen en días distintos aunque en UTC sea el mismo día', () => {
    // Verano (UTC+2): 23:59 del 24 = 21:59Z; 00:00 del 25 = 22:00Z, ambos el 24 en UTC.
    expect(localDay(new Date('2026-09-24T21:59:00Z'), MADRID)).toBe('2026-09-24');
    expect(localDay(new Date('2026-09-24T22:00:00Z'), MADRID)).toBe('2026-09-25');
  });

  it('y al revés: el mismo día local en dos días UTC', () => {
    // Nueva York (UTC-4 en septiembre): 21:00 y 22:00 locales del 24 son el 25 en UTC.
    const zone = 'America/New_York';
    expect(localDay(new Date('2026-09-25T01:00:00Z'), zone)).toBe('2026-09-24');
    expect(localDay(new Date('2026-09-25T02:00:00Z'), zone)).toBe('2026-09-24');
    expect(localDay(new Date('2026-09-25T04:00:00Z'), zone)).toBe('2026-09-25');
  });

  it('cambio de hora de verano: el día local sigue bien a ambos lados', () => {
    // 25/10/2026 a las 03:00 CEST vuelve a ser 02:00 CET (UTC+2 → UTC+1).
    expect(localDay(new Date('2026-10-24T22:30:00Z'), MADRID)).toBe('2026-10-25');
    expect(localDay(new Date('2026-10-25T22:59:00Z'), MADRID)).toBe('2026-10-25');
    expect(localDay(new Date('2026-10-25T23:00:00Z'), MADRID)).toBe('2026-10-26');
    // 29/03/2026 a las 02:00 CET pasa a 03:00 CEST (UTC+1 → UTC+2).
    expect(localDay(new Date('2026-03-28T23:00:00Z'), MADRID)).toBe('2026-03-29');
    expect(localDay(new Date('2026-03-29T21:59:00Z'), MADRID)).toBe('2026-03-29');
    expect(localDay(new Date('2026-03-29T22:00:00Z'), MADRID)).toBe('2026-03-30');
  });
});

describe('mes local', () => {
  it('el último instante de septiembre en Madrid ya es octubre en hora local', () => {
    expect(localMonthRange(new Date('2026-09-30T21:59:00Z'), MADRID)).toEqual({
      first: '2026-09-01',
      last: '2026-09-30',
    });
    expect(localMonthRange(new Date('2026-09-30T22:00:00Z'), MADRID)).toEqual({
      first: '2026-10-01',
      last: '2026-10-31',
    });
  });

  it('febrero y años bisiestos', () => {
    expect(localMonthRange(new Date('2026-02-10T12:00:00Z'), MADRID).last).toBe('2026-02-28');
    expect(localMonthRange(new Date('2028-02-10T12:00:00Z'), MADRID).last).toBe('2028-02-29');
  });
});

describe('capReached', () => {
  const caps = { dailyCap: 200, monthlyCap: 3000 };
  it.each([
    [{ today: 0, month: 0 }, null],
    [{ today: 199, month: 2999 }, null],
    [{ today: 200, month: 900 }, 'day'],
    [{ today: 10, month: 3000 }, 'month'],
    [{ today: 200, month: 3000 }, 'month'],
  ] as const)('%o → %s', (usage, expected) => {
    expect(capReached(usage, caps)).toBe(expected);
  });
});
