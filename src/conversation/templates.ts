/**
 * Plantillas fijas de las respuestas (contracts/bot-replies.md). Genéricas, en español y con
 * variante tú/usted según `snapshot.tone.addressForm` (null → tú). No contienen cifras propias:
 * todo dato sale del snapshot o de la configuración de la instancia.
 */
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type {
  AddressForm,
  HandoffChannel,
  KnowledgeSnapshot,
  WeeklySlot,
  Weekday,
} from '../knowledge/types.js';
import { slotsForWeekday } from '../knowledge/time/intervals.js';
import { conversationSettings } from './settings.js';

export type Form = 'tu' | 'usted';

export const formOf = (addressForm: AddressForm | null): Form =>
  addressForm === 'formal' ? 'usted' : 'tu';

const DAY_NAMES: Record<Weekday, string> = {
  1: 'lunes',
  2: 'martes',
  3: 'miércoles',
  4: 'jueves',
  5: 'viernes',
  6: 'sábado',
  7: 'domingo',
};

/** "09:00" → "9:00". */
export const displayTime = (t: string): string => t.replace(/^0(\d):/, '$1:');

/** Teléfono en formato internacional legible ("+34 611 22 23 33"). */
export function displayPhone(value: string): string {
  const phone = parsePhoneNumberFromString(value);
  return phone?.isValid() ? phone.formatInternational() : value;
}

/** "a, b y c". */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`;
}

function describeDays(days: Weekday[]): string {
  // Tramos de días consecutivos: [1..5] → "lunes a viernes".
  const runs: Weekday[][] = [];
  for (const day of days) {
    const run = runs.at(-1);
    if (run && run.at(-1) === day - 1) run.push(day);
    else runs.push([day]);
  }
  const parts = runs.flatMap((run) => {
    const first = run[0] as Weekday;
    const last = run.at(-1) as Weekday;
    if (run.length >= 3) return [`${DAY_NAMES[first]} a ${DAY_NAMES[last]}`];
    return run.map((d) => DAY_NAMES[d]);
  });
  return listJoin(parts);
}

/**
 * Horario semanal agrupando los días con las mismas franjas:
 * "lunes a viernes de 9:00 a 14:00 y de 16:00 a 20:00; sábado de 10:00 a 14:00".
 * `null` si no hay franjas.
 */
export function formatWeeklyHours(slots: WeeklySlot[]): string | null {
  const groups: Array<{ key: string; text: string; days: Weekday[] }> = [];
  for (const day of [1, 2, 3, 4, 5, 6, 7] as Weekday[]) {
    const intervals = slotsForWeekday(slots, day);
    if (intervals.length === 0) continue;
    const key = intervals.map((i) => `${i.start}-${i.end}`).join(',');
    const group = groups.find((g) => g.key === key);
    if (group) {
      group.days.push(day);
    } else {
      const text = listJoin(
        intervals.map((i) => `de ${displayTime(i.start)} a ${displayTime(i.end)}`),
      );
      groups.push({ key, text, days: [day] });
    }
  }
  if (groups.length === 0) return null;
  return groups.map((g) => `${describeDays(g.days)} ${g.text}`).join('; ');
}

const CHANNEL_LABELS: Record<HandoffChannel['type'], string> = {
  phone: 'teléfono',
  whatsapp: 'WhatsApp',
  email: 'correo',
};

const channelText = (c: HandoffChannel) =>
  `${CHANNEL_LABELS[c.type]} ${c.type === 'email' ? c.value : displayPhone(c.value)}`;

/** Bloque CONTACTO desde el contacto efectivo del snapshot (FR-016). */
export function contactBlock(snapshot: KnowledgeSnapshot): string {
  const channels = listJoin(snapshot.handoff.channels.map(channelText));
  const hours = formatWeeklyHours(snapshot.handoff.hours);
  const schedule = hours ? ` Horario de atención: ${hours}.` : '';
  return `Para hablar con una persona de ${snapshot.business.name}: ${channels}.${schedule}`;
}

/** R-SAFE: el verificador ha rechazado dos veces la respuesta del modelo. */
export const safeReply = (_form: Form): string => 'No dispongo de esa información.';

/** R-ERR: el modelo ha fallado o no se ha podido leer la información del negocio. */
export const errorReply = (form: Form): string =>
  form === 'usted'
    ? 'Ahora mismo no puedo responder. Por favor, vuelva a escribirme en unos minutos.'
    : 'Ahora mismo no puedo responder. Por favor, vuelve a escribirme en unos minutos.';

/** CONTACTO-EMERGENCIA: solo con R-ERR cuando el snapshot no se pudo leer. */
export const emergencyContact = (phone: string): string =>
  `Si necesitas hablar con una persona: teléfono ${displayPhone(phone)}.`;

export interface ReplyParts {
  greeting?: string | null;
  body: string;
  fileNotice?: string | null;
  contact?: string | null;
}

/**
 * Une las partes con una línea en blanco. Si se supera el máximo de WhatsApp se recorta el
 * cuerpo, nunca el saludo, el aviso ni el contacto.
 */
export function joinParts(
  parts: ReplyParts,
  max: number = conversationSettings.messageMaxChars,
): { text: string; truncated: boolean } {
  const SEP = '\n\n';
  const fixed = [parts.greeting, parts.fileNotice, parts.contact].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  const fixedLength = fixed.reduce((n, p) => n + p.length, 0) + fixed.length * SEP.length;
  let body = parts.body.trim();
  let truncated = false;
  if (fixedLength + body.length > max) {
    const room = Math.max(0, max - fixedLength - 1);
    body = `${body.slice(0, room).trimEnd()}…`;
    truncated = true;
  }
  const ordered = [parts.greeting, body, parts.fileNotice, parts.contact].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  return { text: ordered.join(SEP), truncated };
}
