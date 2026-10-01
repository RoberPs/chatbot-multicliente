/**
 * Diferencias por sección entre dos documentos del formato (008, research R8): la
 * configuración actual y la que resulta del ensayo (o de la aplicación). Función pura; los
 * valores salen ya formateados para la vista, como en el panel.
 */
import { formatCents } from '../knowledge/money.js';
import { splitMinutes } from '../knowledge/schemas/policies.js';
import type { PriceType, WeeklySlot } from '../knowledge/types.js';
import { WEEKDAY_SHORT } from '../knowledge/warnings.js';
import {
  normalizeKey,
  SECTION_LABELS,
  type ConfigDateBlock,
  type ConfigDocument,
  type FieldChange,
  type SectionDiff,
  type SectionKey,
} from './format.js';

export interface WebChatHighlight {
  destinationEnabled: boolean;
  /** Webs que dejarán de poder usar el chat. */
  removedOrigins: string[];
  addedOrigins: string[];
  capsChanged: boolean;
}

export interface ConfigHighlights {
  timezoneChanged: { before: string; after: string } | null;
  currencyChanged: { before: string; after: string } | null;
  /** Mismo `INSTANCE_ID` en el fichero y en la instancia; `null` si falta alguno. */
  sameInstance: boolean | null;
  /** El fichero trae destinos de los avisos de derivación (FR-013). */
  alertDestinationsIncluded: boolean;
  /** Solo si el chat web del destino está activado (FR-011). */
  webChat: WebChatHighlight | null;
}

export interface DiffOptions {
  destinationWebChatEnabled: boolean;
  sameInstance: boolean | null;
  fileIncludesAlerts: boolean;
}

export interface ConfigDiff {
  sections: SectionDiff[];
  highlights: ConfigHighlights;
}

const EMPTY = '—';

const text = (value: string | null): string => (value === null || value === '' ? EMPTY : value);

/** Textos largos (respuestas, descripciones) recortados en la vista. */
const TEXT_MAX = 160;
const longText = (value: string | null): string => {
  const t = text(value);
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX)}…` : t;
};

const yesNo = (value: boolean): string => (value ? 'Sí' : 'No');

const PRICE_TYPES: Record<PriceType, string> = {
  fixed: 'Precio fijo',
  from: 'Desde',
  on_request: 'A consultar',
};

const money = (cents: number | null, currency: string): string =>
  cents === null ? 'Sin importe' : formatCents(cents, currency);

/** Minutos en la mayor unidad exacta, como el formulario de políticas del panel. */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return EMPTY;
  const { value, unit } = splitMinutes(minutes);
  if (unit === 'days') return `${value} ${value === '1' ? 'día' : 'días'}`;
  if (unit === 'hours') return `${value} ${value === '1' ? 'hora' : 'horas'}`;
  return `${value} min`;
}

const day = (weekday: number): string => WEEKDAY_SHORT[weekday - 1] ?? String(weekday);

/** `lun 09:00–14:00, 16:00–20:00` para las franjas de un día. */
const daySlots = (weekday: number, slots: WeeklySlot[]): string =>
  `${day(weekday)} ${slots
    .filter((s) => s.weekday === weekday)
    .map((s) => `${s.start}–${s.end}`)
    .join(', ')}`;

/** Todas las franjas: `lun 09:00–14:00 · mar 09:00–14:00`. */
export function formatSlots(slots: WeeklySlot[]): string {
  const days = [...new Set(slots.map((s) => s.weekday))].sort((a, b) => a - b);
  return days.length === 0 ? EMPTY : days.map((d) => daySlots(d, slots)).join(' · ');
}

const date = (iso: string): string => iso.split('-').reverse().join('/');

/** `24/12/2026 – 26/12/2026` o `02/11/2026 09:00–12:00`. */
export function formatBlock(b: ConfigDateBlock): string {
  const dates = b.startDate === b.endDate ? date(b.startDate) : `${date(b.startDate)} – ${date(b.endDate)}`;
  return b.startTime && b.endTime ? `${dates} ${b.startTime}–${b.endTime}` : dates;
}

const list = (values: string[]): string => (values.length === 0 ? EMPTY : values.join(', '));

const CHANNEL_TYPES: Record<string, string> = {
  phone: 'Teléfono',
  whatsapp: 'WhatsApp',
  email: 'Email',
};

/** Campo que cambia, o nada. */
function change(field: string, fieldLabel: string, before: string, after: string): FieldChange[] {
  return before === after ? [] : [{ field, fieldLabel, before, after }];
}

function emptySection(section: SectionKey): SectionDiff {
  return {
    section,
    sectionLabel: SECTION_LABELS[section],
    added: [],
    modified: [],
    removed: [],
    reordered: false,
  };
}

const hasChanges = (s: SectionDiff): boolean =>
  s.added.length > 0 || s.modified.length > 0 || s.removed.length > 0 || s.reordered;

/** ¿Cambia el orden relativo de los elementos que están en las dos listas? */
function reordered(before: string[], after: string[]): boolean {
  const inAfter = new Set(after);
  const inBefore = new Set(before);
  const a = before.filter((k) => inAfter.has(k));
  const b = after.filter((k) => inBefore.has(k));
  return a.join('\n') !== b.join('\n');
}

/**
 * Empareja dos listas por clave (en orden entre repetidas) y devuelve añadidos, eliminados y
 * pares emparejados. Las claves repetidas se numeran para compararlas en orden.
 */
function pairUp<T>(
  before: T[],
  after: T[],
  keyOf: (item: T) => string,
): { pairs: Array<[T, T]>; added: T[]; removed: T[]; beforeKeys: string[]; afterKeys: string[] } {
  const numbered = (items: T[]) => {
    const seen = new Map<string, number>();
    return items.map((item) => {
      const key = keyOf(item);
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return `${key}#${n}`;
    });
  };
  const beforeKeys = numbered(before);
  const afterKeys = numbered(after);
  const byKey = new Map(beforeKeys.map((k, i) => [k, before[i] as T]));
  const pairs: Array<[T, T]> = [];
  const added: T[] = [];
  afterKeys.forEach((k, i) => {
    const previous = byKey.get(k);
    if (previous === undefined) added.push(after[i] as T);
    else pairs.push([previous, after[i] as T]);
  });
  const afterSet = new Set(afterKeys);
  const removed = before.filter((_, i) => !afterSet.has(beforeKeys[i] ?? ''));
  return { pairs, added, removed, beforeKeys, afterKeys };
}

function businessDiff(before: ConfigDocument, after: ConfigDocument): SectionDiff {
  const s = emptySection('business');
  const b = before.business;
  const a = after.business;
  const fields = [
    ...change('name', 'Nombre', text(b.name), text(a.name)),
    ...change('address', 'Dirección', text(b.address), text(a.address)),
    ...change('directions', 'Cómo llegar', longText(b.directions), longText(a.directions)),
    ...change('mapUrl', 'Enlace al mapa', text(b.mapUrl), text(a.mapUrl)),
    ...change('phone', 'Teléfono', text(b.phone), text(a.phone)),
    ...change('email', 'Email', text(b.email), text(a.email)),
    ...change('timezone', 'Zona horaria', b.timezone, a.timezone),
    ...change('currency', 'Moneda', b.currency, a.currency),
  ];
  if (fields.length > 0) s.modified.push({ label: SECTION_LABELS.business, fields });
  return s;
}

/** Franjas comparadas día a día: `lun 09:00–14:00 → lun 09:00–13:30`. */
function slotsDiff(section: SectionKey, before: WeeklySlot[], after: WeeklySlot[]): SectionDiff {
  const target = emptySection(section);
  for (let d = 1; d <= 7; d++) {
    const had = before.some((x) => x.weekday === d);
    const has = after.some((x) => x.weekday === d);
    const b = daySlots(d, before);
    const a = daySlots(d, after);
    if (!had && has) target.added.push({ label: a });
    else if (had && !has) target.removed.push({ label: b });
    else if (had && has && a !== b) {
      target.modified.push({ label: day(d), fields: [{ field: 'hours', fieldLabel: 'Franjas', before: b, after: a }] });
    }
  }
  return target;
}

const blockKey = (b: ConfigDateBlock) => `${b.startDate}|${b.endDate}|${b.startTime ?? ''}|${b.endTime ?? ''}`;

function closuresDiff(before: ConfigDocument, after: ConfigDocument): SectionDiff {
  const s = emptySection('closures');
  const { pairs, added, removed } = pairUp(before.closures, after.closures, blockKey);
  s.added = added.map((c) => ({ label: formatBlock(c) }));
  s.removed = removed.map((c) => ({ label: formatBlock(c) }));
  for (const [b, a] of pairs) {
    const fields = change('reason', 'Motivo', text(b.reason), text(a.reason));
    if (fields.length > 0) s.modified.push({ label: formatBlock(a), fields });
  }
  return s;
}

function servicesDiff(before: ConfigDocument, after: ConfigDocument): SectionDiff {
  const s = emptySection('services');
  const bc = before.business.currency;
  const ac = after.business.currency;
  const r = pairUp(before.services, after.services, (x) => normalizeKey(x.name));
  s.added = r.added.map((x) => ({ label: x.name }));
  s.removed = r.removed.map((x) => ({ label: x.name }));
  for (const [b, a] of r.pairs) {
    const fields = [
      ...change('name', 'Nombre', b.name, a.name),
      ...change('description', 'Descripción', longText(b.description), longText(a.description)),
      ...change('priceType', 'Tipo de precio', PRICE_TYPES[b.priceType], PRICE_TYPES[a.priceType]),
      ...change('priceCents', 'Precio', money(b.priceCents, bc), money(a.priceCents, ac)),
      ...change('durationMinutes', 'Duración', formatMinutes(b.durationMinutes), formatMinutes(a.durationMinutes)),
      ...change('bookable', 'Reservable', yesNo(b.bookable), yesNo(a.bookable)),
      ...change('active', 'Activo', yesNo(b.active), yesNo(a.active)),
    ];
    if (fields.length > 0) s.modified.push({ label: a.name, fields });
  }
  s.reordered = reordered(r.beforeKeys, r.afterKeys);
  return s;
}

function resourcesDiff(before: ConfigDocument, after: ConfigDocument): SectionDiff {
  const s = emptySection('resources');
  const r = pairUp(before.resources, after.resources, (x) => normalizeKey(x.name));
  s.added = r.added.map((x) => ({ label: x.name }));
  s.removed = r.removed.map((x) => ({ label: x.name }));
  const absences = (items: ConfigDateBlock[]) => list(items.map(formatBlock));
  for (const [b, a] of r.pairs) {
    const fields = [
      ...change('name', 'Nombre', b.name, a.name),
      ...change('active', 'Activo', yesNo(b.active), yesNo(a.active)),
      ...change('services', 'Servicios que presta', list(b.services), list(a.services)),
      ...change('hours', 'Horario', formatSlots(b.hours), formatSlots(a.hours)),
      ...change('absences', 'Ausencias', absences(b.absences), absences(a.absences)),
    ];
    if (fields.length > 0) s.modified.push({ label: a.name, fields });
  }
  s.reordered = reordered(r.beforeKeys, r.afterKeys);
  return s;
}

function faqsDiff(before: ConfigDocument, after: ConfigDocument): SectionDiff {
  const s = emptySection('faqs');
  const r = pairUp(before.faqs, after.faqs, (x) => normalizeKey(x.question));
  s.added = r.added.map((x) => ({ label: x.question }));
  s.removed = r.removed.map((x) => ({ label: x.question }));
  for (const [b, a] of r.pairs) {
    const fields = [
      ...change('question', 'Pregunta', b.question, a.question),
      ...change('answer', 'Respuesta', longText(b.answer), longText(a.answer)),
    ];
    if (fields.length > 0) s.modified.push({ label: a.question, fields });
  }
  s.reordered = reordered(r.beforeKeys, r.afterKeys);
  return s;
}

function policiesDiff(before: ConfigDocument, after: ConfigDocument): SectionDiff {
  const s = emptySection('policies');
  const label = SECTION_LABELS.policies;
  const b = before.policies;
  const a = after.policies;
  if (!b && a) s.added.push({ label });
  else if (b && !a) s.removed.push({ label });
  else if (b && a) {
    const fields = [
      ...change('cancellationText', 'Texto de cancelación', longText(b.cancellationText), longText(a.cancellationText)),
      ...change('cancellationNoticeMinutes', 'Aviso para cancelar', formatMinutes(b.cancellationNoticeMinutes), formatMinutes(a.cancellationNoticeMinutes)),
      ...change('minAdvanceMinutes', 'Antelación mínima', formatMinutes(b.minAdvanceMinutes), formatMinutes(a.minAdvanceMinutes)),
      ...change('maxAdvanceMinutes', 'Antelación máxima', formatMinutes(b.maxAdvanceMinutes), formatMinutes(a.maxAdvanceMinutes)),
      ...change('paymentMethods', 'Formas de pago', list(b.paymentMethods), list(a.paymentMethods)),
    ];
    if (fields.length > 0) s.modified.push({ label, fields });
  }
  return s;
}

const ADDRESS_FORMS = { informal: 'De tú', formal: 'De usted' } as const;

function toneDiff(before: ConfigDocument, after: ConfigDocument): SectionDiff {
  const s = emptySection('tone');
  const label = SECTION_LABELS.tone;
  const b = before.tone;
  const a = after.tone;
  if (!b && a) s.added.push({ label });
  else if (b && !a) s.removed.push({ label });
  else if (b && a) {
    const fields = [
      ...change('addressForm', 'Trato', ADDRESS_FORMS[b.addressForm], ADDRESS_FORMS[a.addressForm]),
      ...change('styleDescription', 'Estilo', longText(b.styleDescription), longText(a.styleDescription)),
    ];
    if (fields.length > 0) s.modified.push({ label, fields });
  }
  return s;
}

const channelLabel = (c: { type: string; value: string }) => `${CHANNEL_TYPES[c.type] ?? c.type} ${c.value}`;

function handoffDiff(before: ConfigDocument, after: ConfigDocument): SectionDiff {
  const s = emptySection('handoff');
  const b = before.handoff ?? { channels: [], hours: [] };
  const a = after.handoff ?? { channels: [], hours: [] };
  const key = (c: { type: string; value: string }) => `${c.type}:${c.value}`;
  const r = pairUp(b.channels, a.channels, key);
  s.added = r.added.map((c) => ({ label: channelLabel(c) }));
  s.removed = r.removed.map((c) => ({ label: channelLabel(c) }));
  s.reordered = reordered(r.beforeKeys, r.afterKeys);
  const hours = change('hours', 'Horario de atención', formatSlots(b.hours), formatSlots(a.hours));
  if (hours.length > 0) s.modified.push({ label: 'Horario de atención', fields: hours });
  return s;
}

function webChatDiff(before: ConfigDocument, after: ConfigDocument): SectionDiff {
  const s = emptySection('webChat');
  const b = before.webChat;
  const a = after.webChat;
  const fields = [
    ...change('allowedOrigins', 'Webs permitidas', list(b.allowedOrigins), list(a.allowedOrigins)),
    ...change('privacyUrl', 'Política de privacidad', text(b.privacyUrl), text(a.privacyUrl)),
    ...change('dailyCap', 'Tope diario', String(b.dailyCap), String(a.dailyCap)),
    ...change('monthlyCap', 'Tope mensual', String(b.monthlyCap), String(a.monthlyCap)),
  ];
  if (fields.length > 0) s.modified.push({ label: SECTION_LABELS.webChat, fields });
  return s;
}

function alertsDiff(before: ConfigDocument, after: ConfigDocument): SectionDiff {
  const s = emptySection('alertDestinations');
  const b = before.alertDestinations;
  const a = after.alertDestinations;
  if (!b || !a) return s;
  const fields = [
    ...change('whatsapp', 'WhatsApp', text(b.whatsapp), text(a.whatsapp)),
    ...change('email', 'Email', text(b.email), text(a.email)),
  ];
  if (fields.length > 0) s.modified.push({ label: SECTION_LABELS.alertDestinations, fields });
  return s;
}

/** Diferencias por sección y destacados entre la configuración actual y la nueva. */
export function diffConfig(before: ConfigDocument, after: ConfigDocument, opts: DiffOptions): ConfigDiff {
  const sections = [
    businessDiff(before, after),
    slotsDiff('openingHours', before.openingHours, after.openingHours),
    closuresDiff(before, after),
    servicesDiff(before, after),
    resourcesDiff(before, after),
    faqsDiff(before, after),
    policiesDiff(before, after),
    toneDiff(before, after),
    handoffDiff(before, after),
    webChatDiff(before, after),
    alertsDiff(before, after),
  ].filter(hasChanges);

  const b = before.business;
  const a = after.business;
  const origins = {
    removed: before.webChat.allowedOrigins.filter((o) => !after.webChat.allowedOrigins.includes(o)),
    added: after.webChat.allowedOrigins.filter((o) => !before.webChat.allowedOrigins.includes(o)),
  };
  return {
    sections,
    highlights: {
      timezoneChanged: b.timezone === a.timezone ? null : { before: b.timezone, after: a.timezone },
      currencyChanged: b.currency === a.currency ? null : { before: b.currency, after: a.currency },
      sameInstance: opts.sameInstance,
      alertDestinationsIncluded: opts.fileIncludesAlerts,
      webChat: opts.destinationWebChatEnabled
        ? {
            destinationEnabled: true,
            removedOrigins: origins.removed,
            addedOrigins: origins.added,
            capsChanged:
              before.webChat.dailyCap !== after.webChat.dailyCap ||
              before.webChat.monthlyCap !== after.webChat.monthlyCap,
          }
        : null,
    },
  };
}
