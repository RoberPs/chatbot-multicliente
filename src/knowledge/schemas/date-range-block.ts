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

export interface DateRangeInput {
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
}

/**
 * Reglas de un bloque de fechas (cierres y ausencias): FR-004, FR-006. Devuelve el campo
 * afectado y el motivo; las usan el formulario y el fichero de configuración (008).
 */
export function dateRangeIssues(
  v: DateRangeInput,
): Array<{ field: keyof DateRangeInput; message: string }> {
  const issues: Array<{ field: keyof DateRangeInput; message: string }> = [];
  if (v.endDate < v.startDate) {
    issues.push({
      field: 'endDate',
      message: 'La fecha de fin no puede ser anterior a la de inicio',
    });
  }
  if ((v.startTime === null) !== (v.endTime === null)) {
    issues.push({
      field: v.startTime === null ? 'startTime' : 'endTime',
      message: 'Indica la hora de inicio y la de fin, o ninguna para el día completo',
    });
  } else if (v.startTime !== null && v.endTime !== null && v.endTime <= v.startTime) {
    issues.push({ field: 'endTime', message: 'La hora de fin debe ser posterior a la de inicio' });
  }
  return issues;
}

const FORM_FIELDS: Record<keyof DateRangeInput, keyof RawBlock> = {
  startDate: 'start_date',
  endDate: 'end_date',
  startTime: 'start_time',
  endTime: 'end_time',
};

export const toDateRange = (v: RawBlock): DateRangeInput => ({
  startDate: v.start_date,
  endDate: v.end_date,
  startTime: v.start_time,
  endTime: v.end_time,
});

/** Reglas de un bloque de fechas con los nombres de campo del formulario. */
export function refineDateRange(v: RawBlock, ctx: z.RefinementCtx): void {
  for (const issue of dateRangeIssues(toDateRange(v))) {
    ctx.addIssue({ code: 'custom', path: [FORM_FIELDS[issue.field]], message: issue.message });
  }
}

export const dateRangeBlockSchema = z
  .object(dateRangeBlockShape)
  .superRefine(refineDateRange)
  .transform(toDateRange);
