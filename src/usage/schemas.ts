/**
 * Validación de los formularios de consumo (010, data-model.md §4; FR-013). Los importes llegan
 * como texto (coma o punto decimal) y salen en enteros: precios en millonésimas por millón de
 * tokens y tope en céntimos (R4). Los errores van por campo, con los nombres del formulario.
 */
import { z } from 'zod';
import { parseCapCents, parseMicrosPerMtok } from './money.js';
import type { ModelPrice } from './types.js';

export const MODEL_MAX_LENGTH = 200;
export const MODEL_MESSAGE = `Indica el nombre del modelo (hasta ${MODEL_MAX_LENGTH} caracteres)`;
export const PRICE_MESSAGE =
  'Indica un precio de 0 o más, con hasta 6 decimales y como mucho 1 000 000';
export const CURRENCY_MESSAGE = 'Indica la moneda con su código de 3 letras (p. ej. USD o EUR)';
export const CAP_AMOUNT_MESSAGE =
  'Indica un tope mayor que 0, con hasta 2 decimales y como mucho 10 000 000';

/** El cambio de moneda exige la tabla de precios vacía (R13). */
export const currencyLockedMessage = (current: string): string =>
  `Para cambiar la moneda, borra antes los precios: están en ${current}.`;

/** Activar el tope exige precio del modelo configurado (FR-014). */
export const capWithoutPriceMessage = (model: string): string =>
  `No se puede activar el tope: el modelo «${model}» no tiene precio.`;

/** En producción con el negocio activo el tope no se puede desactivar (012, FR-003). */
export const CAP_REQUIRED_MESSAGE =
  'En producción el tope de gasto es obligatorio mientras el negocio está activo.';
/** En producción con el negocio activo no se borra el precio del modelo en uso (012, FR-003). */
export const PRICE_IN_USE_MESSAGE =
  'En producción no se puede borrar el precio del modelo en uso mientras el negocio está activo.';

export const WHATSAPP_CAP_MIN = 1;
export const WHATSAPP_CAP_MAX = 10_000;
export const WHATSAPP_CAP_MESSAGE = `Indica un número entero de respuestas entre ${WHATSAPP_CAP_MIN} y ${new Intl.NumberFormat('es-ES').format(WHATSAPP_CAP_MAX)}`;
export const PER_MINUTE_MESSAGE =
  'Indica un precio por minuto de 0 o más, con hasta 6 decimales y como mucho 1 000 000';

const text = z.union([z.string(), z.number()]).optional();

/** Entero escrito en un formulario (sin decimales ni signos); `null` si no lo es. */
export function parseFormInteger(raw: unknown): number | null {
  const value = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  return /^\d{1,9}$/.test(value) ? Number(value) : null;
}

/** Tope diario de respuestas de WhatsApp con modelo (012, R5): sin interruptor. */
export const whatsappCapSchema = z
  .object({
    whatsappDailyCap: z.unknown().transform((raw, ctx) => {
      const n = parseFormInteger(raw);
      if (n === null || n < WHATSAPP_CAP_MIN || n > WHATSAPP_CAP_MAX) {
        ctx.addIssue({ code: 'custom', message: WHATSAPP_CAP_MESSAGE });
        return z.NEVER;
      }
      return n;
    }),
  })
  .transform((v) => v.whatsappDailyCap);

/** Precio por minuto de un modelo de transcripción (012, R6), en millonésimas por minuto. */
export const transcriptionPriceSchema = z.object({
  model: z
    .string({ error: MODEL_MESSAGE })
    .trim()
    .min(1, MODEL_MESSAGE)
    .max(MODEL_MAX_LENGTH, MODEL_MESSAGE),
  perMinute: text.transform((raw, ctx) => {
    // Misma regla que los precios por millón de tokens: decimal con hasta 6 decimales.
    const micros = raw === undefined ? null : parseMicrosPerMtok(String(raw));
    if (micros === null) {
      ctx.addIssue({ code: 'custom', message: PER_MINUTE_MESSAGE });
      return z.NEVER;
    }
    return micros;
  }),
});

export interface TranscriptionPrice {
  model: string;
  /** Millonésimas de la moneda por minuto de audio. */
  microsPerMinute: bigint;
}

/** Precio por millón de tokens → millonésimas. */
const priceField = text.transform((raw, ctx) => {
  const micros = raw === undefined ? null : parseMicrosPerMtok(String(raw));
  if (micros === null) {
    ctx.addIssue({ code: 'custom', message: PRICE_MESSAGE });
    return z.NEVER;
  }
  return micros;
});

/** Formulario de precio de un modelo (alta o cambio). */
export const priceSchema = z
  .object({
    model: z
      .string({ error: MODEL_MESSAGE })
      .trim()
      .min(1, MODEL_MESSAGE)
      .max(MODEL_MAX_LENGTH, MODEL_MESSAGE),
    input: priceField,
    output: priceField,
    cacheWrite: priceField,
    cacheRead: priceField,
  })
  .transform((v): ModelPrice => ({
    model: v.model,
    inputMicros: v.input,
    outputMicros: v.output,
    cacheWriteMicros: v.cacheWrite,
    cacheReadMicros: v.cacheRead,
  }));

const currencyField = z
  .string({ error: CURRENCY_MESSAGE })
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/, CURRENCY_MESSAGE));

/** Importe del tope → céntimos; vacío = sin importe (se conserva el guardado). */
const capAmountField = text.transform((raw, ctx) => {
  if (raw === undefined || String(raw).trim() === '') return null;
  const cents = parseCapCents(String(raw));
  if (cents === null) {
    ctx.addIssue({ code: 'custom', message: CAP_AMOUNT_MESSAGE });
    return z.NEVER;
  }
  return cents;
});

export interface UsageSettingsInput {
  currency: string;
  capEnabled: boolean;
  /** `null`: el formulario no trae importe (al desactivar se conserva el guardado). */
  monthlyCapCents: number | null;
}

/**
 * Ajustes de consumo: moneda y tope. Activar exige un importe válido; desactivar siempre vale y
 * conserva el importe. Las reglas que dependen de lo guardado (precios, modelo actual) las
 * comprueba `saveUsageSettings`.
 */
export const usageSettingsSchema = z
  .object({
    currency: currencyField,
    // Casilla del formulario: llega como "on" cuando está marcada.
    capEnabled: z.union([z.literal('on'), z.boolean()]).optional(),
    monthlyCap: capAmountField,
  })
  .transform((v): UsageSettingsInput => ({
    currency: v.currency,
    capEnabled: v.capEnabled === 'on' || v.capEnabled === true,
    monthlyCapCents: v.monthlyCap,
  }))
  .superRefine((v, ctx) => {
    if (v.capEnabled && v.monthlyCapCents === null) {
      ctx.addIssue({ code: 'custom', path: ['monthlyCap'], message: CAP_AMOUNT_MESSAGE });
    }
  });
