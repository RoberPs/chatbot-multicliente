/**
 * Decisión de cada turno (005, contracts/handoff-flow.md § Decisión). Pura: a partir de la
 * salida del modelo, el detector de petición de persona, el paso guardado y las vías, dice qué
 * responder y qué guardar. Gana la primera fila que aplica.
 *
 * Filas en esta versión: 3 (petición con vías), 4 (petición sin vías → 002), 5 (recogida de
 * datos) y 8 (resto). Las filas 1 y 2 (quejas) y 6 y 7 (oferta) aún no existen y caen en la 8.
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

  // Fila 3: petición de persona con vías. Si ya se estaban pidiendo los datos, se recalcula el
  // tipo y se siguen pidiendo los que falten.
  if (request && input.hasRoutes) {
    if (collecting) {
      if (reply.refusesContact) return { type: 'refused', kind: 'person', step: null, save: {} };
      const got = collect(input, collecting.missing);
      return askOrStart(input, 'person', got.save, got, collecting.phoneRetried);
    }
    return askOrStart(input, 'person', {}, input.known, false);
  }

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

  // Fila 8: respuesta normal; un paso `offered` caduca.
  return { type: 'normal', step: null };
}
