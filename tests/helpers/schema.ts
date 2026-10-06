import type { z } from 'zod';
import { zodErrorToFieldErrors, type FieldErrors } from '../../src/admin/form-errors.js';

/** Valida y devuelve los errores por campo (vacío si es válido). */
export function errorsOf(schema: z.ZodType, input: unknown): FieldErrors {
  const result = schema.safeParse(input);
  return result.success ? {} : zodErrorToFieldErrors(result.error);
}

/** Valida y devuelve el dato; falla el test si no es válido. */
export function parseOk<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`Se esperaba válido: ${JSON.stringify(zodErrorToFieldErrors(result.error))}`);
  }
  return result.data;
}
