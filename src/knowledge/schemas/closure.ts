import { z } from 'zod';
import { optionalText } from './common.js';
import { dateRangeBlockShape, refineDateRange, toDateRange } from './date-range-block.js';

/** Cierre puntual (FR-004 – FR-006). */
export const closureSchema = z
  .object({ ...dateRangeBlockShape, reason: optionalText(200) })
  .superRefine(refineDateRange)
  .transform((v) => ({ ...toDateRange(v), reason: v.reason }));

export type ClosureInput = z.infer<typeof closureSchema>;
