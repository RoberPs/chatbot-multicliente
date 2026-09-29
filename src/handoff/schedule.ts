/**
 * Horario de atención de la derivación (005, R13). Funciones puras sobre el snapshot: las
 * franjas son horas locales del negocio y solo se convierten a instantes para compararlas con
 * el reloj, con `Intl` y la zona IANA del negocio (nada se guarda en UTC).
 */
import { localNow, addDays } from '../conversation/facts.js';
import { displayTime } from '../conversation/templates.js';
import { effectiveIntervals, isoWeekday } from '../knowledge/time/intervals.js';
import type {
  ISODate,
  KnowledgeSnapshot,
  LocalTime,
  WeeklySlot,
  Weekday,
} from '../knowledge/types.js';

/** Días hacia delante en los que se busca la próxima franja (R13). */
export const HORIZON_DAYS = 60;

const MINUTE = 60_000;

/** Franjas del contacto de derivación si tiene; si no, las del negocio (FR-011). */
export function applicableHours(snapshot: KnowledgeSnapshot): WeeklySlot[] {
  return snapshot.handoff.hours.length > 0 ? snapshot.handoff.hours : snapshot.openingHours;
}

/** Diferencia entre la hora local y UTC en un instante, en ms. */
function offsetAt(instant: number, timezone: string): number {
  const now = localNow(new Date(instant), timezone);
  const [h = 0, m = 0] = now.time.split(':').map(Number);
  const [y = 0, mo = 1, d = 1] = now.date.split('-').map(Number);
  const localAsUtc = Date.UTC(y, mo - 1, d, h, m);
  return localAsUtc - Math.floor(instant / MINUTE) * MINUTE;
}

const toMinutes = (t: LocalTime): number => {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return h * 60 + m;
};

/** Instante exacto de una fecha y hora local, o `null` si esa hora no existe (salto de marzo). */
function exactInstant(date: ISODate, minutes: number, timezone: string): number | null {
  const [y = 0, mo = 1, d = 1] = date.split('-').map(Number);
  const wall = Date.UTC(y, mo - 1, d, 0, minutes);
  const first = wall - offsetAt(wall, timezone);
  const candidates = [first, wall - offsetAt(first, timezone)];
  const valid = candidates.filter((c) => {
    const local = localNow(new Date(c), timezone);
    return local.date === date && toMinutes(local.time) === minutes;
  });
  // En la hora repetida de octubre vale la primera.
  return valid.length > 0 ? Math.min(...valid) : null;
}

/**
 * Instante de una fecha y hora local. Si la hora no existe (cambio de hora de marzo), se avanza
 * al primer minuto válido.
 */
function localToInstant(date: ISODate, minutes: number, timezone: string): number {
  for (let m = minutes; m < minutes + 24 * 60; m++) {
    const day = m >= 24 * 60 ? addDays(date, 1) : date;
    const exact = exactInstant(day, m % (24 * 60), timezone);
    if (exact !== null) return exact;
  }
  throw new Error('Zona horaria sin horas válidas');
}

interface Window {
  start: number;
  end: number;
}

/**
 * Franjas efectivas como instantes, en orden, desde el día local de `from` y durante 60 días.
 * Es un generador: quien busca la próxima franja para en cuanto la encuentra.
 */
function* windows(snapshot: KnowledgeSnapshot, from: Date): Generator<Window> {
  const timezone = snapshot.business.timezone;
  const hours = applicableHours(snapshot);
  const today = localNow(from, timezone).date;
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const date = addDays(today, i);
    for (const interval of effectiveIntervals(hours, snapshot.closures, date)) {
      const start = localToInstant(date, toMinutes(interval.start), timezone);
      const end = localToInstant(date, toMinutes(interval.end), timezone);
      if (end > start) yield { start, end };
    }
  }
}

/** Sin franjas registradas en el horario aplicable: se considera abierto siempre (R13). */
const alwaysOpen = (snapshot: KnowledgeSnapshot): boolean => applicableHours(snapshot).length === 0;

/** ¿Se atiende en ese instante? El fin de cada franja es exclusivo. */
export function isOpenAt(snapshot: KnowledgeSnapshot, at: Date): boolean {
  if (alwaysOpen(snapshot)) return true;
  const t = at.getTime();
  for (const w of windows(snapshot, at)) {
    if (w.start > t) return false;
    if (t < w.end) return true;
  }
  return false;
}

/**
 * Inicio de la próxima franja de atención. `null` si ahora se atiende (la confirmación no
 * menciona horarios) o si no hay ninguna franja en 60 días (cierre largo).
 */
export function nextOpening(snapshot: KnowledgeSnapshot, at: Date): Date | null {
  if (alwaysOpen(snapshot)) return null;
  const t = at.getTime();
  for (const w of windows(snapshot, at)) {
    if (w.start <= t && t < w.end) return null;
    if (w.start > t) return new Date(w.start);
  }
  return null;
}

/**
 * Instante en que se cumplen `minutes` minutos contados solo dentro de las franjas (FR-019).
 * Sin franjas, en tiempo real; `null` si no se cumplen en 60 días.
 */
export function addOpenMinutes(
  snapshot: KnowledgeSnapshot,
  at: Date,
  minutes: number,
): Date | null {
  if (alwaysOpen(snapshot)) return new Date(at.getTime() + minutes * MINUTE);
  let remaining = minutes * MINUTE;
  const t = at.getTime();
  for (const w of windows(snapshot, at)) {
    if (w.end <= t) continue;
    const start = Math.max(w.start, t);
    const available = w.end - start;
    if (remaining <= available) return new Date(start + remaining);
    remaining -= available;
  }
  return null;
}

const DAY_NAMES: Record<Weekday, string> = {
  1: 'lunes',
  2: 'martes',
  3: 'miércoles',
  4: 'jueves',
  5: 'viernes',
  6: 'sábado',
  7: 'domingo',
};

const MONTH_NAMES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** "5 de octubre" de una fecha `AAAA-MM-DD`. */
export function dayAndMonth(date: ISODate): string {
  const [, month = 1, day = 1] = date.split('-').map(Number);
  return `${day} de ${MONTH_NAMES[month - 1] ?? ''}`;
}

/**
 * Franja de atención como la dice la confirmación al cliente, en hora local del negocio:
 * "hoy a las 16:00", "mañana a las 9:00" o "el lunes 5 de octubre a las 9:00".
 */
export function describeOpening(instant: Date, now: Date, timezone: string): string {
  const target = localNow(instant, timezone);
  const today = localNow(now, timezone).date;
  const time = displayTime(target.time);
  if (target.date === today) return `hoy a las ${time}`;
  if (target.date === addDays(today, 1)) return `mañana a las ${time}`;
  return `el ${DAY_NAMES[isoWeekday(target.date)]} ${dayAndMonth(target.date)} a las ${time}`;
}

/**
 * Cuándo atenderá el negocio a quien deriva ahora (FR-010): abierto, o cerrado con la próxima
 * franja ya escrita para el cliente (`null` si no hay ninguna en 60 días).
 */
export type Attention = { open: true } | { open: false; from: string | null };

export function attentionAt(snapshot: KnowledgeSnapshot, at: Date): Attention {
  if (isOpenAt(snapshot, at)) return { open: true };
  const next = nextOpening(snapshot, at);
  return {
    open: false,
    from: next === null ? null : describeOpening(next, at, snapshot.business.timezone),
  };
}
