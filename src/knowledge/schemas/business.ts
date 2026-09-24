import type { CountryCode } from 'libphonenumber-js';
import { z } from 'zod';
import {
  currency,
  optionalEmail,
  optionalPhone,
  optionalText,
  timezone,
  trimmedText,
} from './common.js';

/** Datos del negocio (FR-001, FR-002). */
export const businessSchema = (region: CountryCode) =>
  z.object({
    name: trimmedText(1, 200),
    address: optionalText(500),
    directions: optionalText(2000),
    phone: optionalPhone(region),
    email: optionalEmail,
    timezone,
    currency,
  });

export type BusinessInput = z.infer<ReturnType<typeof businessSchema>>;
