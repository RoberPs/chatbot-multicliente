/**
 * Caducidad de las copias (US4, FR-018 – FR-020, SC-006): solo las propias y nunca la última
 * válida.
 */
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyRetention } from '../../../src/backup/retention.js';
import { createBackup } from '../../../src/backup/service.js';
import { main } from '../../../src/cli/backups.js';
import {
  captureLogger,
  cliEnv,
  seedInstance,
  tempBackupDir,
  testBackupConfig,
  testClock,
  testIO,
  type TempDir,
} from '../../helpers/backup.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const DAY = 24 * 60 * 60 * 1000;
let test: TestDatabase;
let dir: TempDir;

beforeAll(async () => {
  test = await createTestDatabase();
  await seedInstance(test.db);
});
afterAll(async () => {
  await test.close();
});
beforeEach(async () => {
  dir = await tempBackupDir();
});
afterEach(async () => {
  await dir.remove();
});

/** Copias con `createdAt` forzado; la retención de 30 días no borra nada mientras se crean. */
async function backupsAged(days: number[], instanceId = 'test-01', now = new Date()) {
  const files: Record<number, string> = {};
  for (const age of days) {
    const clock = testClock(new Date(now.getTime() - age * DAY));
    const report = await createBackup({
      databaseUrl: test.url,
      config: testBackupConfig({ dir: dir.path, instanceId, retentionDays: 30 }),
      reason: 'manual',
      clock,
    });
    files[age] = report.file;
  }
  return files;
}

const strangers = {
  foreign: 'notas-del-operador.txt',
  similar: 'test-01__0006_usage__20260101T000000Z__manual.cbak.bak',
  partial: '.test-01__0006_usage__20260101T000000Z__manual.cbak.partial',
};

describe('retención de las copias', () => {
  it('una copia nueva borra las propias caducadas y deja lo ajeno', async () => {
    const now = new Date('2026-09-29T10:00:00.000Z');
    const aged = await backupsAged([20, 8, 5, 1], 'test-01', now);
    const [other] = Object.values(await backupsAged([20], 'otra-02', now));
    for (const name of Object.values(strangers)) await writeFile(join(dir.path, name), 'x');

    const logger = captureLogger();
    const report = await createBackup({
      databaseUrl: test.url,
      config: testBackupConfig({ dir: dir.path, retentionDays: 7 }),
      reason: 'manual',
      clock: testClock(now),
      logger,
    });
    expect(report.retention).toEqual({ deleted: 2, kept: 3 });
    const left = await readdir(dir.path);
    expect(left).not.toContain(aged[20]);
    expect(left).not.toContain(aged[8]);
    for (const name of [aged[5], aged[1], report.file, other, ...Object.values(strangers)]) {
      expect(left).toContain(name);
    }
    expect(logger.events('backup_retention_applied')).toEqual([
      {
        channel: 'backup',
        event: 'backup_retention_applied',
        deleted: 2,
        kept: 3,
        keptExpiredLatest: false,
      },
    ]);
  });

  it('con todas caducadas queda la más reciente válida', async () => {
    const now = new Date('2026-09-29T10:00:00.000Z');
    const aged = await backupsAged([20, 10], 'test-01', now);
    const logger = captureLogger();
    const result = await applyRetention({
      config: testBackupConfig({ dir: dir.path, retentionDays: 7 }),
      clock: testClock(now),
      logger,
    });
    expect(result).toEqual({ deleted: 1, kept: 1, keptExpiredLatest: true });
    expect(await readdir(dir.path)).toEqual([aged[10]]);
    expect(logger.events('backup_retention_applied')[0]).toMatchObject({
      keptExpiredLatest: true,
    });
  });

  it('una copia con otra clave (no válida) no cuenta como la última válida', async () => {
    const now = new Date('2026-09-29T10:00:00.000Z');
    const aged = await backupsAged([20, 10], 'test-01', now);
    const result = await applyRetention({
      // Solo la clave nueva: ninguna copia existente se autentica.
      config: testBackupConfig({
        dir: dir.path,
        retentionDays: 7,
        key: 'ab12cd34ef56ab78cd90ef12ab34cd56ef78ab90cd12ef34ab56cd78ef90ab12',
      }),
      clock: testClock(now),
    });
    expect(result.deleted).toBe(2);
    expect(await readdir(dir.path)).not.toContain(aged[10]);
  });

  it('pnpm db:backups lista solo las propias y --prune aplica la retención', async () => {
    const aged = await backupsAged([20, 3]);
    await backupsAged([2], 'otra-02');
    for (const name of Object.values(strangers)) await writeFile(join(dir.path, name), 'x');

    const env = cliEnv(test.url, dir.path, { BACKUP_RETENTION_DAYS: '7' });
    const list = testIO(env);
    expect(await main([], list)).toBe(0);
    expect(list.stdout[0]).toBe('Copias de la instancia test-01 (2):');
    const rows = list.stdout.slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(
      new RegExp(
        `^${String(aged[3])} · [\\d,]+ (B|KB|MB) · \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} \\(Europe/Madrid\\) · manual · 0006_usage · válida: sí · caduca: `,
      ),
    );
    expect(list.stdout.join('\n')).not.toContain('otra-02');
    expect(list.stdout.join('\n')).not.toContain('.partial');

    const prune = testIO(env);
    expect(await main(['--prune'], prune)).toBe(0);
    expect(prune.stdout[0]).toBe('Retención (7 días): 1 copias borradas, 1 conservadas.');
    expect(await readdir(dir.path)).not.toContain(aged[20]);

    const json = testIO(env);
    expect(await main(['--json'], json)).toBe(0);
    const parsed = JSON.parse(json.stdout[0] ?? '{}') as { backups: Array<{ file: string }> };
    expect(parsed.backups.map((b) => b.file)).toEqual([aged[3]]);
  });
});
