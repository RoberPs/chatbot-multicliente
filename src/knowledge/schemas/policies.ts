import { z } from 'zod';
import { formList, formNumber, optionalText } from './common.js';

export const DURATION_UNITS = { minutes: 1, hours: 60, days: 1440 } as const;
export type DurationUnit = keyof typeof DURATION_UNITS;

export const AT_LEAST_ZERO_MESSAGE = 'Indica un número entero mayor o igual que 0';
export const ABOVE_ZERO_MESSAGE = 'Indica un número entero mayor que 0';
export const MIN_ABOVE_MAX_MESSAGE = 'La antelación mínima no puede ser mayor que la máxima';

const unit = z.preprocess(
  (v) => (v === undefined || v === '' ? 'minutes' : v),
  z.enum(['minutes', 'hours', 'days'], { error: 'Unidad no válida' }),
);

/** Número entero de minutos (o de la unidad del formulario) desde `min`. */
export const wholeAmountSchema = (min: number, message: string) =>
  z.number({ error: message }).int(message).min(min, message);

const amount = (min: number, message: string) =>
  z.preprocess(formNumber, wholeAmountSchema(min, message).nullable());

/** Reglas de cada campo de las políticas en la forma del dominio (formulario y fichero, 008). */
export const policiesFields = {
  cancellationText: optionalText(4000),
  cancellationNoticeMinutes: wholeAmountSchema(0, AT_LEAST_ZERO_MESSAGE),
  minAdvanceMinutes: wholeAmountSchema(0, AT_LEAST_ZERO_MESSAGE),
  maxAdvanceMinutes: wholeAmountSchema(1, ABOVE_ZERO_MESSAGE),
  paymentMethod: z.string().trim().max(100, 'Máximo 100 caracteres'),
};

/** Clave para detectar formas de pago repetidas (sin distinguir mayúsculas). */
export const paymentMethodKey = (method: string): string => method.toLocaleLowerCase('es');

const toMinutes = (value: number | null, u: DurationUnit): number | null =>
  value === null ? null : value * DURATION_UNITS[u];

/** Políticas (FR-015, FR-016). Plazos en minutos, horas o días; se guardan en minutos. */
export const policiesSchema = z
  .object({
    cancellation_text: policiesFields.cancellationText,
    cancellation_notice: amount(0, AT_LEAST_ZERO_MESSAGE),
    cancellation_notice_unit: unit,
    min_advance: amount(0, AT_LEAST_ZERO_MESSAGE),
    min_advance_unit: unit,
    max_advance: amount(1, ABOVE_ZERO_MESSAGE),
    max_advance_unit: unit,
    payment_methods: formList(policiesFields.paymentMethod),
  })
  .transform((v) => {
    const seen = new Set<string>();
    const paymentMethods = v.payment_methods.filter((m) => {
      const key = paymentMethodKey(m);
      if (m === '' || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      cancellationText: v.cancellation_text,
      cancellationNoticeMinutes: toMinutes(v.cancellation_notice, v.cancellation_notice_unit),
      minAdvanceMinutes: toMinutes(v.min_advance, v.min_advance_unit),
      maxAdvanceMinutes: toMinutes(v.max_advance, v.max_advance_unit),
      paymentMethods,
    };
  })
  .superRefine((v, ctx) => {
    if (
      v.minAdvanceMinutes !== null &&
      v.maxAdvanceMinutes !== null &&
      v.minAdvanceMinutes > v.maxAdvanceMinutes
    ) {
      ctx.addIssue({ code: 'custom', path: ['min_advance'], message: MIN_ABOVE_MAX_MESSAGE });
    }
  });

export type PoliciesInput = z.infer<typeof policiesSchema>;

/** Mayor unidad exacta para mostrar un plazo guardado en minutos. */
export function splitMinutes(minutes: number | null): { value: string; unit: DurationUnit } {
  if (minutes === null) return { value: '', unit: 'hours' };
  if (minutes !== 0 && minutes % DURATION_UNITS.days === 0) {
    return { value: String(minutes / DURATION_UNITS.days), unit: 'days' };
  }
  if (minutes !== 0 && minutes % DURATION_UNITS.hours === 0) {
    return { value: String(minutes / DURATION_UNITS.hours), unit: 'hours' };
  }
  return { value: String(minutes), unit: 'minutes' };
}
