import { describe, expect, it } from 'vitest';
import { backupEventLevels, createBackupLog, type BackupEvent } from '../../../src/backup/log.js';
import type { LoggerLike } from '../../../src/conversation/activity-log.js';

function capture() {
  const lines: Array<{ level: string; obj: Record<string, unknown>; msg?: string }> = [];
  const make =
    (level: string) =>
    (obj: object, msg?: string): void => {
      lines.push({ level, obj: obj as Record<string, unknown>, msg });
    };
  const logger: LoggerLike = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
  };
  return { logger, lines };
}

const tables = [{ name: 'business', rows: 1 }];

const events: BackupEvent[] = [
  {
    event: 'backup_created',
    file: 'a__0004_handoff__20260929T101500Z__manual.cbak',
    reason: 'manual',
    sizeBytes: 10,
    schema: '0004_handoff',
    durationMs: 5,
    tables,
  },
  { event: 'backup_failed', reason: 'daily', failure: 'no_space' },
  { event: 'backup_disabled', missing: ['BACKUP_KEY'] },
  { event: 'backup_retention_applied', deleted: 1, kept: 2, keptExpiredLatest: false },
  { event: 'migration_blocked', pending: ['0005_x'], failure: 'backup_not_configured' },
  { event: 'migration_failed', pending: ['0005_x'], premigrationFile: 'f.cbak' },
  {
    event: 'restore_completed',
    file: 'f.cbak',
    sourceInstance: 'a',
    crossInstance: false,
    schema: '0004_handoff',
    installedSchema: '0004_handoff',
    durationMs: 3,
    tables,
    expiredConversations: 0,
  },
  { event: 'restore_rejected', file: 'f.cbak', failure: 'corrupted' },
  {
    event: 'verify_completed',
    file: 'f.cbak',
    restorable: true,
    schema: '0004_handoff',
    durationMs: 9,
    orphansListed: true,
    orphansRemoved: 2,
    orphansFailed: 1,
  },
];

describe('registros de las copias', () => {
  it.each(events.map((e) => [e.event, e] as const))(
    '%s sale con channel backup, su nivel y solo sus campos',
    (_name, event) => {
      const { logger, lines } = capture();
      createBackupLog(logger).log(event);
      expect(lines).toHaveLength(1);
      const [line] = lines;
      expect(line?.level).toBe(backupEventLevels[event.event]);
      expect(line?.msg).toBe(event.event);
      expect(line?.obj).toEqual({ channel: 'backup', ...event });
    },
  );

  it('un campo no previsto se descarta', () => {
    const { logger, lines } = capture();
    createBackupLog(logger).log({
      event: 'backup_failed',
      reason: 'manual',
      failure: 'db_error',
      message: 'duplicate key value (telefono)=(+34600111222)',
      path: '/var/lib/chatbot/backups/secreto',
    } as BackupEvent);
    expect(lines[0]?.obj).toEqual({
      channel: 'backup',
      event: 'backup_failed',
      reason: 'manual',
      failure: 'db_error',
    });
  });

  it('las tablas solo llevan nombre y recuento', () => {
    const { logger, lines } = capture();
    createBackupLog(logger).log({
      ...(events[0] as Extract<BackupEvent, { event: 'backup_created' }>),
      tables: [{ name: 'business', rows: 1, extra: 'x' } as never],
    });
    expect(lines[0]?.obj.tables).toEqual([{ name: 'business', rows: 1 }]);
  });

  it('verify_completed lleva los recuentos de huérfanas y ningún nombre de base (013)', () => {
    const { logger, lines } = capture();
    createBackupLog(logger).log({
      event: 'verify_completed',
      file: 'f.cbak',
      restorable: false,
      failure: 'verify_db_unavailable',
      durationMs: 3,
      orphansListed: false,
      orphansRemoved: 0,
      orphansFailed: 0,
      database: 'verify_20261006093000_0123456789abcdef',
      orphanNames: ['verify_0123456789abcdef'],
    } as BackupEvent);
    expect(lines[0]?.obj).toEqual({
      channel: 'backup',
      event: 'verify_completed',
      file: 'f.cbak',
      restorable: false,
      failure: 'verify_db_unavailable',
      durationMs: 3,
      orphansListed: false,
      orphansRemoved: 0,
      orphansFailed: 0,
    });
    expect(JSON.stringify(lines[0]?.obj)).not.toContain('verify_2026');
  });

  it('restore_completed es warn y los fallos son error', () => {
    expect(backupEventLevels.restore_completed).toBe('warn');
    expect(backupEventLevels.backup_failed).toBe('error');
    expect(backupEventLevels.migration_blocked).toBe('error');
  });
});
