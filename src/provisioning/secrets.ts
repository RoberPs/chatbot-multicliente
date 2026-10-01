/**
 * Secretos de una instancia (007, research R3 y R7): reglas de calidad por tipo y generación con
 * `node:crypto`. Ninguna función devuelve ni registra el valor que examina (FR-007).
 */
import { randomBytes, randomInt } from 'node:crypto';
import argon2 from 'argon2';

export type QualityCode =
  'weak_secret' | 'example_database' | 'weak_argon2_params' | 'llm_key_format';

export interface QualityFinding {
  code: QualityCode;
  severity: 'error' | 'warning';
}

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

/** Valor de relleno según las reglas a–d de R3 (sin distinguir mayúsculas). */
export function isPlaceholder(value: string): boolean {
  const lower = value.trim().toLowerCase();
  const letters = lower.replace(/[0-9_\-. ]/g, '');
  if (letters !== '' && ONLY_WORDS.test(letters)) return true;
  if (lower.length < 24 && ANY_WORD.test(lower)) return true;
  if (WORD_AT_EDGE.test(lower)) return true;
  return isRunOrRepeat(lower);
}

const HEX_64 = /^[0-9a-f]{64}$/i;
/** `$argon2id$v=19$<parámetros>$<sal>$<hash>`; los parámetros, en cualquier orden. */
const ARGON2ID = /^\$argon2id\$v=19\$([a-z]=\d+(?:,[a-z]=\d+)*)\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

/** Parámetros `m`, `t` y `p` de un hash Argon2id, o `null` si falta alguno. */
function argon2Params(params: string): { m: number; t: number } | null {
  const values = new Map<string, number>();
  for (const pair of params.split(',')) {
    const [name = '', value = ''] = pair.split('=');
    values.set(name, Number(value));
  }
  const m = values.get('m');
  const t = values.get('t');
  return m !== undefined && t !== undefined && values.has('p') ? { m, t } : null;
}
/** Mínimos OWASP para Argon2id. */
const ARGON2_MIN_MEMORY = 19456;
const ARGON2_MIN_TIME = 2;

const distinct = (value: string): number => new Set(value.toLowerCase()).size;

/** Longitud y variedad mínimas de los valores que da un tercero. */
const MINIMUMS: Record<string, { length: number; distinct?: number }> = {
  WHATSAPP_VERIFY_TOKEN: { length: 32, distinct: 10 },
  WHATSAPP_APP_SECRET: { length: 32 },
  WHATSAPP_ACCESS_TOKEN: { length: 40 },
  ANTHROPIC_API_KEY: { length: 40 },
  STT_API_KEY: { length: 20 },
  /** Contraseña del operador generada (nunca se escribe; solo se valida al generarla). */
  OPERATOR_PASSWORD: { length: 24, distinct: 10 },
  /** Contraseña de DATABASE_URL. */
  DATABASE_URL: { length: 16 },
};

/**
 * Calidad de un secreto según su variable. Para `DATABASE_URL`, `value` es su contraseña. Solo
 * devuelve códigos, nunca el valor.
 */
export function secretQuality(variable: string, value: string): QualityFinding[] {
  const trimmed = value.trim();
  const findings: QualityFinding[] = [];
  const add = (code: QualityCode, severity: 'error' | 'warning' = 'error'): void => {
    if (!findings.some((f) => f.code === code)) findings.push({ code, severity });
  };

  if (
    variable === 'SESSION_SECRET' ||
    variable === 'BACKUP_KEY' ||
    variable === 'BACKUP_KEYS_PREVIOUS' ||
    variable === 'HEALTH_SECRET'
  ) {
    if (!HEX_64.test(trimmed) || distinct(trimmed) <= 8) add('weak_secret');
    return findings;
  }
  if (variable === 'OPERATOR_PASSWORD_HASH') {
    const params = argon2Params(ARGON2ID.exec(trimmed)?.[1] ?? '');
    if (!params) add('weak_secret');
    else if (params.m < ARGON2_MIN_MEMORY || params.t < ARGON2_MIN_TIME) {
      add('weak_argon2_params', 'warning');
    }
    return findings;
  }
  if (variable === 'DATABASE_URL' && trimmed === 'chatbot') {
    add('example_database');
    return findings;
  }

  const minimum = MINIMUMS[variable];
  if (minimum) {
    if (trimmed.length < minimum.length) add('weak_secret');
    if (minimum.distinct !== undefined && distinct(trimmed) < minimum.distinct) add('weak_secret');
  }
  if (trimmed === '' || isPlaceholder(trimmed)) add('weak_secret');
  if (variable === 'ANTHROPIC_API_KEY' && !trimmed.startsWith('sk-ant-')) {
    add('llm_key_format', 'warning');
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Generación (R7)
// ---------------------------------------------------------------------------

/** Fuente aleatoria (sustituible en las pruebas). */
export interface RandomSource {
  bytes(n: number): Buffer;
  /** Entero uniforme en `[0, max)`. */
  int(max: number): number;
}

export const cryptoRandom: RandomSource = {
  bytes: (n) => randomBytes(n),
  int: (max) => randomInt(max),
};

/** Parámetros del hash del operador: los mismos que `pnpm operator:hash-password`. */
export const OPERATOR_HASH_OPTIONS = { type: argon2.argon2id } as const;

export type PasswordHasher = (password: string) => Promise<string>;

export const argon2Hasher: PasswordHasher = (password) =>
  argon2.hash(password, OPERATOR_HASH_OPTIONS);

/** Alfabeto de la contraseña del operador: 56 símbolos sin ambiguos (I, O, l, o, 0, 1). */
export const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const PASSWORD_LENGTH = 24;
const MAX_TRIES = 20;

/** Repite `make` hasta que el valor pase la regla de calidad de `variable`. */
function untilQuality(variable: string, make: () => string): string {
  for (let i = 0; i < MAX_TRIES; i++) {
    const value = make();
    if (!secretQuality(variable, value).some((f) => f.severity === 'error')) return value;
  }
  throw new Error('No se ha podido generar un valor aleatorio válido');
}

/** Clave hex (`SESSION_SECRET`, `BACKUP_KEY`, `HEALTH_SECRET`): `bytes` aleatorios en hex. */
export function generateHexSecret(
  variable: 'SESSION_SECRET' | 'BACKUP_KEY' | 'HEALTH_SECRET',
  random: RandomSource = cryptoRandom,
  bytes = 32,
): string {
  return untilQuality(variable, () => random.bytes(bytes).toString('hex'));
}

/** Token de verificación del webhook de WhatsApp: 24 bytes en hex (48 caracteres). */
export function generateVerifyToken(random: RandomSource = cryptoRandom): string {
  return untilQuality('WHATSAPP_VERIFY_TOKEN', () => random.bytes(24).toString('hex'));
}

/** Contraseña del operador: 24 caracteres del alfabeto de 56 símbolos (≈ 139 bits). */
export function generateOperatorPassword(random: RandomSource = cryptoRandom): string {
  return untilQuality('OPERATOR_PASSWORD', () =>
    Array.from(
      { length: PASSWORD_LENGTH },
      () => PASSWORD_ALPHABET[random.int(PASSWORD_ALPHABET.length)],
    ).join(''),
  );
}

export function hashOperatorPassword(
  password: string,
  hasher: PasswordHasher = argon2Hasher,
): Promise<string> {
  return hasher(password);
}
