import { readFileSync } from 'node:fs';
import { chmod, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { countRows, listTables } from '../../../src/backup/dump.js';
import { BackupError } from '../../../src/backup/errors.js';
import { readHeader } from '../../../src/backup/format.js';
import { BACKUP_IN_PROGRESS, tryAdvisoryLock } from '../../../src/backup/locks.js';
import { BACKUP_NAME_PATTERN } from '../../../src/backup/naming.js';
import { databaseSchema } from '../../../src/backup/schema-version.js';
import { createBackup } from '../../../src/backup/service.js';
import {
  captureLogger,
  seedInstance,
  tempBackupDir,
  testBackupConfig,
  testClock,
  withClient,
  type SeededInstance,
  type TempDir,
} from '../../helpers/backup.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

let test: TestDatabase;
let seeded: SeededInstance;
let dir: TempDir;

beforeAll(async () => {
  test = await createTestDatabase();
  seeded = await seedInstance(test.db);
});
afterAll(async () => {
  await test.close();
});
beforeEach(async () => {
  dir = await tempBackupDir();
});
afterEach(async () => {
  await chmod(dir.path, 0o700).catch(() => undefined);
  await dir.remove();
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(BackupError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('copia bajo demanda (US1)', () => {
  it('deja un único fichero cifrado cuya cabecera identifica la copia', async () => {
    const clock = testClock('2026-09-29T10:15:00.000Z');
    const logger = captureLogger();
    const config = testBackupConfig({ dir: dir.path });
    const report = await createBackup({
      databaseUrl: test.url,
      config,
      reason: 'manual',
      clock,
      logger,
    });

    const files = await readdir(dir.path);
    expect(files).toEqual([report.file]);
    expect(report.file).toMatch(BACKUP_NAME_PATTERN);
    expect(report.file).toBe('test-01__0007_chat_design__20260929T101500Z__manual.cbak');

    const path = join(dir.path, report.file);
    const { header } = await readHeader(path);
    const expected = await withClient(test.url, async (client) => {
      const schema = await databaseSchema(client);
      const tables = [];
      for (const t of await listTables(client)) {
        tables.push({
          schema: t.schema,
          name: t.name,
          rows: await countRows(client, t.schema, t.name),
        });
      }
      return { schema, tables };
    });
    expect(header).toMatchObject({
      instanceId: 'test-01',
      schema: expected.schema,
      coreVersion: pkg.version,
      createdAt: '2026-09-29T10:15:00.000Z',
      reason: 'manual',
      tables: expected.tables,
    });
    expect(header.tables.map((t) => `${t.schema}.${t.name}`)).toContain(
      'drizzle.__drizzle_migrations',
    );

    // Nada legible sin la clave (SC-004).
    const bytes = await readFile(path);
    for (const secret of [seeded.businessName, ...seeded.phones, ...seeded.texts]) {
      expect(bytes.includes(Buffer.from(secret, 'utf8'))).toBe(false);
    }

    expect(report).toMatchObject({
      file: report.file,
      sizeBytes: bytes.length,
      schema: '0007_chat_design',
      reason: 'manual',
      createdAt: '2026-09-29T10:15:00.000Z',
    });
    expect(report.file).not.toContain(dir.path);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.tables).toEqual(expected.tables.map((t) => ({ name: t.name, rows: t.rows })));

    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }

    expect(logger.events('backup_created')).toEqual([
      {
        channel: 'backup',
        event: 'backup_created',
        file: report.file,
        reason: 'manual',
        sizeBytes: report.sizeBytes,
        schema: '0007_chat_design',
        durationMs: report.durationMs,
        tables: report.tables,
      },
    ]);
  });

  it('sin clave → key_missing sin ningún fichero', async () => {
    const logger = captureLogger();
    await expectCode(
      createBackup({
        databaseUrl: test.url,
        config: testBackupConfig({ dir: dir.path, key: undefined }),
        reason: 'manual',
        logger,
      }),
      'key_missing',
    );
    expect(await readdir(dir.path)).toEqual([]);
    expect(logger.events('backup_failed')).toContainEqual({
      channel: 'backup',
      event: 'backup_failed',
      reason: 'manual',
      failure: 'key_missing',
    });
  });

  it('clave con formato no válido → key_invalid', async () => {
    await expectCode(
      createBackup({
        databaseUrl: test.url,
        config: testBackupConfig({ dir: dir.path, key: 'abc' }),
        reason: 'manual',
      }),
      'key_invalid',
    );
  });

  it('directorio inexistente → dir_missing', async () => {
    await expectCode(
      createBackup({
        databaseUrl: test.url,
        config: testBackupConfig({ dir: join(dir.path, 'no-existe') }),
        reason: 'manual',
      }),
      'dir_missing',
    );
    expect(await readdir(dir.path)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'directorio de solo lectura → dir_not_writable',
    async () => {
      await chmod(dir.path, 0o500);
      await expectCode(
        createBackup({
          databaseUrl: test.url,
          config: testBackupConfig({ dir: dir.path }),
          reason: 'manual',
        }),
        'dir_not_writable',
      );
      await chmod(dir.path, 0o700);
      expect(await readdir(dir.path)).toEqual([]);
    },
  );

  it('con otra copia en curso → busy', async () => {
    const lock = await tryAdvisoryLock(test.url, BACKUP_IN_PROGRESS);
    expect(lock).not.toBeNull();
    try {
      await expectCode(
        createBackup({
          databaseUrl: test.url,
          config: testBackupConfig({ dir: dir.path }),
          reason: 'manual',
        }),
        'busy',
      );
    } finally {
      await lock?.release();
    }
    expect(await readdir(dir.path)).toEqual([]);
  });

  it('un fallo a mitad de escritura borra el parcial', async () => {
    let seen = 0;
    const failing = () =>
      new Transform({
        transform(chunk: Buffer, _e, callback) {
          seen += chunk.length;
          if (seen > 100) callback(Object.assign(new Error('disco'), { code: 'EIO' }));
          else callback(null, chunk);
        },
      });
    await expectCode(
      createBackup({
        databaseUrl: test.url,
        config: testBackupConfig({ dir: dir.path }),
        reason: 'manual',
        internal: { throughput: failing },
      }),
      'io_error',
    );
    expect(await readdir(dir.path)).toEqual([]);
  });

  it('sin espacio en disco → no_space y sin parcial', async () => {
    const full = () =>
      new Transform({
        transform(_chunk, _e, callback) {
          callback(Object.assign(new Error('lleno'), { code: 'ENOSPC' }));
        },
      });
    await expectCode(
      createBackup({
        databaseUrl: test.url,
        config: testBackupConfig({ dir: dir.path }),
        reason: 'manual',
        internal: { throughput: full },
      }),
      'no_space',
    );
    expect(await readdir(dir.path)).toEqual([]);
  });

  it('borra los .partial propios de más de 1 h, no los recientes ni los de otra instancia', async () => {
    const old = '.test-01__0007_chat_design__20260101T000000Z__manual.cbak.partial';
    const recent = '.test-01__0007_chat_design__20260102T000000Z__manual.cbak.partial';
    const foreign = '.otra-02__0007_chat_design__20260101T000000Z__manual.cbak.partial';
    for (const name of [old, recent, foreign]) await writeFile(join(dir.path, name), 'x');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(join(dir.path, old), twoHoursAgo, twoHoursAgo);
    await utimes(join(dir.path, foreign), twoHoursAgo, twoHoursAgo);

    const report = await createBackup({
      databaseUrl: test.url,
      config: testBackupConfig({ dir: dir.path }),
      reason: 'manual',
    });
    expect((await readdir(dir.path)).sort()).toEqual([foreign, recent, report.file].sort());
  });
});
