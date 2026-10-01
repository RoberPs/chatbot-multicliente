import { z } from 'zod';
import { parseAmountToCents } from '../money.js';
import { blankToNull, checkbox, formNumber, optionalText, trimmedText } from './common.js';

export const DURATION_MESSAGE = 'La duración debe ser un número entero de minutos entre 1 y 1440';

/** Duración en minutos: entero entre 1 y 1440. */
export const durationMinutesSchema = z
  .number({ error: DURATION_MESSAGE })
  .int(DURATION_MESSAGE)
  .min(1, DURATION_MESSAGE)
  .max(1440, DURATION_MESSAGE);

/** Reglas de cada campo de un servicio en la forma del dominio (formulario y fichero, 008). */
export const serviceFields = {
  name: trimmedText(1, 200),
  description: optionalText(4000),
  priceType: z.enum(['fixed', 'from', 'on_request'], { error: 'Elige un tipo de precio' }),
};

/** Servicio (FR-007 – FR-009, FR-011b). `price` es un decimal en la moneda del negocio. */
export const serviceSchema = z
  .object({
    name: serviceFields.name,
    description: serviceFields.description,
    price_type: serviceFields.priceType,
    price: z.preprocess(
      (v) => (typeof v === 'number' ? String(v) : blankToNull(v)),
      z.string().nullable(),
    ),
    duration: z.preprocess(formNumber, durationMinutesSchema.nullable()),
    bookable: checkbox,
    active: checkbox,
  })
  .superRefine((v, ctx) => {
    if (v.price_type === 'on_request' || v.price === null) return;
    const parsed = parseAmountToCents(v.price);
    if (!parsed.ok) ctx.addIssue({ code: 'custom', path: ['price'], message: parsed.message });
  })
  .transform((v) => {
    const parsed =
      v.price_type === 'on_request' || v.price === null ? null : parseAmountToCents(v.price);
    return {
      name: v.name,
      description: v.description,
      priceType: v.price_type,
      // "A consultar" nunca guarda importe.
      priceCents: parsed?.ok ? parsed.cents : null,
      durationMinutes: v.duration,
      bookable: v.bookable,
      active: v.active,
    };
  });

export type ServiceInput = z.infer<typeof serviceSchema>;
