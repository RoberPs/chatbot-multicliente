/** Esquemas Zod comunes. Aceptan la forma de un formulario (textos) y devuelven datos del dominio. */
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { z } from 'zod';

export const REQUIRED = 'Este campo es obligatorio';

export const blankToNull = (value: unknown): unknown =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
    ? null
    : value;

/** Texto obligatorio recortado. */
export const trimmedText = (min: number, max: number) =>
  z
    .string({ error: REQUIRED })
    .trim()
    .min(min, min <= 1 ? REQUIRED : `Mínimo ${min} caracteres`)
    .max(max, `Máximo ${max} caracteres`);

/** Texto opcional recortado; vacío → `null`. */
export const optionalText = (max: number) =>
  z.preprocess(blankToNull, z.string().trim().max(max, `Máximo ${max} caracteres`).nullable());

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/;

/** Hora local `HH:MM` (se aceptan segundos y se descartan). */
export const localTime = z
  .string({ error: REQUIRED })
  .trim()
  .min(1, REQUIRED)
  .regex(TIME_RE, 'Hora no válida (HH:MM)')
  .transform((v) => v.slice(0, 5));

export const optionalLocalTime = z.preprocess(blankToNull, localTime.nullable());

const isRealDate = (v: string): boolean => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** Fecha `AAAA-MM-DD`. */
export const isoDate = z
  .string({ error: REQUIRED })
  .trim()
  .min(1, REQUIRED)
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha no válida')
  .refine(isRealDate, 'Fecha no válida');

/** Teléfono en formato nacional (región por defecto de la instancia) o internacional → E.164. */
export const phone = (region: CountryCode) =>
  z
    .string({ error: REQUIRED })
    .trim()
    .min(1, REQUIRED)
    .transform((value, ctx) => {
      const parsed = parsePhoneNumberFromString(value, region);
      if (!parsed?.isValid()) {
        ctx.addIssue({ code: 'custom', message: 'Teléfono no válido' });
        return z.NEVER;
      }
      return parsed.number;
    });

export const optionalPhone = (region: CountryCode) =>
  z.preprocess(blankToNull, phone(region).nullable());

/** Email válido, guardado en minúsculas. */
export const email = z
  .string({ error: REQUIRED })
  .trim()
  .toLowerCase()
  .pipe(z.email('Email no válido'));

export const optionalEmail = z.preprocess(blankToNull, email.nullable());

let timezoneSet: Set<string> | undefined;

export function isValidTimezone(value: string): boolean {
  timezoneSet ??= new Set(Intl.supportedValuesOf('timeZone'));
  if (timezoneSet.has(value) || value === 'UTC') return true;
  try {
    const resolved = new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
    return timezoneSet.has(resolved) && resolved.toLowerCase() === value.toLowerCase();
  } catch {
    return false;
  }
}

const INVALID_URL = 'Enlace no válido: copia el enlace completo, empezando por https://';

/** Primer error de un enlace `https://`, en el orden de research R7; `null` si es válido. */
function httpsUrlError(value: string, max: number): string | null {
  if (value.length > max) return `Máximo ${max} caracteres`;
  if (/\s/.test(value)) return INVALID_URL;
  if (!value.includes('://')) return 'Escribe el enlace completo, empezando por https://';
  if (/^http:\/\//i.test(value)) return 'Usa el enlace seguro, que empieza por https://';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return INVALID_URL;
  }
  const valid =
    url.protocol === 'https:' && url.hostname.includes('.') && !url.username && !url.password;
  return valid ? null : INVALID_URL;
}

/**
 * Enlace `https://` opcional (003, research R7); vacío → `null`. Se devuelve recortado, tal como
 * se escribió (sin recodificar), porque es lo que ve el operador y lo que copia el bot.
 */
export const optionalHttpsUrl = (max: number) =>
  z.preprocess(
    blankToNull,
    z
      .string()
      .trim()
      .superRefine((value, ctx) => {
        const message = httpsUrlError(value, max);
        if (message) ctx.addIssue({ code: 'custom', message });
      })
      .nullable(),
  );

/** Zona horaria IANA. */
export const timezone = z
  .string({ error: REQUIRED })
  .trim()
  .min(1, REQUIRED)
  .refine(isValidTimezone, 'Zona horaria no válida');

/** Moneda ISO 4217. */
export const currency = z
  .string({ error: REQUIRED })
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Moneda no válida (código ISO de 3 letras)');

/** Casilla de un formulario: presente = verdadero. */
export const checkbox = z.preprocess(
  (v) => v === true || v === 'on' || v === 'true' || v === '1',
  z.boolean(),
);

/** Lista de un formulario: un valor suelto se convierte en lista y los vacíos se descartan. */
export const formList = <T extends z.ZodType>(item: T) =>
  z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return [];
    const list: unknown[] = Array.isArray(v) ? v : [v];
    return list.filter((x) => !(typeof x === 'string' && x.trim() === ''));
  }, z.array(item));

/** Número escrito en un formulario (admite coma decimal); vacío → `null`. */
export const formNumber = (value: unknown): unknown => {
  const b = blankToNull(value);
  return typeof b === 'string' ? Number(b.trim().replace(',', '.')) : b;
};
