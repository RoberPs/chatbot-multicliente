/**
 * Datos de contacto del cliente para la derivación (005, FR-004, FR-005): nombre de una línea y
 * teléfono en E.164. En WhatsApp los da el canal; en web y playground se piden.
 */
import {
  findPhoneNumbersInText,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js';
import type { ContactField } from './types.js';

const NAME_MAX = 80;

/** Nombre de una línea, sin saltos ni espacios repetidos, ≤ 80 caracteres; `null` si vacío. */
export function normalizeName(value: string | null): string | null {
  if (value === null) return null;
  const name = value.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  return name === '' ? null : name;
}

export type PhoneResult =
  { status: 'valid'; phone: string } | { status: 'invalid' } | { status: 'missing' };

/** Una cifra de al menos 6 dígitos (con espacios, puntos o guiones) que intenta ser un teléfono. */
const PHONE_ATTEMPT = /\+?\d[\d\s.-]{4,}\d/;

/**
 * Teléfono dado por el cliente: el que copió el modelo o, si es nulo, el primero válido que
 * aparezca en los textos del lote. Se valida con la región por defecto y se devuelve en E.164.
 */
export function resolvePhone(
  modelPhone: string | null,
  texts: string[],
  region: CountryCode,
): PhoneResult {
  if (modelPhone !== null && modelPhone.trim() !== '') {
    const parsed = parsePhoneNumberFromString(modelPhone.trim(), region);
    return parsed?.isValid() ? { status: 'valid', phone: parsed.number } : { status: 'invalid' };
  }
  for (const text of texts) {
    const found = findPhoneNumbersInText(text, region).find((f) => f.number.isValid());
    if (found) return { status: 'valid', phone: found.number.number };
  }
  return texts.some((t) => PHONE_ATTEMPT.test(t)) ? { status: 'invalid' } : { status: 'missing' };
}

/**
 * Datos que faltan para derivar. Con `contactFromChannel` (WhatsApp) el teléfono es el del
 * canal y el nombre, el de perfil; en web y playground, los que no haya dado ya.
 */
export function missingContact(
  contactFromChannel: boolean,
  known: { name: string | null; phone: string | null },
): ContactField[] {
  const missing: ContactField[] = [];
  if (known.name === null) missing.push('name');
  if (!contactFromChannel && known.phone === null) missing.push('phone');
  return missing;
}
