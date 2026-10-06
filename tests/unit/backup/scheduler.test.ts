import { describe, expect, it } from 'vitest';
import { dueDailyBackup, localDateTime } from '../../../src/backup/scheduler.js';

const MADRID = 'Europe/Madrid';

const due = (now: string, extra: Partial<Parameters<typeof dueDailyBackup>[0]> = {}): boolean =>
  dueDailyBackup({
    now: new Date(now),
    timezone: MADRID,
    time: '03:00',
    dailyToday: false,
    failedOn: null,
    ...extra,
  });

describe('dueDailyBackup', () => {
  it('antes de la hora local no toca; a la hora y después sí', () => {
    // Septiembre: Madrid = UTC+2.
    expect(due('2026-09-29T00:59:00Z')).toBe(false); // 02:59
    expect(due('2026-09-29T01:00:00Z')).toBe(true); // 03:00
    expect(due('2026-09-29T20:00:00Z')).toBe(true); // 22:00
  });

  it('con la copia de hoy ya hecha no toca', () => {
    expect(due('2026-09-29T10:00:00Z', { dailyToday: true })).toBe(false);
  });

  it('tras un fallo hoy no toca hasta mañana', () => {
    expect(due('2026-09-29T10:00:00Z', { failedOn: '2026-09-29' })).toBe(false);
    expect(due('2026-09-30T01:00:00Z', { failedOn: '2026-09-29' })).toBe(true);
  });

  it('el día local es el de la zona del negocio, no el de UTC', () => {
    // 22:30 UTC del 29 = 00:30 del 30 en Madrid.
    expect(localDateTime(new Date('2026-09-29T22:30:00Z'), MADRID)).toEqual({
      date: '2026-09-30',
      time: '00:30',
    });
    expect(due('2026-09-29T22:30:00Z', { time: '00:15', failedOn: '2026-09-29' })).toBe(true);
  });

  it('salto de primavera (2026-03-29, 02:30 no existe): toca desde el primer minuto posterior', () => {
    // 00:59 UTC = 01:59 CET; 01:00 UTC = 03:00 CEST.
    expect(due('2026-03-29T00:59:00Z', { time: '02:30' })).toBe(false);
    expect(due('2026-03-29T01:00:00Z', { time: '02:30' })).toBe(true);
  });

  it('retroceso de otoño (2026-10-25, 02:30 se repite): una sola copia', () => {
    // 00:30 UTC = 02:30 CEST (primera vez); 01:30 UTC = 02:30 CET (segunda vez).
    expect(due('2026-10-25T00:30:00Z', { time: '02:30' })).toBe(true);
    expect(due('2026-10-25T01:30:00Z', { time: '02:30', dailyToday: true })).toBe(false);
  });

  it('otra zona horaria (America/Mexico_City) con la misma regla', () => {
    const mx = { timezone: 'America/Mexico_City' };
    // México = UTC−6: 08:59 UTC = 02:59; 09:00 UTC = 03:00.
    expect(due('2026-09-29T08:59:00Z', mx)).toBe(false);
    expect(due('2026-09-29T09:00:00Z', mx)).toBe(true);
    expect(due('2026-09-29T09:00:00Z', { ...mx, failedOn: '2026-09-29' })).toBe(false);
  });
});
