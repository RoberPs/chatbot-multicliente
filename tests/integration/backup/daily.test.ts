/**
 * Copia diaria automática (US6, R10, FR-026 – FR-028) con reloj controlable y pasadas manuales.
 * Fechas de septiembre: Madrid = UTC+2, México = UTC−6.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_IN_PROGRESS, tryAdvisoryLock } from '../../../src/backup/locks.js';
import { createBackupScheduler } from '../../../src/backup/scheduler.js';
import { createBackup } from '../../../src/backup/service.js';
import { business } from '../../../src/db/schema.js';
import {
  captureLogger,
  seedInstance,
  tempBackupDir,
  testBackupConfig,
  testClock,
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
  await test.db.update(business).set({ timezone: 'Europe/Madrid' }).where(eq(business.id, 1));
});
afterEach(async () => {
  await dir.remove();
});

const dailies = async () => (await readdir(dir.path)).filter((f) => f.endsWith('__daily.cbak'));

function scheduler(
  clock: ReturnType<typeof testClock>,
  overrides: Partial<Parameters<typeof testBackupConfig>[0]> = {},
  extra: Partial<Parameters<typeof createBackupScheduler>[0]> = {},
) {
  const logger = captureLogger();
  const s = createBackupScheduler({
    databaseUrl: test.url,
    db: test.db,
    config: testBackupConfig({ dir: dir.path, dailyTime: '03:00', ...overrides }),
    clock,
    logger,
    ...extra,
  });
  return { s, logger };
}

describe('copia diaria', () => {
  it('antes de la hora no copia; después crea una y no dos el mismo día, tampoco tras reiniciar', async () => {
    const clock = testClock('2026-09-29T00:30:00Z'); // 02:30 local
    const { s } = scheduler(clock);
    await s.tick();
    expect(await dailies()).toEqual([]);

    clock.set('2026-09-29T01:05:00Z'); // 03:05 local
    await s.tick();
    expect(await dailies()).toEqual([
      'test-01__0005_config_transfer__20260929T010500Z__daily.cbak',
    ]);

    clock.advance(60_000);
    await s.tick();
    const restarted = scheduler(clock).s;
    await restarted.tick();
    expect(await dailies()).toHaveLength(1);

    clock.set('2026-09-30T01:01:00Z'); // día siguiente
    await s.tick();
    expect(await dailies()).toHaveLength(2);
  });

  it('un arranque tarde el mismo día hace la copia que faltaba', async () => {
    const clock = testClock('2026-09-29T13:00:00Z'); // 15:00 local
    await scheduler(clock).s.tick();
    expect(await dailies()).toHaveLength(1);
  });

  it('un fallo se registra y no se reintenta hasta el día siguiente (o al reiniciar)', async () => {
    const clock = testClock('2026-09-29T08:00:00Z');
    const missing = { dir: join(dir.path, 'no-existe') };
    const { s, logger } = scheduler(clock, missing);
    await s.tick();
    expect(logger.events('backup_failed')).toEqual([
      { channel: 'backup', event: 'backup_failed', reason: 'daily', failure: 'dir_missing' },
    ]);
    clock.advance(60_000);
    await s.tick();
    expect(logger.events('backup_failed')).toHaveLength(1);

    const again = scheduler(clock, missing);
    await again.s.tick();
    expect(again.logger.events('backup_failed')).toHaveLength(1);

    clock.set('2026-09-30T08:00:00Z');
    await s.tick();
    expect(logger.events('backup_failed')).toHaveLength(2);
  });

  it('con otra copia en curso no marca el día y reintenta en la siguiente pasada', async () => {
    const clock = testClock('2026-09-29T08:00:00Z');
    const { s } = scheduler(clock);
    const lock = await tryAdvisoryLock(test.url, BACKUP_IN_PROGRESS);
    try {
      await s.tick();
      expect(await dailies()).toEqual([]);
    } finally {
      await lock?.release();
    }
    clock.advance(60_000);
    await s.tick();
    expect(await dailies()).toHaveLength(1);
  });

  it('tras la copia aplica la retención', async () => {
    const now = new Date('2026-09-29T08:00:00Z');
    const old = await createBackup({
      databaseUrl: test.url,
      config: testBackupConfig({ dir: dir.path, retentionDays: 30 }),
      reason: 'daily',
      clock: testClock(new Date(now.getTime() - 10 * DAY)),
    });
    const { s, logger } = scheduler(testClock(now), { retentionDays: 7 });
    await s.tick();
    const files = await readdir(dir.path);
    expect(files).not.toContain(old.file);
    expect(await dailies()).toHaveLength(1);
    expect(logger.events('backup_retention_applied')[0]).toMatchObject({ deleted: 1 });
  });

  it('la zona horaria del negocio se relee en cada pasada', async () => {
    const clock = testClock('2026-09-29T05:00:00Z'); // Madrid 07:00 del 29
    const { s } = scheduler(clock);
    await s.tick();
    expect(await dailies()).toHaveLength(1);

    // En México son las 23:00 del 28: la copia de las 05:00Z es de su 28 → sin copia nueva.
    await test.db
      .update(business)
      .set({ timezone: 'America/Mexico_City' })
      .where(eq(business.id, 1));
    clock.set('2026-09-29T09:30:00Z'); // México 03:30 del 29; Madrid 11:30 del 29
    await s.tick();
    expect(await dailies()).toHaveLength(2);
  });

  it('stop() espera a la copia en curso', async () => {
    const clock = testClock('2026-09-29T08:00:00Z');
    const slow = () =>
      new Transform({
        transform(chunk: Buffer, _e, callback) {
          setTimeout(() => {
            callback(null, chunk);
          }, 20);
        },
      });
    const { s } = scheduler(clock, {}, { internal: { throughput: slow } });
    s.start();
    await s.stop();
    const files = await readdir(dir.path);
    expect(files.filter((f) => f.endsWith('.partial'))).toEqual([]);
    expect(await dailies()).toHaveLength(1);
  });

  it('sin espacio: registra el fallo y aun así borra las caducadas conservando la última válida', async () => {
    const now = new Date('2026-09-29T08:00:00Z');
    const created: string[] = [];
    for (const age of [20, 10]) {
      const r = await createBackup({
        databaseUrl: test.url,
        config: testBackupConfig({ dir: dir.path, retentionDays: 30 }),
        reason: 'daily',
        clock: testClock(new Date(now.getTime() - age * DAY)),
      });
      created.push(r.file);
    }
    const full = () =>
      new Transform({
        transform(_chunk, _e, callback) {
          callback(Object.assign(new Error('lleno'), { code: 'ENOSPC' }));
        },
      });
    const { s, logger } = scheduler(
      testClock(now),
      { retentionDays: 7 },
      { internal: { throughput: full } },
    );
    await s.tick();
    expect(logger.events('backup_failed')).toEqual([
      { channel: 'backup', event: 'backup_failed', reason: 'daily', failure: 'no_space' },
    ]);
    expect(logger.events('backup_retention_applied')).toEqual([
      {
        channel: 'backup',
        event: 'backup_retention_applied',
        deleted: 1,
        kept: 1,
        keptExpiredLatest: true,
      },
    ]);
    expect(await readdir(dir.path)).toEqual([created[1]]);
  });
});
