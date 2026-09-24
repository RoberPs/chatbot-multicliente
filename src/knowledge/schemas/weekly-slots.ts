import { z } from 'zod';
import { localTime } from './common.js';
import type { WeeklySlot, Weekday } from '../types.js';

const weekday = z.coerce
  .number({ error: 'Día no válido' })
  .int('Día no válido')
  .min(1, 'Día no válido')
  .max(7, 'Día no válido')
  .transform((v) => v as Weekday);

export const weeklySlotSchema = z.object({ weekday, start: localTime, end: localTime });

/**
 * Franjas semanales (negocio, recursos y derivación). Rechaza fin ≤ inicio (FR-006) y
 * franjas solapadas del mismo día (research R8).
 */
export const weeklySlotsSchema = z
  .preprocess(
    (v) => (v === undefined || v === null || v === '' ? [] : v),
    z.array(weeklySlotSchema),
  )
  .superRefine((slots, ctx) => {
    slots.forEach((slot, i) => {
      if (slot.end <= slot.start) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'end'],
          message: 'La hora de fin debe ser posterior a la de inicio',
        });
      }
    });
    slots.forEach((slot, j) => {
      if (slot.end <= slot.start) return;
      const overlaps = slots.some(
        (other, i) =>
          i < j &&
          other.weekday === slot.weekday &&
          other.end > other.start &&
          other.start < slot.end &&
          slot.start < other.end,
      );
      if (overlaps) {
        ctx.addIssue({
          code: 'custom',
          path: [j],
          message: 'La franja se solapa con otra del mismo día',
        });
      }
    });
  })
  .transform((slots): WeeklySlot[] =>
    [...slots].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start)),
  );

/** Formulario de horario semanal: `slots[i].weekday`, `slots[i].start`, `slots[i].end`. */
export const weeklyScheduleSchema = z.object({ slots: weeklySlotsSchema });
