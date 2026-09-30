/**
 * Información técnica de una respuesta para "Probar el bot" (004 FR-009, research R7).
 *
 * Traduce el `reply_trace` guardado con cada saliente a las frases que ve el operador. Nunca
 * incluye textos del mensaje ni los valores que el verificador rechazó.
 */
import type { ContactReason, ReplyTrace } from '../conversation/types.js';
import { describeKind } from '../handoff/notices.js';
import type { RouteName } from '../handoff/types.js';

const TEMPLATE_NAMES: Record<NonNullable<ReplyTrace['template']>, string> = {
  'R-SAFE': 'respuesta segura',
  'R-ERR': 'no se ha podido responder',
  'R-MEDIA': 'archivo sin texto',
  'R-AUDIO': 'audio no entendido',
  'R-LIMIT': 'límite de mensajes',
  'R-UNAVAILABLE': 'chat no disponible',
  'R-HANDOFF-ASK': 'pide los datos de contacto',
  'R-HANDOFF-PHONE': 'pide de nuevo el teléfono',
  'R-HANDOFF-OK': 'derivación confirmada',
  'R-HANDOFF-COMPLAINT': 'queja',
  'R-HANDOFF-FAIL': 'no se pudo avisar al negocio',
  'R-HANDOFF-LATE': 'el negocio aún no ha respondido',
};

const CONTACT_REASONS: Record<ContactReason, string> = {
  handoff_requested: 'pidió hablar con una persona',
  offer_contact: 'el modelo ofreció el contacto',
  booking_requested: 'pidió reservar',
  price_on_request: 'precio a consultar',
  template: 'lo incluye la plantilla',
  handoff_unavailable: 'no se pudo avisar al negocio',
  contact_refused: 'no dio sus datos de contacto',
};

/** Segundos con una decimal y coma decimal ("6,1"). */
const seconds = (ms: number): string => (ms / 1000).toFixed(1).replace('.', ',');

export interface TraceRow {
  label: string;
  value: string;
}

const ROUTE_NAMES: Record<RouteName, string> = {
  whatsapp: 'WhatsApp',
  email: 'email',
  simulated: 'simulada',
};

type HandoffTrace = NonNullable<ReplyTrace['handoff']>;

const HANDOFF_ACTIONS: Record<HandoffTrace['action'], string> = {
  offered: 'Ofrece la derivación',
  asked: 'Pide los datos de contacto',
  asked_again: 'Pide de nuevo el teléfono',
  started: 'Derivación iniciada',
  not_started: 'Derivación no iniciada',
  late_notice: 'Aviso de espera al cliente',
};

/** "Derivación iniciada (simulada) · quiere hablar con una persona · vías: simulada enviada". */
export function describeHandoff(handoff: HandoffTrace): string {
  const routes = Object.entries(handoff.routes) as Array<[RouteName, 'sent' | 'failed']>;
  const simulated = routes.length > 0 && routes.every(([r]) => r === 'simulated');
  const parts = [
    `${HANDOFF_ACTIONS[handoff.action]}${handoff.action === 'started' && simulated ? ' (simulada)' : ''}`,
    ...(handoff.kind ? [describeKind(handoff.kind)] : []),
    ...(routes.length > 0
      ? [
          `vías: ${routes
            .map(([r, status]) => `${ROUTE_NAMES[r]} ${status === 'sent' ? 'enviada' : 'falló'}`)
            .join(', ')}`,
        ]
      : []),
  ];
  return parts.join(' · ');
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
    ...(trace.handoff ? [{ label: 'Derivación', value: describeHandoff(trace.handoff) }] : []),
    {
      label: 'Tiempo',
      value:
        trace.modelMs === null
          ? `Respondió en ${seconds(trace.latencyMs)} s`
          : `Respondió en ${seconds(trace.latencyMs)} s (modelo ${seconds(trace.modelMs)} s)`,
    },
  ];
}
