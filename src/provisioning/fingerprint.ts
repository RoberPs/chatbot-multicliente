/**
 * Huellas de secretos e identificadores (007, research R4, data-model.md#huella): HMAC-SHA256 con
 * la clave del inventario, truncado a 128 bits y en base64url. Sin la clave no se puede comprobar
 * si un valor candidato es el de una instancia; con ella solo se sabe si dos valores son iguales.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EnvMap } from './env-file.js';

export const FINGERPRINT_CLASSES = [
  'secret',
  'database',
  'database_user',
  'public_url',
  'backup_dir',
  'whatsapp_phone',
] as const;
export type FingerprintClass = (typeof FINGERPRINT_CLASSES)[number];

export interface Fingerprint {
  variable: string;
  class: FingerprintClass;
  value: string;
  current: boolean;
  since: string;
}

export interface DatabaseIdentity {
  host: string;
  port: number;
  name: string;
  user: string;
}

const DOMAIN = 'chatbot-inventory/v1\0';
const INVENTORY_KEY = /^[0-9a-f]{64}$/i;

function mac(key: Buffer, data: string): string {
  return createHmac('sha256', key)
    .update(data, 'utf8')
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

/** Huella de un valor ya normalizado. */
export function fingerprint(key: Buffer, cls: FingerprintClass, normalized: string): string {
  return mac(key, `${DOMAIN}${cls}\0${normalized}`);
}

/** Comprobación de la clave que se guarda en el inventario (no permite recuperarla). */
export function keyCheck(key: Buffer): string {
  return mac(key, `${DOMAIN}key-check`);
}

/** `true` si la clave es la del inventario (comparación en tiempo constante). */
export function verifyKey(key: Buffer, check: string): boolean {
  const expected = Buffer.from(keyCheck(key), 'base64url');
  const actual = Buffer.from(check, 'base64url');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Clave del inventario (64 hex) o `null` si no tiene ese formato. */
export function parseInventoryKey(text: string | undefined): Buffer | null {
  const trimmed = text?.trim() ?? '';
  return INVENTORY_KEY.test(trimmed) ? Buffer.from(trimmed, 'hex') : null;
}

// ---------------------------------------------------------------------------
// Identidad de la base de datos
// ---------------------------------------------------------------------------

function parsePgUrl(url: string): URL | null {
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:' ? parsed : null;
  } catch {
    return null;
  }
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Servidor, puerto, nombre y usuario de una `DATABASE_URL`, sin contraseña. */
export function databaseIdentity(databaseUrl: string | undefined): DatabaseIdentity | null {
  if (databaseUrl === undefined || databaseUrl.trim() === '') return null;
  const url = parsePgUrl(databaseUrl);
  if (!url || url.hostname === '') return null;
  return {
    host: url.hostname.toLowerCase(),
    port: url.port === '' ? 5432 : Number(url.port),
    name: decode(url.pathname.replace(/^\//, '')),
    user: decode(url.username),
  };
}

/** Contraseña de una `DATABASE_URL` (solo para huella y calidad; nunca se muestra). */
export function databasePassword(databaseUrl: string | undefined): string | null {
  if (databaseUrl === undefined) return null;
  const url = parsePgUrl(databaseUrl);
  if (!url || url.password === '') return null;
  return decode(url.password);
}

// ---------------------------------------------------------------------------
// Normalización y huellas de un entorno
// ---------------------------------------------------------------------------

const HEX_VARIABLES = new Set(['SESSION_SECRET', 'BACKUP_KEY', 'BACKUP_KEYS_PREVIOUS']);

/** Variables secretas que se huellan tal cual (recortadas). */
export const SECRET_VARIABLES = [
  'SESSION_SECRET',
  'BACKUP_KEY',
  'OPERATOR_PASSWORD_HASH',
  'ANTHROPIC_API_KEY',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'STT_API_KEY',
  'SMTP_URL',
] as const;

/** Valor normalizado de una variable del inventario para calcular su huella. */
export function normalize(variable: string, value: string): string {
  const trimmed = value.trim();
  if (HEX_VARIABLES.has(variable)) return trimmed.toLowerCase();
  if (variable === 'PUBLIC_BASE_URL') {
    try {
      return new URL(trimmed).origin.toLowerCase();
    } catch {
      return trimmed;
    }
  }
  if (variable === 'BACKUP_DIR') {
    const stripped = trimmed.replace(/[/\\]+$/, '');
    return stripped === '' ? trimmed.slice(0, 1) : stripped;
  }
  return trimmed;
}

/** Un valor del entorno a huellar: variable del inventario, clase, valor y si es vigente. */
export interface EnvValue {
  variable: string;
  class: FingerprintClass;
  normalized: string;
  current: boolean;
}

const present = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== '';

/** Los valores que se comparan entre instancias (tabla de data-model.md#huella). */
export function envValues(env: EnvMap): EnvValue[] {
  const values: EnvValue[] = [];
  const add = (variable: string, cls: FingerprintClass, value: string, current = true): void => {
    values.push({ variable, class: cls, normalized: normalize(variable, value), current });
  };
  for (const variable of SECRET_VARIABLES) {
    const value = env[variable];
    if (present(value)) add(variable, 'secret', value);
  }
  for (const previous of (env.BACKUP_KEYS_PREVIOUS ?? '').split(',')) {
    if (present(previous)) add('BACKUP_KEYS_PREVIOUS', 'secret', previous, false);
  }
  const password = databasePassword(env.DATABASE_URL);
  if (password !== null) add('DATABASE_PASSWORD', 'secret', password);
  const db = databaseIdentity(env.DATABASE_URL);
  if (db) {
    add('DATABASE', 'database', `${db.host}:${String(db.port)}/${db.name}`);
    add('DATABASE_USER', 'database_user', `${db.host}:${String(db.port)}/${db.user}`);
  }
  if (present(env.PUBLIC_BASE_URL)) add('PUBLIC_BASE_URL', 'public_url', env.PUBLIC_BASE_URL);
  if (present(env.WHATSAPP_PHONE_NUMBER_ID)) {
    add('WHATSAPP_PHONE_NUMBER_ID', 'whatsapp_phone', env.WHATSAPP_PHONE_NUMBER_ID);
  }
  if (present(env.BACKUP_DIR)) add('BACKUP_DIR', 'backup_dir', env.BACKUP_DIR);
  return values;
}

/** Huellas de un entorno para el inventario. `INSTANCE_ID` no se huella: es el `id`. */
export function envFingerprints(env: EnvMap, key: Buffer, today: string): Fingerprint[] {
  return envValues(env).map((v) => ({
    variable: v.variable,
    class: v.class,
    value: fingerprint(key, v.class, v.normalized),
    current: v.current,
    since: today,
  }));
}
