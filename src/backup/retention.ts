/**
 * Caducidad de las copias (006, US4, research R8, FR-018 – FR-020). Solo se tocan las copias
 * propias (nombre con el patrón y cabecera con el `instanceId` de la instancia); la edad sale de
 * la cabecera, nunca del nombre ni de `mtime`; siempre se conserva la más reciente válida.
 */
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoggerLike } from '../conversation/activity-log.js';
import { systemClock, type Clock } from '../conversation/ports.js';
import { readKeys, type BackupConfig } from './config.js';
import { authenticateHeader, readHeader, type BackupHeader } from './format.js';
import { createBackupLog, silentLogger } from './log.js';
import { isBackupName } from './naming.js';

const DAY = 24 * 60 * 60 * 1000;

export interface RetentionCandidate {
  name: string;
  createdAt: Date;
  /** Cabecera legible con el `instanceId` de esta instancia. */
  own: boolean;
  /** Cabecera autenticada con alguna clave configurada. */
  valid: boolean;
}

/**
 * Copias que se deben borrar: las propias de edad > `days × 24 h`, salvo la más reciente válida
 * de todas las propias (aunque esté caducada). Las de otra instancia nunca se devuelven.
 */
export function selectExpired<T extends RetentionCandidate>(
  backups: T[],
  now: Date,
  days: number,
): T[] {
  const own = backups.filter((b) => b.own);
  const latestValid = own
    .filter((b) => b.valid)
    .reduce<T | null>(
      (best, b) => (best === null || b.createdAt > best.createdAt ? b : best),
      null,
    );
  const limit = now.getTime() - days * DAY;
  return own.filter((b) => b.createdAt.getTime() < limit && b !== latestValid);
}

export interface OwnBackup extends RetentionCandidate {
  path: string;
  header: BackupHeader;
  sizeBytes: number;
}

/** Copias propias del directorio, con su cabecera y su validez. Ignora todo lo demás. */
export async function scanBackups(config: BackupConfig): Promise<OwnBackup[]> {
  const keys = readKeys(config);
  const found: OwnBackup[] = [];
  for (const name of await readdir(config.dir)) {
    if (!isBackupName(name)) continue;
    const path = join(config.dir, name);
    let header: BackupHeader;
    try {
      ({ header } = await readHeader(path));
    } catch {
      continue;
    }
    if (header.instanceId !== config.instanceId) continue;
    let valid = false;
    try {
      await authenticateHeader(path, keys);
      valid = true;
    } catch {
      // Sin ninguna clave que la autentique: no es válida.
    }
    const sizeBytes = (await stat(path)).size;
    found.push({
      name,
      path,
      header,
      sizeBytes,
      createdAt: new Date(header.createdAt),
      own: true,
      valid,
    });
  }
  return found;
}

export interface RetentionResult {
  deleted: number;
  kept: number;
  /** Se conservó una copia caducada por ser la última válida. */
  keptExpiredLatest: boolean;
}

/** Aplica la retención en `BACKUP_DIR` y la registra. */
export async function applyRetention(options: {
  config: BackupConfig;
  clock?: Clock;
  logger?: LoggerLike;
}): Promise<RetentionResult> {
  const { config } = options;
  const now = (options.clock ?? systemClock).now();
  const own = await scanBackups(config);
  const expired = selectExpired(own, now, config.retentionDays);
  let deleted = 0;
  for (const backup of expired) {
    try {
      await unlink(backup.path);
      deleted += 1;
    } catch {
      // Se reintenta en la siguiente pasada.
    }
  }
  const limit = now.getTime() - config.retentionDays * DAY;
  const keptExpiredLatest = own.some((b) => !expired.includes(b) && b.createdAt.getTime() < limit);
  const result = { deleted, kept: own.length - deleted, keptExpiredLatest };
  createBackupLog(options.logger ?? silentLogger).log({
    event: 'backup_retention_applied',
    ...result,
  });
  return result;
}

/** Fecha en que caduca una copia. */
export const expiresAt = (createdAt: Date, days: number): Date =>
  new Date(createdAt.getTime() + days * DAY);
