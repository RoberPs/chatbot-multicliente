import { z } from 'zod';
import { isoDate, optionalLocalTime } from './common.js';

export const dateRangeBlockShape = {
  start_date: isoDate,
  end_date: isoDate,
  start_time: optionalLocalTime,
  end_time: optionalLocalTime,
};

interface RawBlock {
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
}

/** Reglas de un bloque de fechas (cierres y ausencias): FR-004, FR-006. */
export function refineDateRange(v: RawBlock, ctx: z.RefinementCtx): void {
  if (v.end_date < v.start_date) {
    ctx.addIssue({
      code: 'custom',
      path: ['end_date'],
      message: 'La fecha de fin no puede ser anterior a la de inicio',
    });
  }
  if ((v.start_time === null) !== (v.end_time === null)) {
    ctx.addIssue({
      code: 'custom',
      path: [v.start_time === null ? 'start_time' : 'end_time'],
      message: 'Indica la hora de inicio y la de fin, o ninguna para el día completo',
    });
  } else if (v.start_time !== null && v.end_time !== null && v.end_time <= v.start_time) {
    ctx.addIssue({
      code: 'custom',
      path: ['end_time'],
      message: 'La hora de fin debe ser posterior a la de inicio',
    });
  }
}

export interface DateRangeInput {
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
}

export const toDateRange = (v: RawBlock): DateRangeInput => ({
  startDate: v.start_date,
  endDate: v.end_date,
  startTime: v.start_time,
  endTime: v.end_time,
});

export const dateRangeBlockSchema = z
  .object(dateRangeBlockShape)
  .superRefine(refineDateRange)
  .transform(toDateRange);
