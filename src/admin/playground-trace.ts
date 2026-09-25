/**
 * Información técnica de una respuesta para "Probar el bot" (004 FR-009, research R7).
 *
 * Traduce el `reply_trace` guardado con cada saliente a las frases que ve el operador. Nunca
 * incluye textos del mensaje ni los valores que el verificador rechazó.
 */
import type { ContactReason, ReplyTrace } from '../conversation/types.js';

const TEMPLATE_NAMES: Record<NonNullable<ReplyTrace['template']>, string> = {
  'R-SAFE': 'respuesta segura',
  'R-ERR': 'no se ha podido responder',
  'R-MEDIA': 'archivo sin texto',
  'R-AUDIO': 'audio no entendido',
  'R-LIMIT': 'límite de mensajes',
  'R-UNAVAILABLE': 'chat no disponible',
};

const CONTACT_REASONS: Record<ContactReason, string> = {
  handoff_requested: 'pidió hablar con una persona',
  offer_contact: 'el modelo ofreció el contacto',
  booking_requested: 'pidió reservar',
  price_on_request: 'precio a consultar',
  template: 'lo incluye la plantilla',
};

/** Segundos con una decimal y coma decimal ("6,1"). */
const seconds = (ms: number): string => (ms / 1000).toFixed(1).replace('.', ',');

export interface TraceRow {
  label: string;
  value: string;
}

/** Filas de la tabla técnica, en el orden del contrato. */
export function describeTrace(trace: ReplyTrace): TraceRow[] {
  const rejections = trace.groundingRejections;
  return [
    { label: 'Saludo', value: trace.greeting ? 'Saludo añadido' : 'Sin saludo' },
    {
      label: 'Plantilla',
      value: trace.template
        ? `Plantilla: ${TEMPLATE_NAMES[trace.template]} (${trace.template})`
        : 'Redactada por el modelo',
    },
    {
      label: 'Contacto',
      value:
        trace.contact.added && trace.contact.reason
          ? `Contacto añadido: ${CONTACT_REASONS[trace.contact.reason]}`
          : trace.contact.added
            ? 'Contacto añadido'
            : 'Sin contacto',
    },
    {
      label: 'Verificador',
      value:
        rejections === 0
          ? 'Sin rechazos'
          : `El verificador rechazó ${rejections} borrador${rejections === 1 ? '' : 'es'}`,
    },
    {
      label: 'Tiempo',
      value:
        trace.modelMs === null
          ? `Respondió en ${seconds(trace.latencyMs)} s`
          : `Respondió en ${seconds(trace.latencyMs)} s (modelo ${seconds(trace.modelMs)} s)`,
    },
  ];
}
