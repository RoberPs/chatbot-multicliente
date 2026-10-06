import { describe, expect, it } from 'vitest';
import { weeklyScheduleSchema } from '../../../src/knowledge/schemas/weekly-slots.js';
import { errorsOf, parseOk } from '../../helpers/schema.js';

describe('weeklySlotsSchema', () => {
  it('acepta varias franjas por día y días sin franjas', () => {
    const { slots } = parseOk(weeklyScheduleSchema, {
      slots: [
        { weekday: '1', start: '16:00', end: '20:00' },
        { weekday: '1', start: '09:00', end: '14:00' },
        { weekday: '6', start: '10:00', end: '14:00' },
      ],
    });
    expect(slots).toEqual([
      { weekday: 1, start: '09:00', end: '14:00' },
      { weekday: 1, start: '16:00', end: '20:00' },
      { weekday: 6, start: '10:00', end: '14:00' },
    ]);
  });

  it('una semana vacía es válida', () => {
    expect(parseOk(weeklyScheduleSchema, {}).slots).toEqual([]);
  });

  it('rechaza una franja 14:00–09:00 con error en slots[0].end (FR-006)', () => {
    expect(
      errorsOf(weeklyScheduleSchema, { slots: [{ weekday: '1', start: '14:00', end: '09:00' }] }),
    ).toEqual({ 'slots[0].end': 'La hora de fin debe ser posterior a la de inicio' });
  });

  it('rechaza franjas solapadas en el mismo día', () => {
    const errors = errorsOf(weeklyScheduleSchema, {
      slots: [
        { weekday: '2', start: '09:00', end: '14:00' },
        { weekday: '2', start: '13:00', end: '15:00' },
      ],
    });
    expect(errors).toEqual({ 'slots[1]': 'La franja se solapa con otra del mismo día' });
  });

  it('permite franjas iguales en días distintos y franjas contiguas', () => {
    expect(
      errorsOf(weeklyScheduleSchema, {
        slots: [
          { weekday: '2', start: '09:00', end: '14:00' },
          { weekday: '3', start: '09:00', end: '14:00' },
          { weekday: '3', start: '14:00', end: '15:00' },
        ],
      }),
    ).toEqual({});
  });

  it('rechaza día fuera de 1..7', () => {
    expect(
      errorsOf(weeklyScheduleSchema, { slots: [{ weekday: '8', start: '09:00', end: '10:00' }] }),
    ).toHaveProperty(['slots[0].weekday']);
  });
});
