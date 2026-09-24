import { ZodError } from 'zod';
import { CriticalWarningError, FieldConflictError, NotFoundError } from '../knowledge/errors.js';
import type { Warning } from '../knowledge/types.js';

export type FieldErrors = Record<string, string>;

/** `['slots', 0, 'end']` → `slots[0].end`. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, key) => {
    if (typeof key === 'number') return `${acc}[${key}]`;
    const name = String(key);
    return acc === '' ? name : `${acc}.${name}`;
  }, '');
}

/** Un error por campo (el primero), con rutas como en los nombres del formulario. */
export function zodErrorToFieldErrors(error: ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = formatIssuePath(issue.path) || '_form';
    errors[key] ??= issue.message;
  }
  return errors;
}

export interface FormErrorResponse {
  status: 404 | 409 | 422;
  errors: FieldErrors;
  general?: string;
  warnings?: Warning[];
}

export const CRITICAL_GENERAL_MESSAGE =
  'El negocio está activo y se quedaría sin salida a una persona. No se ha guardado el cambio.';

/** Traduce los errores del dominio a la respuesta del formulario; `null` si no es de formulario. */
export function formErrorResponse(err: unknown): FormErrorResponse | null {
  if (err instanceof ZodError) {
    return {
      status: 422,
      errors: zodErrorToFieldErrors(err),
      general: 'Revisa los campos marcados.',
    };
  }
  if (err instanceof FieldConflictError) {
    return {
      status: 422,
      errors: { [err.field]: err.message },
      general: 'Revisa los campos marcados.',
    };
  }
  if (err instanceof CriticalWarningError) {
    return { status: 409, errors: {}, general: CRITICAL_GENERAL_MESSAGE, warnings: err.warnings };
  }
  if (err instanceof NotFoundError) {
    return { status: 404, errors: {}, general: err.message };
  }
  return null;
}
