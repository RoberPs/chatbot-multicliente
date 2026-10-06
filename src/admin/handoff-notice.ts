/**
 * Textos para el operador sobre el contacto que usa el bot (003, FR-005 – FR-007): el recuadro
 * de Datos y Derivación y el mensaje del flash tras guardar. El dominio solo da los datos
 * (`EffectiveHandoff`, `HandoffChange`); las frases viven aquí (contracts/admin-panel.md).
 */
import { sameContact } from '../knowledge/handoff.js';
import type {
  EffectiveHandoff,
  HandoffChange,
  HandoffChannel,
  HandoffChannelType,
} from '../knowledge/types.js';

const CHANNEL_LABEL: Record<HandoffChannelType, string> = {
  phone: 'Teléfono',
  whatsapp: 'WhatsApp',
  email: 'Email',
};

/** Medios en orden: `Teléfono +34…, WhatsApp +34…, Email …`. */
export const formatChannels = (channels: HandoffChannel[]): string =>
  channels.map((c) => `${CHANNEL_LABEL[c.type]} ${c.value}`).join(', ');

/** Destino tal como se muestra: los medios, o el número si es el teléfono del negocio. */
const contactText = (effective: EffectiveHandoff): string =>
  effective.source === 'business_phone'
    ? (effective.channels[0]?.value ?? '')
    : formatChannels(effective.channels);

const ORIGIN: Record<'configured' | 'business_phone', string> = {
  configured: 'contacto de derivación configurado',
  business_phone: 'teléfono del negocio',
};

export interface EffectiveHandoffNotice {
  /** Frase principal, en negrita. */
  lead: string;
  /** Medios o teléfono; `null` si no hay a quién pasar las conversaciones. */
  contact: string | null;
  /** Origen o qué hacer, en cursiva. */
  note: string;
  none: boolean;
}

/** Recuadro "Contacto que usa el bot" (FR-005). */
export function effectiveHandoffNotice(effective: EffectiveHandoff): EffectiveHandoffNotice {
  switch (effective.source) {
    case 'configured':
      return {
        lead: 'El bot pasa las conversaciones a:',
        contact: contactText(effective),
        note: 'Origen: contacto de derivación configurado.',
        none: false,
      };
    case 'business_phone':
      return {
        lead: 'El bot pasa las conversaciones a:',
        contact: contactText(effective),
        note: 'Origen: teléfono del negocio, porque no hay contacto de derivación configurado.',
        none: false,
      };
    case 'none':
      return {
        lead: 'El bot no tiene a quién pasar las conversaciones.',
        contact: null,
        note: 'Registra un contacto de derivación o el teléfono del negocio.',
        none: true,
      };
  }
}

/** Pantalla desde la que se guardó: cambia la explicación cuando el contacto sigue igual. */
export type HandoffScreen = 'business' | 'handoff';

/** Mensaje del flash tras un guardado correcto de Datos o Derivación (FR-006, FR-007). */
export function handoffChangeMessage(change: HandoffChange, screen: HandoffScreen): string {
  const { after } = change;
  if (!sameContact(change.before, after)) {
    switch (after.source) {
      case 'configured':
        return `Guardado. A partir de ahora el bot pasa las conversaciones al contacto de derivación configurado: ${contactText(after)}.`;
      case 'business_phone':
        return `Guardado. No hay contacto de derivación configurado, así que el bot pasa las conversaciones al teléfono del negocio: ${contactText(after)}.`;
      case 'none':
        // Con el negocio activo no se llega aquí: FR-032 rechaza el guardado antes.
        return 'Guardado. El negocio se ha quedado sin salida a una persona: el bot no tiene a quién pasar las conversaciones. No se podrá activar hasta que registres un contacto de derivación o el teléfono del negocio.';
    }
  }
  if (!change.touched || after.source === 'none') return 'Guardado';
  if (screen === 'business' && after.source === 'configured') {
    return `Guardado. El teléfono del negocio no se usa para pasar conversaciones porque hay un contacto de derivación configurado; el bot sigue pasándolas a: ${contactText(after)}.`;
  }
  return `Guardado. El bot sigue pasando las conversaciones a: ${contactText(after)} (${ORIGIN[after.source]}).`;
}
