/**
 * Respuestas fijas de la derivación al cliente (005, contracts/handoff-flow.md § Respuestas).
 * Genéricas, en español, en tú o usted como el resto (`formOf`). No llevan datos del negocio
 * salvo su nombre, el teléfono del propio cliente y, cuando se indica, el bloque CONTACTO.
 */
import { displayPhone, type Form } from '../conversation/templates.js';
import type { ContactField } from './types.js';

/** R-HANDOFF-ASK: una sola pregunta con todo lo que falta (FR-004). */
export function askContactReply(missing: ContactField[], business: string, form: Form): string {
  const usted = form === 'usted';
  const name = missing.includes('name');
  const phone = missing.includes('phone');
  if (name && phone) {
    return usted
      ? `Para que ${business} pueda contactarle, ¿me dice su nombre y un teléfono?`
      : `Para que ${business} pueda contactarte, ¿me dices tu nombre y un teléfono?`;
  }
  if (name) {
    return usted
      ? `Para pasarle su consulta a ${business}, ¿me dice su nombre?`
      : `Para pasarle tu consulta a ${business}, ¿me dices tu nombre?`;
  }
  return usted
    ? `¿Me dice un teléfono en el que ${business} pueda contactarle?`
    : `¿Me dices un teléfono en el que ${business} pueda contactarte?`;
}

/** R-HANDOFF-PHONE: el teléfono no es válido; se pide una vez más (FR-005). */
export const phoneRetryReply = (form: Form): string =>
  form === 'usted'
    ? 'Ese teléfono no parece válido. ¿Me lo escribe de nuevo, con el prefijo internacional si no es un número nacional?'
    : 'Ese teléfono no parece válido. ¿Me lo escribes de nuevo, con el prefijo internacional si no es un número nacional?';

/**
 * R-HANDOFF-OK con el negocio atendiendo: solo se dice con el aviso entregado (FR-010). En
 * WhatsApp el teléfono es el del propio cliente.
 */
export function confirmedReply(business: string, phone: string, form: Form): string {
  const contact = form === 'usted' ? 'Le contactarán' : 'Te contactarán';
  return `He avisado a ${business}. ${contact} en el ${displayPhone(phone)} lo antes posible.`;
}
