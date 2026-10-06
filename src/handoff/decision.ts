/**
 * Decisión de cada turno (005, contracts/handoff-flow.md § Decisión). Pura: a partir de la
 * salida del modelo, el detector de petición de persona, el paso guardado y las vías, dice qué
 * responder y qué guardar. Gana la primera fila que aplica.
 *
 * Filas: 1 y 2 (queja con y sin vías), 3 (petición con vías), 4 (petición sin vías → 002), 5
 * (recogida de datos), 6 (acepta la oferta), 7 (ofrecer) y 8 (resto).
 */
import type { CountryCode } from 'libphonenumber-js';
import type { ModelReply } from '../conversation/types.js';
import { missingContact, normalizeName, resolvePhone } from './contact-data.js';
import type { ContactField, HandoffKind, HandoffStep } from './types.js';

export interface TurnInput {
  step: HandoffStep | null;
  reply: ModelReply;
  /** El detector determinista de la 002 ve una petición de persona en el lote. */
  detector: boolean;
  /** Hay al menos una vía de aviso disponible ahora. */
  hasRoutes: boolean;
  /** WhatsApp: el teléfono y el nombre los da el canal (R15). */
  contactFromChannel: boolean;
  /** Datos ya conocidos antes de este turno; en WhatsApp, el teléfono es el del canal. */
  known: { name: string | null; phone: string | null };
  /** Textos del lote (respaldo para encontrar el teléfono). */
  texts: string[];
  region: CountryCode;
  now: Date;
}

/** Datos de contacto que se guardan en la conversación en este turno (FR-004). */
export interface ContactUpdate {
  name?: string;
  phone?: string;
}

export type TurnDecision =
  /** Filas 4 y 8: respuesta normal de la 002 (con su CONTACTO si toca). */
  | { type: 'normal'; step: null }
  /** Fila 2: queja sin vías → R-HANDOFF-COMPLAINT + CONTACTO, nunca el cuerpo del modelo. */
  | { type: 'complaint_contact'; step: null }
  /** Fila 7: cuerpo del modelo + OFERTA, sin CONTACTO (FR-002). */
  | { type: 'offer'; step: HandoffStep }
  /** R-HANDOFF-ASK (o R-HANDOFF-PHONE con `retry`): se piden los datos que faltan. */
  | {
      type: 'ask';
      kind: HandoffKind;
      missing: ContactField[];
      retry: boolean;
      step: HandoffStep;
      save: ContactUpdate;
    }
  /** Datos completos: se intenta iniciar la derivación (§ Inicio). */
  | { type: 'start'; kind: HandoffKind; step: null; save: ContactUpdate }
  /** El cliente no da sus datos (o da un teléfono no válido dos veces): CONTACTO (FR-004). */
  | { type: 'refused'; kind: HandoffKind; step: null; save: ContactUpdate };

interface Collected {
  save: ContactUpdate;
  name: string | null;
  phone: string | null;
  phoneInvalid: boolean;
}

/** Datos que el cliente da en este turno mientras se le piden (`collecting`). */
function collect(input: TurnInput, asked: ContactField[]): Collected {
  const save: ContactUpdate = {};
  let { name, phone } = input.known;
  let phoneInvalid = false;
  if (asked.includes('name')) {
    const given = normalizeName(input.reply.contactName);
    if (given !== null) {
      save.name = given;
      name = given;
    }
  }
  if (asked.includes('phone')) {
    const result = resolvePhone(input.reply.contactPhone, input.texts, input.region);
    if (result.status === 'valid') {
      save.phone = result.phone;
      phone = result.phone;
    } else if (result.status === 'invalid') {
      phoneInvalid = true;
    }
  }
  return { save, name, phone, phoneInvalid };
}

const stepAt = (input: TurnInput) => input.now.toISOString();

/** Pide lo que falte o, si no falta nada, inicia. */
function askOrStart(
  input: TurnInput,
  kind: HandoffKind,
  save: ContactUpdate,
  known: { name: string | null; phone: string | null },
  phoneRetried: boolean,
): TurnDecision {
  const missing = missingContact(input.contactFromChannel, known);
  if (missing.length === 0) return { type: 'start', kind, step: null, save };
  return {
    type: 'ask',
    kind,
    missing,
    retry: false,
    save,
    step: { step: 'collecting', kind, missing, phoneRetried, at: stepAt(input) },
  };
}

export function decide(input: TurnInput): TurnDecision {
  const { reply, step } = input;
  const request = reply.handoffRequested || input.detector;
  const collecting = step?.step === 'collecting' ? step : null;

  /**
   * Filas 1 y 3: derivar sin pedir aceptación. Si ya se estaban pidiendo los datos, se
   * recalcula el tipo y se siguen pidiendo los que falten.
   */
  const derive = (kind: HandoffKind): TurnDecision => {
    if (!collecting) return askOrStart(input, kind, {}, input.known, false);
    if (reply.refusesContact) return { type: 'refused', kind, step: null, save: {} };
    const got = collect(input, collecting.missing);
    return askOrStart(input, kind, got.save, got, collecting.phoneRetried);
  };

  // Filas 1 y 2: una queja gana sobre todo lo demás (FR-003).
  if (reply.complaint) {
    return input.hasRoutes ? derive('complaint') : { type: 'complaint_contact', step: null };
  }

  // Fila 3: petición de persona con vías.
  if (request && input.hasRoutes) return derive('person');

  // Fila 4: petición sin vías → como en la 002 (cuerpo + CONTACTO).
  if (request) return { type: 'normal', step: null };

  // Fila 5: se estaban pidiendo los datos.
  if (collecting) {
    const kind = collecting.kind;
    if (reply.refusesContact) return { type: 'refused', kind, step: null, save: {} };
    const got = collect(input, collecting.missing);
    const missing = missingContact(input.contactFromChannel, got);
    if (missing.length === 0) return { type: 'start', kind, step: null, save: got.save };
    if (got.phoneInvalid && !collecting.phoneRetried) {
      return {
        type: 'ask',
        kind,
        missing,
        retry: true,
        save: got.save,
        step: { step: 'collecting', kind, missing, phoneRetried: true, at: stepAt(input) },
      };
    }
    return { type: 'refused', kind, step: null, save: got.save };
  }

  // Fila 6: el cliente acepta la oferta del turno anterior.
  if (step?.step === 'offered' && reply.acceptsHandoff) {
    return askOrStart(input, 'unresolved', {}, input.known, false);
  }

  // Fila 7: sin el dato o con una gestión que no se hace por aquí, se ofrece si hay vías. La
  // oferta anterior, si la había, se sustituye por esta.
  if ((reply.offerContact || reply.bookingRequested) && input.hasRoutes && !reply.needsRephrase) {
    return { type: 'offer', step: { step: 'offered', kind: 'unresolved', at: stepAt(input) } };
  }

  // Fila 8: respuesta normal; un paso `offered` caduca (US2-3).
  return { type: 'normal', step: null };
}
