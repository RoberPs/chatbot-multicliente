/**
 * Composición de los mensajes al negocio (005, contracts/business-alerts.md). Textos fijos y
 * genéricos: solo cambian los datos del cliente y de la derivación. El negocio se trata de tú.
 * Las vías traducen el `BusinessNotice` a su formato; el texto del email vive aquí porque la
 * vía simulada del playground enseña ese mismo texto.
 */
import { addDays, localNow } from '../conversation/facts.js';
import type { Channel } from '../conversation/channels.js';
import { displayPhone, displayTime } from '../conversation/templates.js';
import {
  customerQuote,
  quoteForEmail,
  quoteReason,
  quoteSummaryForTemplate,
} from './customer-text.js';
import { dayAndMonth } from './schedule.js';
import type { BusinessNotice, ForwardItem, HandoffKind, NoticeHandoff } from './types.js';

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
 * espacios seguidos ni variables vacías (R6). Se tratan también los demás caracteres de control,
 * los separadores de línea Unicode y los espacios Unicode repetidos (NBSP…).
 */
export function sanitizeTemplateVar(value: string): string {
  const clean = value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim();
  return clean === '' ? '—' : clean;
}

/**
 * Nombre del cliente en los avisos (012, FR-017): en una línea y con sus direcciones desactivadas;
 * lo escribe el cliente (nombre que dio o perfil de WhatsApp).
 */
const customerName = (h: NoticeHandoff): string =>
  customerQuote(h.customerName).replace(/\s+/gu, ' ').trim() || '—';

export function alertNotice(data: Omit<NoticeHandoff, 'threadRef'>): BusinessNotice {
  return { type: 'alert', handoff: { ...data, threadRef: null } };
}

/**
 * `{{1}}`–`{{5}}` de `derivacion_aviso`: nombre, teléfono, canal, tipo y motivo. El motivo va
 * delimitado como texto del cliente (012); la plantilla aprobada no cambia.
 */
export function alertTemplateVars(notice: BusinessNotice): string[] {
  const h = notice.handoff;
  return [
    customerName(h),
    displayPhone(h.customerPhone),
    describeChannel(h.channel),
    describeKind(h.kind),
    quoteSummaryForTemplate(sanitizeTemplateVar(h.summary)),
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
    `Cliente: ${customerName(h)}`,
    `Teléfono: ${displayPhone(h.customerPhone)}`,
    `Canal: ${describeChannel(h.channel)}`,
    `Tipo: ${describeKind(h.kind)}`,
    `Desde: ${describeSince(h.startedAt, now, h.timezone)}`,
    quoteReason(h.summary),
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
    subject: `Derivación: ${customerName(h)} (${describeKind(h.kind)})`,
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

/** Máximo de `{{3}}` en `derivacion_mensaje` (R6). */
export const FORWARD_TEMPLATE_MAX = 700;
const CUT_WITH_EMAIL = '… (mensaje recortado; el texto completo está en el email)';
const CUT_WITHOUT_EMAIL = '… (mensaje recortado)';

export function forwardNotice(
  handoff: NoticeHandoff,
  items: ForwardItem[],
  emailAvailable: boolean,
): BusinessNotice {
  return { type: 'forward', handoff, items, emailAvailable };
}

/** Texto de un mensaje reenviado: el suyo o, si es un archivo sin texto, `[tipo]`. */
export const forwardItemText = (item: ForwardItem): string =>
  item.text !== null && item.text.trim() !== '' ? item.text : `[${item.otherType ?? item.kind}]`;

const FORWARD_OPEN = 'El cliente escribió: «';
const FORWARD_CLOSE = '»';

/**
 * `{{1}}`–`{{3}}` de `derivacion_mensaje`: nombre, teléfono y los textos del lote separados por
 * " / ", delimitados como texto del cliente (012) y recortados para que la variable no pase de 700
 * caracteres, con la coletilla que corresponda.
 */
export function forwardTemplateVars(
  notice: Extract<BusinessNotice, { type: 'forward' }>,
): string[] {
  const h = notice.handoff;
  const joined = sanitizeTemplateVar(
    notice.items.map((item) => customerQuote(forwardItemText(item))).join(' / '),
  );
  const cut = notice.emailAvailable ? CUT_WITH_EMAIL : CUT_WITHOUT_EMAIL;
  const budget = FORWARD_TEMPLATE_MAX - FORWARD_OPEN.length - FORWARD_CLOSE.length;
  const inner =
    joined.length <= budget ? joined : `${joined.slice(0, budget - cut.length).trimEnd()}${cut}`;
  return [customerName(h), displayPhone(h.customerPhone), FORWARD_OPEN + inner + FORWARD_CLOSE].map(
    sanitizeTemplateVar,
  );
}

/** Email del reenvío: cada mensaje completo, en orden y con su hora local (R7). */
export function forwardEmail(
  notice: Extract<BusinessNotice, { type: 'forward' }>,
  baseUrl: string | null,
): EmailContent {
  const h = notice.handoff;
  // Texto del cliente sangrado y entre comillas (012): nada suyo empieza en la columna 0, donde
  // están los enlaces «Le atiendo» y «Terminado».
  const lines = notice.items.flatMap((item) => {
    const time = displayTime(localNow(item.sentAt, h.timezone).time);
    return quoteForEmail(forwardItemText(item), `[${time}] `);
  });
  return {
    subject: `Mensaje de ${customerName(h)} durante la derivación`,
    text: [
      `${customerName(h)} (${displayPhone(h.customerPhone)}) ha escrito durante la derivación.`,
      '',
      'El cliente escribió:',
      ...lines,
      '',
      'Contéstale desde tu teléfono; el asistente no le responde mientras tanto.',
      '',
      ...linkLines(h, baseUrl),
    ]
      .join('\n')
      .trimEnd(),
  };
}

export function reminderNotice(
  handoff: NoticeHandoff,
  trigger: 'schedule' | 'inactivity',
): BusinessNotice {
  return { type: 'reminder', handoff, waitingSince: handoff.startedAt, trigger };
}

/** `{{1}}`–`{{4}}` de `derivacion_recordatorio`: nombre, teléfono, desde y motivo. */
export function reminderTemplateVars(
  notice: Extract<BusinessNotice, { type: 'reminder' }>,
  now: Date,
): string[] {
  const h = notice.handoff;
  return [
    customerName(h),
    displayPhone(h.customerPhone),
    describeSince(notice.waitingSince, now, h.timezone),
    quoteSummaryForTemplate(sanitizeTemplateVar(h.summary)),
  ].map(sanitizeTemplateVar);
}

const REMINDER_ENDINGS: Record<'schedule' | 'inactivity', string> = {
  schedule: 'Le hemos dado tu contacto directo por si prefiere llamarte.',
  inactivity:
    'Como el cliente no ha escrito en 24 horas, la conversación ha vuelto al asistente, pero ' +
    'sigue esperando que le contactes.',
};

/** Email del recordatorio (FR-019): los datos del aviso, la frase según el momento y los enlaces. */
export function reminderEmail(
  notice: Extract<BusinessNotice, { type: 'reminder' }>,
  now: Date,
  baseUrl: string | null,
): EmailContent {
  const h = notice.handoff;
  return {
    subject: `Recordatorio: ${customerName(h)} sigue esperando`,
    text: [
      'Todavía no consta que hayas contactado con este cliente.',
      '',
      ...customerLines(h, now),
      '',
      REMINDER_ENDINGS[notice.trigger],
      '',
      ...linkLines(h, baseUrl),
    ]
      .join('\n')
      .trimEnd(),
  };
}
