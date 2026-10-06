import { describe, expect, it } from 'vitest';
import {
  effectiveIntervals,
  isOpenAt,
  isoWeekday,
  mergeIntervals,
  subtractIntervals,
} from '../../../src/knowledge/time/intervals.js';
import type { DateRangeBlock } from '../../../src/knowledge/types.js';
import { typicalWeek } from '../../helpers/state.js';

const block = (
  startDate: string,
  endDate: string,
  startTime: string | null = null,
  endTime: string | null = null,
): DateRangeBlock => ({ startDate, endDate, startTime, endTime, reason: null });

// 2026-12-21 es lunes; 24/12 jueves; 25/12 viernes; 27/12 domingo.
describe('reglas temporales', () => {
  const week = typicalWeek();

  it('día ISO: 1 = lunes, 7 = domingo', () => {
    expect(isoWeekday('2026-12-21')).toBe(1);
    expect(isoWeekday('2026-12-27')).toBe(7);
  });

  it('un día con dos franjas', () => {
    expect(effectiveIntervals(week, [], '2026-12-21')).toEqual([
      { start: '09:00', end: '14:00' },
      { start: '16:00', end: '20:00' },
    ]);
  });

  it('un día cerrado (domingo)', () => {
    expect(effectiveIntervals(week, [], '2026-12-27')).toEqual([]);
    expect(isOpenAt(week, [], '2026-12-27', '10:00')).toBe(false);
  });

  it('cierre de día completo el 25/12', () => {
    const closures = [block('2026-12-25', '2026-12-25')];
    expect(effectiveIntervals(week, closures, '2026-12-25')).toEqual([]);
    expect(isOpenAt(week, closures, '2026-12-25', '10:00')).toBe(false);
  });

  it('cierre parcial el 24/12 de 14:00 a 20:00', () => {
    const closures = [block('2026-12-24', '2026-12-24', '14:00', '20:00')];
    expect(isOpenAt(week, closures, '2026-12-24', '17:00')).toBe(false);
    expect(isOpenAt(week, closures, '2026-12-24', '10:00')).toBe(true);
    expect(effectiveIntervals(week, closures, '2026-12-24')).toEqual([
      { start: '09:00', end: '14:00' },
    ]);
  });

  it('cierres solapados se aplican como unión', () => {
    const closures = [
      block('2026-12-21', '2026-12-21', '10:00', '12:00'),
      block('2026-12-21', '2026-12-21', '11:00', '17:00'),
    ];
    expect(effectiveIntervals(week, closures, '2026-12-21')).toEqual([
      { start: '09:00', end: '10:00' },
      { start: '17:00', end: '20:00' },
    ]);
  });

  it('cierre de varios días', () => {
    const closures = [block('2026-08-01', '2026-08-15')];
    expect(isOpenAt(week, closures, '2026-08-10', '10:00')).toBe(false);
    expect(isOpenAt(week, closures, '2026-08-17', '10:00')).toBe(true);
  });

  it('el fin de una franja es exclusivo', () => {
    expect(isOpenAt(week, [], '2026-12-21', '14:00')).toBe(false);
    expect(isOpenAt(week, [], '2026-12-21', '13:59')).toBe(true);
  });

  it('merge y subtract', () => {
    expect(
      mergeIntervals([
        { start: '09:00', end: '10:00' },
        { start: '10:00', end: '11:00' },
        { start: '12:00', end: '13:00' },
      ]),
    ).toEqual([
      { start: '09:00', end: '11:00' },
      { start: '12:00', end: '13:00' },
    ]);
    expect(
      subtractIntervals([{ start: '09:00', end: '18:00' }], [{ start: '10:00', end: '14:00' }]),
    ).toEqual([
      { start: '09:00', end: '10:00' },
      { start: '14:00', end: '18:00' },
    ]);
  });
});
