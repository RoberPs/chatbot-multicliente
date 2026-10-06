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

export const BUSINESS_NAME_MAX = 200;

/** Reglas de cada campo de los datos del negocio (formulario y fichero, 008). */
export const businessFields = (region: CountryCode) => ({
  name: trimmedText(1, BUSINESS_NAME_MAX),
  address: optionalText(500),
  directions: optionalText(2000),
  mapUrl: optionalHttpsUrl(500),
  phone: optionalPhone(region),
  email: optionalEmail,
  timezone,
  currency,
});

/** Datos del negocio (FR-001, FR-002). */
export const businessSchema = (region: CountryCode) => {
  const fields = businessFields(region);
  return z.object({
    name: fields.name,
    address: fields.address,
    directions: fields.directions,
    map_url: fields.mapUrl,
    phone: fields.phone,
    email: fields.email,
    timezone: fields.timezone,
    currency: fields.currency,
  });
};

export type BusinessInput = z.infer<ReturnType<typeof businessSchema>>;
