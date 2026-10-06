/**
 * Validación de la configuración del chat web (004, data-model.md, research R8).
 *
 * El formulario del panel llega con las webs permitidas en un textarea (una por línea) y los
 * topes como texto. Los errores salen por campo, con el número de línea cuando el problema está
 * en una web concreta, para que el panel los pinte junto a su campo.
 */
import { z } from 'zod';
import type { WebChatSettings } from './settings.js';

/** Hosts para los que se admite `http` (pruebas en local). */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export const MAX_ALLOWED_ORIGINS = 10;
export const MAX_ORIGINS_MESSAGE = `Indica como máximo ${MAX_ALLOWED_ORIGINS} webs`;
export const REPEATED_ORIGIN_MESSAGE = 'esa web está repetida';
export const CAP_MESSAGE = 'Indica un número entero de 1 o más respuestas';
export const MONTHLY_BELOW_DAILY_MESSAGE = 'El tope mensual no puede ser menor que el diario';
export const ORIGINS_REQUIRED_MESSAGE = 'Indica al menos una web donde se mostrará el chat';
export const PRIVACY_REQUIRED_MESSAGE = 'Indica el enlace a la política de privacidad del negocio';
export const PRIVACY_HTTPS_MESSAGE =
  'El enlace a la política de privacidad debe empezar por https://';

/** Motivo por el que una línea no vale, o el origen normalizado. */
export type OriginResult = { origin: string } | { error: string };

/**
 * Normaliza una web permitida a `https://host[:puerto]` en minúsculas (formulario y fichero,
 * 008). `http` solo para `localhost` y `127.0.0.1`.
 */
export function parseOrigin(value: string): OriginResult {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: 'no es una dirección de web válida' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: 'no es una dirección de web válida' };
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    return { error: 'indica solo la dirección de la web, sin ruta ni parámetros' };
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    return { error: 'la web debe usar https' };
  }
  return { origin: url.origin.toLowerCase() };
}

/** Enlace a la política de privacidad normalizado, o el motivo por el que no vale. */
export function parsePrivacyUrl(value: string): { url: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: PRIVACY_HTTPS_MESSAGE };
  }
  if (url.protocol !== 'https:') return { error: PRIVACY_HTTPS_MESSAGE };
  return { url: url.toString() };
}

/** Texto del textarea → líneas con su número original (para el mensaje de error). */
const numberedLines = (text: string): Array<{ line: number; value: string }> =>
  text
    .split('\n')
    .map((value, i) => ({ line: i + 1, value: value.trim() }))
    .filter((l) => l.value !== '');

const originsSchema = z.string().default('').transform((text, ctx) => {
  const lines = numberedLines(text);
  if (lines.length > MAX_ALLOWED_ORIGINS) {
    ctx.addIssue({ code: 'custom', message: MAX_ORIGINS_MESSAGE });
    return z.NEVER;
  }
  const origins: string[] = [];
  for (const { line, value } of lines) {
    const result = parseOrigin(value);
    if ('error' in result) {
      ctx.addIssue({ code: 'custom', message: `Línea ${line}: ${result.error}` });
      return z.NEVER;
    }
    if (origins.includes(result.origin)) {
      ctx.addIssue({ code: 'custom', message: `Línea ${line}: ${REPEATED_ORIGIN_MESSAGE}` });
      return z.NEVER;
    }
    origins.push(result.origin);
  }
  return origins;
});

const privacyUrlSchema = z.string().default('').transform((raw, ctx) => {
  const value = raw.trim();
  if (value === '') return null;
  const result = parsePrivacyUrl(value);
  if ('error' in result) {
    ctx.addIssue({ code: 'custom', message: result.error });
    return z.NEVER;
  }
  return result.url;
});

/** Tope: entero de 1 o más, escrito como texto en el formulario. */
const capSchema = (fallback: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return fallback;
      const value = typeof raw === 'number' ? raw : Number(raw.trim());
      if (!Number.isInteger(value) || value < 1) {
        ctx.addIssue({ code: 'custom', message: CAP_MESSAGE });
        return z.NEVER;
      }
      return value;
    });

/**
 * Configuración del chat web tal como la envía el panel. Activar exige al menos una web y el
 * enlace a la política de privacidad (FR-015); desactivar siempre vale y conserva los valores.
 */
export const webChatSettingsSchema = z
  .object({
    // Casilla del formulario: llega como "on" cuando está marcada.
    enabled: z.union([z.literal('on'), z.boolean()]).optional(),
    allowed_origins: originsSchema,
    privacy_url: privacyUrlSchema,
    daily_cap: capSchema(200),
    monthly_cap: capSchema(3000),
  })
  .transform(
    (values): WebChatSettings => ({
      enabled: values.enabled === 'on' || values.enabled === true,
      allowedOrigins: values.allowed_origins,
      privacyUrl: values.privacy_url,
      dailyCap: values.daily_cap,
      monthlyCap: values.monthly_cap,
    }),
  )
  .superRefine((settings, ctx) => {
    if (settings.monthlyCap < settings.dailyCap) {
      ctx.addIssue({
        code: 'custom',
        path: ['monthly_cap'],
        message: MONTHLY_BELOW_DAILY_MESSAGE,
      });
    }
    if (!settings.enabled) return;
    if (settings.allowedOrigins.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['allowed_origins'], message: ORIGINS_REQUIRED_MESSAGE });
    }
    if (settings.privacyUrl === null) {
      ctx.addIssue({ code: 'custom', path: ['privacy_url'], message: PRIVACY_REQUIRED_MESSAGE });
    }
  });
