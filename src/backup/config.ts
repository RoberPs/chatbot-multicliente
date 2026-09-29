/**
 * Configuración de las copias y claves (006, research R3, R4, R13). La clave llega en hex desde
 * el entorno; aquí se deriva la clave de cada fichero y el `keyId`, que identifica la clave sin
 * revelarla.
 */
import { hkdfSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../config/env.js';
import { BackupError } from './errors.js';

export interface BackupConfig {
  instanceId: string;
  /** Directorio absoluto de las copias. */
  dir: string;
  /** Clave de las copias nuevas, en hex; sin ella no se puede copiar (`key_missing`). */
  key: string | undefined;
  /** Claves anteriores (hex), solo para leer. */
  previousKeys: string[];
  retentionDays: number;
  /** `HH:MM`, hora local del negocio. */
  dailyTime: string;
  /** Servidor donde `db:verify` crea la BD temporal. */
  verifyUrl: string;
}

const HEX_KEY = /^[0-9a-f]{64}$/i;
const DATA_INFO = 'chatbot-backup/v1/data';
const KEY_ID_INFO = 'chatbot-backup/v1/key-id';

/** `null` si la instancia no tiene configuración de copias. */
export function backupConfigFromEnv(env: Env): BackupConfig | null {
  if (!env.backup) return null;
  return {
    instanceId: env.backup.instanceId,
    dir: env.backup.dir,
    key: env.backup.key,
    previousKeys: env.backup.previousKeys,
    retentionDays: env.BACKUP_RETENTION_DAYS,
    dailyTime: env.BACKUP_DAILY_TIME,
    verifyUrl: env.BACKUP_VERIFY_URL,
  };
}

/** Clave de 32 bytes a partir de su hex; `key_missing` / `key_invalid` si no sirve. */
export function parseKey(hex: string | undefined): Buffer {
  if (hex === undefined || hex.trim() === '') throw new BackupError('key_missing');
  if (!HEX_KEY.test(hex.trim())) throw new BackupError('key_invalid');
  return Buffer.from(hex.trim(), 'hex');
}

/** Clave del fichero: HKDF-SHA256(BACKUP_KEY, sal, "chatbot-backup/v1/data"). */
export function deriveFileKey(key: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', key, salt, DATA_INFO, 32));
}

/** 8 primeros bytes de HKDF(BACKUP_KEY, sin sal, "chatbot-backup/v1/key-id"), en hex. */
export function keyId(key: Buffer): string {
  return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), KEY_ID_INFO, 32))
    .subarray(0, 8)
    .toString('hex');
}

/** Claves con las que se puede leer: la actual y las anteriores (las no válidas se ignoran). */
export function readKeys(config: Pick<BackupConfig, 'key' | 'previousKeys'>): Buffer[] {
  return [config.key, ...config.previousKeys]
    .filter((k): k is string => k !== undefined && HEX_KEY.test(k.trim()))
    .map((k) => Buffer.from(k.trim(), 'hex'));
}

/** La clave configurada cuyo `keyId` es el de la cabecera, o `null`. */
export function findReadKey(
  config: Pick<BackupConfig, 'key' | 'previousKeys'>,
  id: string,
): Buffer | null {
  return readKeys(config).find((k) => keyId(k) === id) ?? null;
}

let cachedVersion: string | null = null;

/** `version` del `package.json` del núcleo (con `tsx` desde `src/` y compilado desde `dist/`). */
export function coreVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      cachedVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
      return cachedVersion;
    }
    const parent = dirname(dir);
    if (parent === dir) return '0.0.0';
    dir = parent;
  }
}
