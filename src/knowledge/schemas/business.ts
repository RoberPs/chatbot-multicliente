import type { CountryCode } from 'libphonenumber-js';
import { z } from 'zod';
import {
  currency,
  optionalEmail,
  optionalHttpsUrl,
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
    map_url: optionalHttpsUrl(500),
    phone: optionalPhone(region),
    email: optionalEmail,
    timezone,
    currency,
  });

export type BusinessInput = z.infer<ReturnType<typeof businessSchema>>;
