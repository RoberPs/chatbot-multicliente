/**
 * Hechos calculados por código a partir del snapshot (research R8, capa 1) y conjunto de
 * valores que el verificador de cifras acepta (capa 3). El modelo nunca calcula horarios.
 */
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { formatCents } from '../knowledge/money.js';
import { effectiveIntervals, isOpenAt, isoWeekday } from '../knowledge/time/intervals.js';
import type { ISODate, KnowledgeSnapshot, SnapshotPrice, WeeklySlot } from '../knowledge/types.js';
import { extractFacts } from './grounding.js';
import { formatWeeklyHours } from './templates.js';
import type { AllowedFacts, DerivedFacts } from './types.js';

const HORIZON_DAYS = 14;

/** Fecha, hora y día ISO de un instante en la zona horaria del negocio. */
export function localNow(at: Date, timezone: string): DerivedFacts['now'] {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, time: `${parts.hour}:${parts.minute}`, weekday: isoWeekday(date), timezone };
}

/**
 * Precio de un servicio tal como el bot debe decirlo (FR-009 – FR-011): "25,00 €",
 * "desde 40,00 €", "a consultar" o "sin importe registrado". Espacios normales, no duros.
 */
export function priceText(price: SnapshotPrice, currency: string): string {
  const amount = (cents: number) => formatCents(cents, currency).replace(/\s/g, ' ');
  switch (price.type) {
    case 'fixed':
      return amount(price.amountCents);
    case 'from':
      return `desde ${amount(price.amountCents)}`;
    case 'on_request':
      return 'a consultar';
    case 'missing':
      return 'sin importe registrado';
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Plazo en minutos como lo diría una persona: "60 días", "2 horas", "1 h 30 min". */
export function durationText(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return plural(minutes / 1440, 'día', 'días');
  if (minutes >= 60 && minutes % 60 === 0) return plural(minutes / 60, 'hora', 'horas');
  if (minutes > 60) return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  return plural(minutes, 'minuto', 'minutos');
}

const optionalDuration = (minutes: number | null) =>
  minutes === null ? null : durationText(minutes);

/** Suma días a una fecha de calendario (sin zona horaria). */
export function addDays(date: ISODate, days: number): ISODate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function deriveFacts(snapshot: KnowledgeSnapshot, at: Date): DerivedFacts {
  const now = localNow(at, snapshot.business.timezone);
  const { openingHours, closures } = snapshot;
  const next14Days = Array.from({ length: HORIZON_DAYS }, (_, i) => {
    const date = addDays(now.date, i);
    const closure = closures.find((c) => c.startDate <= date && date <= c.endDate);
    return {
      date,
      weekday: isoWeekday(date),
      intervals: effectiveIntervals(openingHours, closures, date),
      closureReason: closure?.reason ?? null,
    };
  });
  return {
    now,
    openNow: isOpenAt(openingHours, closures, now.date, now.time),
    next14Days,
    prices: snapshot.services.map((s) => ({
      serviceId: s.id,
      text: priceText(s.price, snapshot.business.currency),
    })),
    policies: {
      cancellationNotice: optionalDuration(snapshot.policies.cancellationNoticeMinutes),
      minAdvance: optionalDuration(snapshot.policies.minAdvanceMinutes),
      maxAdvance: optionalDuration(snapshot.policies.maxAdvanceMinutes),
    },
    handoffHoursText: formatWeeklyHours(snapshot.handoff.hours),
  };
}

/** Número canónico: "35,50" → "35.5", "015" → "15". */
export const canonicalNumber = (n: number | string): string =>
  String(Number(String(n).replace(',', '.')));

/** Un plazo en minutos y sus equivalentes en horas y días. */
function durationNumbers(minutes: number): string[] {
  const out = [minutes];
  if (minutes % 30 === 0) out.push(minutes / 60);
  if (minutes >= 60) out.push(Math.floor(minutes / 60), minutes % 60);
  if (minutes % 1440 === 0) out.push(minutes / 1440);
  return out.filter((n) => n > 0).map(canonicalNumber);
}

/** Todos los textos del snapshot (sin ids ni marcas internas). */
function snapshotTexts(value: unknown, key = ''): string[] {
  if (['id', 'serviceIds', 'resourceIds', 'updatedAt', 'timezone', 'currency'].includes(key)) {
    return [];
  }
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((v) => snapshotTexts(v));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => snapshotTexts(v, k));
  }
  return [];
}

function phoneVariants(value: string): string[] {
  const digits = value.replace(/\D/g, '');
  const out = [digits];
  const phone = parsePhoneNumberFromString(value.trim().startsWith('+') ? value : `+${digits}`);
  if (phone?.isValid()) out.push(phone.number.slice(1), phone.nationalNumber);
  return out;
}

export function buildAllowedFacts(
  snapshot: KnowledgeSnapshot,
  derived: DerivedFacts,
): AllowedFacts {
  const allowed: AllowedFacts = {
    times: new Set(),
    dates: new Set(),
    phones: new Set(),
    emails: new Set(),
    urls: new Set(),
    amountsCents: new Set(),
    numbers: new Set(),
  };
  const addDate = (date: ISODate) => {
    allowed.dates.add(date.slice(5));
    const [year, month, day] = date.split('-');
    for (const n of [year, month, day]) if (n) allowed.numbers.add(canonicalNumber(n));
  };
  const addSlots = (slots: Array<Pick<WeeklySlot, 'start' | 'end'>>) => {
    for (const s of slots) {
      allowed.times.add(s.start);
      allowed.times.add(s.end);
    }
  };

  // Textos libres del snapshot: todo lo que el operador ha escrito vale tal cual.
  for (const text of snapshotTexts(snapshot)) {
    for (const fact of extractFacts(text)) {
      if (fact.category === 'amount') {
        allowed.amountsCents.add(Number(fact.value));
        continue;
      }
      const set = allowed[`${fact.category}s` as keyof AllowedFacts] as Set<string> | undefined;
      set?.add(fact.value);
      // Una dirección registrada vale también por host + ruta (012).
      if (fact.category === 'url') for (const v of fact.alternatives ?? []) allowed.urls.add(v);
      if (fact.category === 'phone') for (const v of phoneVariants(fact.raw)) allowed.phones.add(v);
    }
  }

  // Horarios, cierres y ausencias.
  addSlots(snapshot.openingHours);
  addSlots(snapshot.handoff.hours);
  const blocks = [
    ...snapshot.closures,
    ...(snapshot.scheduling.mode === 'resources'
      ? snapshot.scheduling.resources.flatMap((r) => {
          addSlots(r.hours);
          return r.absences;
        })
      : []),
  ];
  for (const b of blocks) {
    addDate(b.startDate);
    addDate(b.endDate);
    if (b.startTime && b.endTime) addSlots([{ start: b.startTime, end: b.endTime }]);
  }

  // Hechos calculados.
  allowed.times.add(derived.now.time);
  addDate(derived.now.date);
  allowed.numbers.add(canonicalNumber(HORIZON_DAYS));
  for (const day of derived.next14Days) {
    addDate(day.date);
    addSlots(day.intervals);
  }

  // Teléfonos y correo del negocio y del contacto.
  const phones = [
    snapshot.business.phone,
    ...snapshot.handoff.channels.filter((c) => c.type !== 'email').map((c) => c.value),
  ].filter((p): p is string => p !== null);
  for (const p of phones) for (const v of phoneVariants(p)) allowed.phones.add(v);
  for (const email of [
    snapshot.business.email,
    ...snapshot.handoff.channels.filter((c) => c.type === 'email').map((c) => c.value),
  ]) {
    if (email) allowed.emails.add(email.toLowerCase());
  }

  // Duraciones y antelaciones (minutos y sus equivalentes).
  const minutes = [
    ...snapshot.services.map((s) => s.durationMinutes),
    snapshot.policies.cancellationNoticeMinutes,
    snapshot.policies.minAdvanceMinutes,
    snapshot.policies.maxAdvanceMinutes,
  ].filter((m): m is number => m !== null);
  for (const m of minutes) for (const n of durationNumbers(m)) allowed.numbers.add(n);

  // Importes de los servicios: en céntimos y en unidades ("25.00" sin símbolo).
  for (const s of snapshot.services) {
    if (s.price.type !== 'fixed' && s.price.type !== 'from') continue;
    allowed.amountsCents.add(s.price.amountCents);
    allowed.numbers.add(canonicalNumber(s.price.amountCents / 100));
  }

  return allowed;
}
