/** Esquemas Zod de la configuración de la derivación (005, R16). */
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { z } from 'zod';
import { blankToNull } from '../knowledge/schemas/common.js';

const PHONE_ERROR = 'Indica un teléfono válido, con prefijo si no es de España';
const EMAIL_ERROR = 'Indica un email válido';

/**
 * Destinos de los avisos al negocio (`handoff_alerts`). Los dos son opcionales: sin destinos el
 * bot sigue dando el contacto de derivación (FR-020).
 */
export const handoffAlertsSchema = (region: CountryCode) =>
  z.object({
    whatsapp: z.preprocess(
      blankToNull,
      z
        .string()
        .trim()
        .transform((value, ctx) => {
          const parsed = parsePhoneNumberFromString(value, region);
          if (!parsed?.isValid()) {
            ctx.addIssue({ code: 'custom', message: PHONE_ERROR });
            return z.NEVER;
          }
          return parsed.number;
        })
        .nullable(),
    ),
    email: z.preprocess(
      blankToNull,
      z.string().trim().toLowerCase().pipe(z.email(EMAIL_ERROR)).nullable(),
    ),
  });

export type HandoffAlertsInput = z.infer<ReturnType<typeof handoffAlertsSchema>>;
