/**
 * Respuestas fijas de la derivación al cliente (005, contracts/handoff-flow.md § Respuestas).
 * Genéricas, en español, en tú o usted como el resto (`formOf`). No llevan datos del negocio
 * salvo su nombre, el teléfono del propio cliente y, cuando se indica, el bloque CONTACTO.
 */
import {
  contactBlock,
  displayPhone,
  formOf,
  joinParts,
  type Form,
} from '../conversation/templates.js';
import type { KnowledgeSnapshot } from '../knowledge/types.js';
import type { Attention } from './schedule.js';
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

/** OFERTA: va tras el cuerpo del modelo, sin CONTACTO (FR-002). */
export const offerQuestion = (business: string, form: Form): string =>
  form === 'usted'
    ? `¿Quiere que le pase su consulta a ${business} para que le contacte?`
    : `¿Quieres que le pase tu consulta a ${business} para que te contacte?`;

/** R-HANDOFF-PHONE: el teléfono no es válido; se pide una vez más (FR-005). */
export const phoneRetryReply = (form: Form): string =>
  form === 'usted'
    ? 'Ese teléfono no parece válido. ¿Me lo escribe de nuevo, con el prefijo internacional si no es un número nacional?'
    : 'Ese teléfono no parece válido. ¿Me lo escribes de nuevo, con el prefijo internacional si no es un número nacional?';

/** "a partir de" + franja: "del lunes…" cuando la franja empieza por "el" ("hoy", "mañana" no). */
const fromOpening = (opening: string): string =>
  opening.startsWith('el ') ? `a partir del ${opening.slice(3)}` : `a partir de ${opening}`;

/**
 * R-HANDOFF-OK: solo se dice con el aviso entregado (FR-010). Con el negocio cerrado da la
 * próxima franja o, si no la hay en 60 días, "en cuanto puedan". En WhatsApp el teléfono es el
 * del propio cliente.
 */
export function confirmedReply(
  business: string,
  phone: string,
  form: Form,
  attention: Attention = { open: true },
): string {
  const where = `en el ${displayPhone(phone)}`;
  if (attention.open) {
    const contact = form === 'usted' ? 'Le contactarán' : 'Te contactarán';
    return `He avisado a ${business}. ${contact} ${where} lo antes posible.`;
  }
  const contact = form === 'usted' ? 'le contactarán' : 'te contactarán';
  const when = attention.from === null ? 'en cuanto puedan' : fromOpening(attention.from);
  return `He avisado a ${business}. Ahora mismo no están atendiendo; ${contact} ${where} ${when}.`;
}

/** R-HANDOFF-LATE (FR-019): el negocio no ha confirmado en 2 horas de horario. Va con CONTACTO. */
export const lateReply = (business: string, form: Form): string =>
  form === 'usted'
    ? `${business} todavía no ha podido responderle. Si lo prefiere, puede contactar directamente:`
    : `${business} todavía no ha podido responderte. Si lo prefieres, puedes contactar directamente:`;

/** R-HANDOFF-LATE completo, sin saludo (la conversación ya tuvo respuestas) y con CONTACTO. */
export function lateReplyWithContact(snapshot: KnowledgeSnapshot): string {
  const body = lateReply(snapshot.business.name, formOf(snapshot.tone.addressForm));
  return joinParts({ body, contact: contactBlock(snapshot) }).text;
}

/**
 * Aviso fijo del chat web y del playground mientras la conversación está derivada (FR-013a):
 * con el teléfono que dio el cliente; nunca los destinos de avisos del negocio.
 */
export function activeHandoffNotice(business: string, phone: string, form: Form): string {
  return form === 'usted'
    ? `Hemos avisado a ${business}. Le contactarán en el ${displayPhone(phone)}. Lo que escriba aquí también les llega.`
    : `Hemos avisado a ${business}. Te contactarán en el ${displayPhone(phone)}. Lo que escribas aquí también les llega.`;
}
