/**
 * Registros técnicos de las copias (006, contracts/backup-log.md, FR-024).
 *
 * Catálogo cerrado con lista blanca de campos por evento: lo que no está previsto se descarta,
 * así que un registro no puede llevar rutas completas, mensajes de PostgreSQL, textos,
 * teléfonos, nombres ni la clave.
 */
import type { LoggerLike } from '../conversation/activity-log.js';
import type { BackupFailureCode, MigrationBlockCode, RestoreFailureCode } from './errors.js';
import type { BackupReason } from './naming.js';

export interface TableCount {
  name: string;
  rows: number;
}

export type BackupEvent =
  | {
      event: 'backup_created';
      file: string;
      reason: BackupReason;
      sizeBytes: number;
      schema: string;
      durationMs: number;
      tables: TableCount[];
    }
  | { event: 'backup_failed'; reason: BackupReason; failure: BackupFailureCode }
  | { event: 'backup_disabled'; missing: string[] }
  | {
      event: 'backup_retention_applied';
      deleted: number;
      kept: number;
      keptExpiredLatest: boolean;
    }
  | { event: 'migration_blocked'; pending: string[]; failure: MigrationBlockCode }
  | { event: 'migration_failed'; pending: string[]; premigrationFile: string }
  | {
      event: 'restore_completed';
      file: string;
      sourceInstance: string;
      crossInstance: boolean;
      schema: string;
      installedSchema: string;
      durationMs: number;
      tables: TableCount[];
      expiredConversations: number;
    }
  | { event: 'restore_rejected'; file: string; failure: RestoreFailureCode }
  | {
      event: 'verify_completed';
      file: string;
      restorable: boolean;
      failure?: RestoreFailureCode;
      schema?: string;
      durationMs: number;
      /** Limpieza de bases temporales huérfanas (013): recuentos, nunca nombres. */
      orphansListed: boolean;
      orphansRemoved: number;
      orphansFailed: number;
    };

export type BackupEventName = BackupEvent['event'];
type Level = 'info' | 'warn' | 'error';

const catalog: Record<BackupEventName, { level: Level; fields: readonly string[] }> = {
  backup_created: {
    level: 'info',
    fields: ['file', 'reason', 'sizeBytes', 'schema', 'durationMs', 'tables'],
  },
  backup_failed: { level: 'error', fields: ['reason', 'failure'] },
  backup_disabled: { level: 'warn', fields: ['missing'] },
  backup_retention_applied: { level: 'info', fields: ['deleted', 'kept', 'keptExpiredLatest'] },
  migration_blocked: { level: 'error', fields: ['pending', 'failure'] },
  migration_failed: { level: 'error', fields: ['pending', 'premigrationFile'] },
  // `warn` a propósito: una restauración cambia todos los datos y debe destacar.
  restore_completed: {
    level: 'warn',
    fields: [
      'file',
      'sourceInstance',
      'crossInstance',
      'schema',
      'installedSchema',
      'durationMs',
      'tables',
      'expiredConversations',
    ],
  },
  restore_rejected: { level: 'warn', fields: ['file', 'failure'] },
  verify_completed: {
    level: 'info',
    fields: [
      'file',
      'restorable',
      'failure',
      'schema',
      'durationMs',
      'orphansListed',
      'orphansRemoved',
      'orphansFailed',
    ],
  },
};

export const backupEventLevels = Object.fromEntries(
  Object.entries(catalog).map(([name, { level }]) => [name, level]),
) as Record<BackupEventName, Level>;

export interface BackupLog {
  log(event: BackupEvent): void;
}

/** Recuentos por tabla solo con nombre y número (los nombres son del esquema del núcleo). */
function cleanTables(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.map((t: { name?: unknown; rows?: unknown }) => ({
    name: String(t.name),
    rows: Number(t.rows),
  }));
}

export function createBackupLog(logger: LoggerLike): BackupLog {
  return {
    log(event) {
      const entry = catalog[event.event] as (typeof catalog)[BackupEventName] | undefined;
      if (!entry) return;
      const source = event as unknown as Record<string, unknown>;
      const record: Record<string, unknown> = { channel: 'backup', event: event.event };
      for (const field of entry.fields) {
        const value = source[field];
        if (value === undefined) continue;
        record[field] = field === 'tables' ? cleanTables(value) : value;
      }
      logger[entry.level](record, event.event);
    },
  };
}

/** Logger que no escribe nada (comandos y tests). */
export const silentLogger: LoggerLike = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
