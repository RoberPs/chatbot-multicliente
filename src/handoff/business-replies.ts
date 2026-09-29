/**
 * Lo que el asistente contesta al negocio por WhatsApp (005, contracts/business-alerts.md § Lo
 * que escribe el negocio): acuses de «Le atiendo» y «Terminado» y la ayuda cuando el número de
 * avisos escribe otra cosa. Textos fijos, genéricos y tratando de tú al negocio.
 */
import { displayPhone } from '../conversation/templates.js';
import type { HandoffButtonAction } from './tokens.js';

export type ActResult = 'done' | 'already_confirmed' | 'already_ended' | 'invalid';

export interface ActCustomer {
  name: string;
  /** E.164. */
  phone: string;
}

/** Derivación ya terminada: se recuerda el teléfono por si aún no se ha contactado. */
export const alreadyEndedText = (customer: ActCustomer): string =>
  'Esa derivación ya había terminado y la conversación ha vuelto al asistente; no se ha cambiado ' +
  `nada. Si aún no has contactado con ${customer.name}, su teléfono es ${displayPhone(customer.phone)}.`;

export const INVALID_BUTTON = 'No reconozco ese botón; no se ha cambiado nada.';

/** Acuse de un botón pulsado por el negocio. */
export function businessReply(
  action: HandoffButtonAction,
  result: ActResult,
  customer: ActCustomer | null,
): string {
  if (result === 'invalid' || customer === null) return INVALID_BUTTON;
  if (result === 'already_ended') return alreadyEndedText(customer);
  if (result === 'already_confirmed') return `Ya estaba anotado que atiendes a ${customer.name}.`;
  return action === 'attend'
    ? `Anotado: atiendes a ${customer.name}. Pulsa «Terminado» cuando acabes.`
    : `Anotado: derivación de ${customer.name} terminada. El asistente vuelve a atenderle.`;
}

/** Ayuda al número de avisos cuando escribe algo que no es un botón (FR-008b). */
export const BUSINESS_HELP =
  'Este número es el del asistente automático y no reenvía lo que escribes al cliente. ' +
  'Contesta al cliente desde tu teléfono y usa los botones «Le atiendo» y «Terminado» de ' +
  'cada aviso.';
