import { z } from 'zod';
import { localTime } from './common.js';
import type { WeeklySlot, Weekday } from '../types.js';

export const WEEKDAY_MESSAGE = 'Día no válido';

/** Día ISO 1–7 (1 = lunes); en el formulario llega como texto. */
export const weekdaySchema = z.coerce
  .number({ error: WEEKDAY_MESSAGE })
  .int(WEEKDAY_MESSAGE)
  .min(1, WEEKDAY_MESSAGE)
  .max(7, WEEKDAY_MESSAGE)
  .transform((v) => v as Weekday);

export const weeklySlotSchema = z.object({ weekday: weekdaySchema, start: localTime, end: localTime });

/**
 * Reglas de una lista de franjas semanales: fin > inicio (FR-006) y sin solapes el mismo día
 * (research R8). Las usan el formulario y el fichero de configuración (008).
 */
export function refineWeeklySlots(slots: WeeklySlot[], ctx: z.RefinementCtx): void {
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
}

/** Orden canónico de las franjas: día y hora de inicio. */
export const sortWeeklySlots = (slots: WeeklySlot[]): WeeklySlot[] =>
  [...slots].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));

/**
 * Franjas semanales (negocio, recursos y derivación). Rechaza fin ≤ inicio (FR-006) y
 * franjas solapadas del mismo día (research R8).
 */
export const weeklySlotsSchema = z
  .preprocess(
    (v) => (v === undefined || v === null || v === '' ? [] : v),
    z.array(weeklySlotSchema),
  )
  .superRefine(refineWeeklySlots)
  .transform(sortWeeklySlots);

/** Formulario de horario semanal: `slots[i].weekday`, `slots[i].start`, `slots[i].end`. */
export const weeklyScheduleSchema = z.object({ slots: weeklySlotsSchema });
