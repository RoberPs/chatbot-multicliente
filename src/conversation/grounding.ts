/**
 * Verificador de cifras (research R8, capa 3; contracts/chat-model.md).
 *
 * Extrae del texto horas, fechas, teléfonos, correos, URLs y números, y comprueba que cada
 * uno está en `AllowedFacts`. Determinista: nunca llama al modelo.
 */
import type { AllowedFacts } from './types.js';

export type FactCategory = 'url' | 'email' | 'phone' | 'date' | 'time' | 'amount' | 'number';

export interface ExtractedFact {
  category: FactCategory;
  /** Texto tal como aparece. */
  raw: string;
  /** Valor normalizado para comparar. */
  value: string;
  /** Otros valores equivalentes ("a las 5" puede ser 05:00 o 17:00). */
  alternatives?: string[];
  /** "2 h" puede ser una hora del reloj o una duración: vale también como número. */
  asNumber?: string;
}

const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

const pad = (n: number | string) => String(n).padStart(2, '0');
const hhmm = (h: number, m = 0) => `${pad(h)}:${pad(m)}`;
const monthDay = (month: number, day: number) => `${pad(month)}-${pad(day)}`;
const validTime = (h: number, m: number) => h >= 0 && h <= 24 && m >= 0 && m < 60;
const validDate = (month: number, day: number) =>
  month >= 1 && month <= 12 && day >= 1 && day <= 31;

/** Número canónico: "35,50" → "35.5". */
const canonical = (s: string) => String(Number(s.replace(',', '.')));

const PERIOD_OFFSET: Record<string, number> = { mañana: 0, madrugada: 0, tarde: 12, noche: 12 };

interface Extractor {
  category: FactCategory;
  re: RegExp;
  /** Devuelve null si el trozo no es de esta categoría (se deja para otras). */
  parse(
    m: RegExpExecArray,
  ): { raw: string; value: string; alternatives?: string[]; asNumber?: string } | null;
}

const MONTH_NAMES = Object.keys(MONTHS).join('|');

/** En orden: cada extractor consume su trozo para que los siguientes no lo vuelvan a contar. */
const EXTRACTORS: Extractor[] = [
  {
    category: 'url',
    re: /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi,
    parse: (m) => {
      const raw = m[0].replace(/[.,;:!?]+$/, '');
      return { raw, value: raw.toLowerCase().replace(/\/+$/, '') };
    },
  },
  {
    category: 'email',
    re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
    parse: (m) => ({ raw: m[0], value: m[0].toLowerCase() }),
  },
  {
    category: 'date',
    re: new RegExp(
      `\\b(\\d{4})-(\\d{2})-(\\d{2})\\b|\\b(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?\\b|\\b(\\d{1,2}) de (${MONTH_NAMES})(?: de (\\d{4}))?\\b`,
      'gi',
    ),
    parse: (m) => {
      let month: number;
      let day: number;
      if (m[1]) {
        month = Number(m[2]);
        day = Number(m[3]);
      } else if (m[4]) {
        day = Number(m[4]);
        month = Number(m[5]);
      } else {
        day = Number(m[7]);
        month = MONTHS[(m[8] ?? '').toLowerCase()] ?? 0;
      }
      if (!validDate(month, day)) return null;
      return { raw: m[0], value: monthDay(month, day) };
    },
  },
  {
    category: 'phone',
    re: /(?<![\d:.,])\+?\d(?:[ .-]?\d){8,14}(?![\d:])/g,
    parse: (m) => ({ raw: m[0].trim(), value: m[0].replace(/\D/g, '') }),
  },
  {
    category: 'time',
    re: /(?<![\d.,])(\d{1,2})(?:[:.](\d{2}))?\s*(?:h|hrs?)\b|(?<![\d.,])(\d{1,2})(?:[:.](\d{2}))? de la (mañana|madrugada|tarde|noche)\b|(?<![\d.,])(\d{1,2})[:.](\d{2})\b/gi,
    parse: (m) => {
      if (m[5]) {
        const h = Number(m[3]);
        const min = Number(m[4] ?? 0);
        const offset = PERIOD_OFFSET[m[5].toLowerCase()] ?? 0;
        const hour = h < 12 ? h + offset : h;
        if (!validTime(hour, min)) return null;
        return { raw: m[0], value: hhmm(hour, min) };
      }
      const h = Number(m[1] ?? m[6]);
      const min = Number(m[2] ?? m[7] ?? 0);
      if (!validTime(h, min)) return null;
      const asNumber = m[1] !== undefined && m[2] === undefined ? String(h) : undefined;
      return { raw: m[0].trim(), value: hhmm(h, min), ...(asNumber ? { asNumber } : {}) };
    },
  },
  {
    category: 'number',
    re: /\d+(?:[.,]\d+)?/g,
    parse: (m) => ({ raw: m[0], value: canonical(m[0]) }),
  },
];

/** Extrae los valores verificables de un texto, por categoría y en orden de aparición. */
export function extractFacts(text: string): ExtractedFact[] {
  let rest = text;
  const facts: ExtractedFact[] = [];
  for (const extractor of EXTRACTORS) {
    extractor.re.lastIndex = 0;
    const found: Array<{ index: number; length: number; fact: ExtractedFact }> = [];
    for (const m of rest.matchAll(extractor.re)) {
      const parsed = extractor.parse(m);
      if (!parsed) continue;
      found.push({
        index: m.index,
        length: m[0].length,
        fact: { category: extractor.category, ...parsed },
      });
    }
    for (const f of found) {
      facts.push(f.fact);
      // Se tapa el trozo consumido sin mover las posiciones.
      rest = rest.slice(0, f.index) + ' '.repeat(f.length) + rest.slice(f.index + f.length);
    }
  }
  return facts;
}

function isAllowed(fact: ExtractedFact, allowed: AllowedFacts): boolean {
  switch (fact.category) {
    case 'url':
      return allowed.urls.has(fact.value);
    case 'email':
      return allowed.emails.has(fact.value);
    case 'phone':
      return allowed.phones.has(fact.value);
    case 'date':
      return allowed.dates.has(fact.value);
    case 'time':
      return (
        [fact.value, ...(fact.alternatives ?? [])].some((v) => allowed.times.has(v)) ||
        (fact.asNumber !== undefined && allowed.numbers.has(fact.asNumber))
      );
    case 'amount':
      return allowed.amountsCents.has(Number(fact.value));
    case 'number': {
      if (allowed.numbers.has(fact.value)) return true;
      const n = Number(fact.value);
      if (!Number.isInteger(n)) return false;
      // Enumeraciones sueltas del 1 al 10.
      if (n >= 1 && n <= 10) return true;
      // "de 9 a 14": una hora en punto que figura en los datos.
      return n <= 24 && allowed.times.has(hhmm(n));
    }
  }
}

export function groundingGuard(
  body: string,
  allowed: AllowedFacts,
): { ok: true } | { ok: false; offending: string[] } {
  const offending = extractFacts(body)
    .filter((f) => !isAllowed(f, allowed))
    .map((f) => f.raw);
  return offending.length === 0 ? { ok: true } : { ok: false, offending };
}

/** Categorías de los valores rechazados, para explicar al modelo sin repetir los valores. */
export function offendingCategories(body: string, allowed: AllowedFacts): FactCategory[] {
  return [
    ...new Set(
      extractFacts(body)
        .filter((f) => !isAllowed(f, allowed))
        .map((f) => f.category),
    ),
  ];
}
