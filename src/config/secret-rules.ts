/**
 * Reglas de calidad de los secretos de una instancia (012, research R14;
 * contracts/logging-and-startup.md). Las comparten el arranque en producción, `pnpm
 * instance:check` y la generación de secretos de la 007; el valor examinado nunca sale de este
 * módulo: las incidencias solo nombran variables y reglas.
 */
import { LLM_KEY_MINIMUMS, LLM_KEY_VARIABLES } from '../llm/provider.js';
import { parseUrlLoose } from './database-url.js';

export type SecretRule =
  'too_short' | 'example_value' | 'trivial' | 'reused' | 'health_secret_required';

export interface SecretFinding {
  variable: string;
  rule: SecretRule;
  /** Solo en `reused`: la otra variable con el mismo valor. */
  otherVariable?: string;
}

/**
 * Variables secretas, en el orden en que se comparan: de dos repetidas, la incidencia es de la
 * segunda. De `DATABASE_URL` y `SMTP_URL` se examina la contraseña.
 */
export const SECRET_VARIABLES: readonly string[] = [
  'SESSION_SECRET',
  'BACKUP_KEY',
  'BACKUP_KEYS_PREVIOUS',
  'HEALTH_SECRET',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  // 017 (FR-011): las tres credenciales de modelo, salgan de donde salgan los nombres. La regla se
  // aplica a la del proveedor declarado sin que este módulo sepa cuál es, y a las demás si están.
  ...LLM_KEY_VARIABLES,
  'STT_API_KEY',
  'DATABASE_URL',
  'SMTP_URL',
];

/** Claves de 32 bytes en hexadecimal. */
const HEX_VARIABLES = new Set([
  'SESSION_SECRET',
  'BACKUP_KEY',
  'BACKUP_KEYS_PREVIOUS',
  'HEALTH_SECRET',
]);
const HEX_64 = /^[0-9a-f]{64}$/i;

/** Longitud y variedad mínimas de los demás (contracts/logging-and-startup.md). */
export const SECRET_MINIMUMS: Record<string, { length: number; distinct?: number }> = {
  WHATSAPP_VERIFY_TOKEN: { length: 32, distinct: 10 },
  WHATSAPP_APP_SECRET: { length: 32 },
  WHATSAPP_ACCESS_TOKEN: { length: 40 },
  // Una entrada por credencial de modelo, con el mínimo que declara su proveedor (017, FR-011).
  ...Object.fromEntries(
    Object.entries(LLM_KEY_MINIMUMS).map(([variable, length]) => [variable, { length }]),
  ),
  STT_API_KEY: { length: 20 },
  DATABASE_URL: { length: 16 },
  SMTP_URL: { length: 16 },
  /** Contraseña del operador generada por `instance:new` (no es una variable del entorno). */
  OPERATOR_PASSWORD: { length: 24, distinct: 10 },
};

/**
 * Valores de ejemplo de `.env.example` y de la documentación (sin distinguir mayúsculas). La
 * prueba de las reglas comprueba que siguen los de `.env.example`.
 */
export const EXAMPLE_VALUES = new Set(['chatbot', 'clave', 'usuario', 'password', 'contraseña']);

const PLACEHOLDER_WORDS = [
  'changeme',
  'example',
  'ejemplo',
  'placeholder',
  'pendiente',
  'todo',
  'xxx',
  'secret',
  'password',
  'test',
];
const WORDS = PLACEHOLDER_WORDS.join('|');
/** a) tras quitar cifras y separadores, solo quedan palabras de relleno. */
const ONLY_WORDS = new RegExp(`^(?:${WORDS})+$`);
/** c) una palabra al principio o entre separadores `_ - . espacio`. */
const WORD_AT_EDGE = new RegExp(`^(?:${WORDS})|[_\\-. ](?:${WORDS})(?:[_\\-. ]|$)`);
const ANY_WORD = new RegExp(WORDS);

/** d) un solo carácter repetido o una secuencia `0123…`/`abcd…` (con vuelta de 9 a 0 y de z a a). */
function isRunOrRepeat(value: string): boolean {
  if (value.length < 2) return true;
  if (/^(.)\1*$/.test(value)) return true;
  for (let i = 1; i < value.length; i++) {
    const prev = value[i - 1] ?? '';
    const cur = value[i] ?? '';
    const next = cur.charCodeAt(0) === prev.charCodeAt(0) + 1;
    const wrap = (prev === '9' && cur === '0') || (prev === 'z' && cur === 'a');
    if (!next && !wrap) return false;
  }
  return true;
}

/** Valor de relleno según las reglas a–d de la 007 (sin distinguir mayúsculas). */
export function isPlaceholder(value: string): boolean {
  const lower = value.trim().toLowerCase();
  const letters = lower.replace(/[0-9_\-. ]/g, '');
  if (letters !== '' && ONLY_WORDS.test(letters)) return true;
  if (lower.length < 24 && ANY_WORD.test(lower)) return true;
  if (WORD_AT_EDGE.test(lower)) return true;
  return isRunOrRepeat(lower);
}

const distinct = (value: string): number => new Set(value.toLowerCase()).size;

/**
 * Contraseña de una URL (`DATABASE_URL`, `SMTP_URL`), o `null` sin ella o si no es una URL.
 *
 * 016 (FR-007): usa el intérprete tolerante del núcleo en lugar de `new URL`, que **lanza** con
 * las direcciones sin nombre de servidor. Con la forma del despliegue real, esta función
 * devolvía `null`, así que la regla de calidad de la contraseña de la base de datos **no se
 * aplicaba en producción** y nadie se enteraba: la comprobación pasaba callada.
 */
export function urlPassword(url: string | undefined): string | null {
  if (url === undefined) return null;
  const password = parseUrlLoose(url)?.password;
  if (password === undefined || password === '') return null;
  try {
    return decodeURIComponent(password);
  } catch {
    return password;
  }
}

/**
 * Regla que incumple un valor de `variable` (de las URL, su contraseña), o `null` si es válido.
 * Una sola por valor: ejemplo, trivial y corto, en ese orden.
 */
export function secretRule(variable: string, value: string): SecretRule | null {
  const trimmed = value.trim();
  if (EXAMPLE_VALUES.has(trimmed.toLowerCase())) return 'example_value';
  if (trimmed === '' || isPlaceholder(trimmed)) return 'trivial';
  if (HEX_VARIABLES.has(variable)) {
    return HEX_64.test(trimmed) && distinct(trimmed) > 8 ? null : 'too_short';
  }
  const minimum = SECRET_MINIMUMS[variable];
  if (!minimum) return null;
  if (trimmed.length < minimum.length) return 'too_short';
  if (minimum.distinct !== undefined && distinct(trimmed) < minimum.distinct) return 'too_short';
  return null;
}

/** (variable, valor) de cada secreto presente; varias entradas para `BACKUP_KEYS_PREVIOUS`. */
function entries(env: Record<string, string | undefined>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const variable of SECRET_VARIABLES) {
    const raw = env[variable];
    if (raw === undefined || raw.trim() === '') continue;
    if (variable === 'DATABASE_URL' || variable === 'SMTP_URL') {
      const password = urlPassword(raw);
      if (password !== null) out.push([variable, password]);
    } else if (variable === 'BACKUP_KEYS_PREVIOUS') {
      for (const key of raw.split(',')) if (key.trim() !== '') out.push([variable, key.trim()]);
    } else {
      out.push([variable, raw.trim()]);
    }
  }
  return out;
}

/**
 * Incidencias de los secretos de un entorno de producción: una por variable con un valor débil,
 * de ejemplo o repetido (sin distinguir mayúsculas) y la falta de `HEALTH_SECRET`.
 */
export function checkSecrets(env: Record<string, string | undefined>): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const reported = new Set<string>();
  const seen = new Map<string, string>();
  for (const [variable, value] of entries(env)) {
    const rule = secretRule(variable, value);
    if (rule !== null) {
      if (!reported.has(variable)) findings.push({ variable, rule });
      reported.add(variable);
      continue;
    }
    const key = value.toLowerCase();
    const first = seen.get(key);
    if (first === undefined) {
      seen.set(key, variable);
    } else if (!reported.has(variable)) {
      findings.push({ variable, rule: 'reused', otherVariable: first });
      reported.add(variable);
    }
  }
  if ((env.HEALTH_SECRET ?? '').trim() === '') {
    findings.push({ variable: 'HEALTH_SECRET', rule: 'health_secret_required' });
  }
  return findings;
}

/** La regla en español, sin el valor: `- HEALTH_SECRET: coincide con SESSION_SECRET`. */
export function secretFindingText(finding: SecretFinding): string {
  switch (finding.rule) {
    case 'too_short':
      return 'es demasiado corta o poco variada para su tipo';
    case 'example_value':
      return 'tiene un valor de ejemplo';
    case 'trivial':
      return 'tiene un valor de relleno, repetido o en secuencia';
    case 'reused':
      return `coincide con ${finding.otherVariable ?? 'otro secreto'}`;
    case 'health_secret_required':
      return 'es obligatoria en producción';
  }
}
