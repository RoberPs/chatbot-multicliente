/**
 * Secretos de una instancia (007, research R3 y R7): reglas de calidad por tipo y generación con
 * `node:crypto`. Ninguna función devuelve ni registra el valor que examina (FR-007).
 */
import { randomBytes, randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { isPlaceholder, secretRule } from '../config/secret-rules.js';

export type QualityCode =
  'weak_secret' | 'example_database' | 'weak_argon2_params' | 'llm_key_format';

export interface QualityFinding {
  code: QualityCode;
  severity: 'error' | 'warning';
}

// Las reglas de relleno, longitud y variedad son las del arranque (012): `secret-rules.ts`.
export { isPlaceholder };

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
    if (secretRule(variable, trimmed) !== null) add('weak_secret');
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
  const rule = secretRule(variable, trimmed);
  if (variable === 'DATABASE_URL' && rule === 'example_value') {
    add('example_database');
    return findings;
  }
  if (rule !== null) add('weak_secret');
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
