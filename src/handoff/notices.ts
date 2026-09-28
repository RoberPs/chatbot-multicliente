/**
 * Composición de los mensajes al negocio (005, contracts/business-alerts.md). Textos fijos y
 * genéricos: solo cambian los datos del cliente y de la derivación. El negocio se trata de tú.
 * Las vías traducen el `BusinessNotice` a su formato; el texto del email vive aquí porque la
 * vía simulada del playground enseña ese mismo texto.
 */
import { addDays, localNow } from '../conversation/facts.js';
import type { Channel } from '../conversation/channels.js';
import { displayPhone, displayTime } from '../conversation/templates.js';
import { dayAndMonth } from './schedule.js';
import type { BusinessNotice, HandoffKind, NoticeHandoff } from './types.js';

const CHANNEL_NAMES: Record<Channel, string> = {
  whatsapp: 'WhatsApp',
  web: 'chat de la web',
  playground: 'prueba del panel',
};

const KIND_NAMES: Record<HandoffKind, string> = {
  person: 'quiere hablar con una persona',
  unresolved: 'consulta sin resolver',
  complaint: 'queja o reclamación',
};

export const describeChannel = (channel: Channel): string => CHANNEL_NAMES[channel];
export const describeKind = (kind: HandoffKind): string => KIND_NAMES[kind];

/** Hora local del negocio relativa a `now`: "hoy a las 21:40", "ayer a las 18:05"… */
export function describeSince(at: Date, now: Date, timezone: string): string {
  const local = localNow(at, timezone);
  const today = localNow(now, timezone).date;
  const time = displayTime(local.time);
  if (local.date === today) return `hoy a las ${time}`;
  if (local.date === addDays(today, -1)) return `ayer a las ${time}`;
  return `el ${dayAndMonth(local.date)} a las ${time}`;
}

/**
 * Variable de una plantilla de WhatsApp: Meta no admite saltos de línea, tabuladores, más de 4
 * espacios seguidos ni variables vacías (R6).
 */
export function sanitizeTemplateVar(value: string): string {
  const clean = value
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  return clean === '' ? '—' : clean;
}

export function alertNotice(data: Omit<NoticeHandoff, 'threadRef'>): BusinessNotice {
  return { type: 'alert', handoff: { ...data, threadRef: null } };
}

/** `{{1}}`–`{{5}}` de `derivacion_aviso`: nombre, teléfono, canal, tipo y motivo. */
export function alertTemplateVars(notice: BusinessNotice): string[] {
  const h = notice.handoff;
  return [
    h.customerName,
    displayPhone(h.customerPhone),
    describeChannel(h.channel),
    describeKind(h.kind),
    h.summary,
  ].map(sanitizeTemplateVar);
}

/** Enlaces «Le atiendo» y «Terminado» del email (R8). */
export function handoffLinks(baseUrl: string, token: string): { attend: string; end: string } {
  return {
    attend: `${baseUrl}/handoff/${token}/attend`,
    end: `${baseUrl}/handoff/${token}/end`,
  };
}

export interface EmailContent {
  subject: string;
  text: string;
}

function customerLines(h: NoticeHandoff, now: Date): string[] {
  return [
    `Cliente: ${h.customerName}`,
    `Teléfono: ${displayPhone(h.customerPhone)}`,
    `Canal: ${describeChannel(h.channel)}`,
    `Tipo: ${describeKind(h.kind)}`,
    `Desde: ${describeSince(h.startedAt, now, h.timezone)}`,
    `Motivo: ${h.summary}`,
  ];
}

function linkLines(h: NoticeHandoff, baseUrl: string | null): string[] {
  if (baseUrl === null) return [];
  const links = handoffLinks(baseUrl, h.token);
  return [`Le atiendo: ${links.attend}`, `Terminado:  ${links.end}`, ''];
}

/**
 * Email del aviso (texto plano). Sin URL pública (playground) no lleva enlaces: la vía email
 * real siempre la tiene.
 */
export function alertEmail(
  notice: BusinessNotice,
  now: Date,
  baseUrl: string | null,
): EmailContent {
  const h = notice.handoff;
  return {
    subject: `Derivación: ${h.customerName} (${describeKind(h.kind)})`,
    text: [
      'El asistente ha pasado una conversación a tu negocio.',
      '',
      ...customerLines(h, now),
      '',
      'Contacta con el cliente desde tu teléfono. Mientras tanto el asistente no le responde.',
      '',
      ...linkLines(h, baseUrl),
      'Si no confirmas en 2 horas de tu horario de atención, te enviaremos un recordatorio y daremos al',
      'cliente tu contacto directo. Si el cliente no escribe en 24 horas, la conversación vuelve al',
      'asistente (y, si no habías confirmado, te enviaremos el recordatorio en ese momento).',
    ].join('\n'),
  };
}
