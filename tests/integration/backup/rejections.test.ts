/**
 * Rechazos de la restauración (US2-4 – US2-6, FR-008 – FR-010, SC-008): ninguno toca la BD.
 */
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyId } from '../../../src/backup/config.js';
import { RestoreFailure } from '../../../src/backup/errors.js';
import { createBackupWriter, readHeader } from '../../../src/backup/format.js';
import { INSTANCE_RUNNING, tryAdvisoryLock } from '../../../src/backup/locks.js';
import { installedSchema } from '../../../src/backup/schema-version.js';
import { createBackup, restoreBackup, type BackupReport } from '../../../src/backup/service.js';
import {
  captureLogger,
  seedInstance,
  tableSnapshot,
  tempBackupDir,
  testBackupConfig,
  TEST_KEY,
  TEST_KEY_2,
  type TempDir,
} from '../../helpers/backup.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

let test: TestDatabase;
let dir: TempDir;
let backup: BackupReport;
let foreign: BackupReport;
let config: ReturnType<typeof testBackupConfig>;

beforeAll(async () => {
  test = await createTestDatabase();
  dir = await tempBackupDir();
  await seedInstance(test.db);
  config = testBackupConfig({ dir: dir.path });
  backup = await createBackup({ databaseUrl: test.url, config, reason: 'manual' });
  foreign = await createBackup({
    databaseUrl: test.url,
    config: { ...config, instanceId: 'otra-02' },
    reason: 'manual',
  });
});
afterAll(async () => {
  await test.close();
  await dir.remove();
});

const path = (name: string) => join(dir.path, name);

async function expectRejected(
  file: string,
  code: string,
  overrides: Partial<Parameters<typeof restoreBackup>[0]> = {},
): Promise<RestoreFailure> {
  const before = await tableSnapshot(test.url);
  const logger = captureLogger();
  const error = await restoreBackup({
    databaseUrl: test.url,
    file,
    config,
    logger,
    ...overrides,
  }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RestoreFailure);
  expect((error as RestoreFailure).code).toBe(code);
  expect(await tableSnapshot(test.url)).toEqual(before);
  expect(logger.events('restore_rejected')).toEqual([
    {
      channel: 'backup',
      event: 'restore_rejected',
      file: file.split(/[\\/]/).at(-1),
      failure: code,
    },
  ]);
  return error as RestoreFailure;
}

/** Escribe una copia con cabecera forjada (cifrada con la clave de test). */
async function forged(name: string, schema: { index: number; tag: string; hash: string }) {
  const { header } = await readHeader(path(backup.file));
  const { stream } = createBackupWriter(
    {
      instanceId: header.instanceId,
      schema,
      coreVersion: '9.0.0',
      createdAt: header.createdAt,
      reason: 'manual',
      tables: header.tables,
    },
    Buffer.from(TEST_KEY, 'hex'),
  );
  await pipeline(Readable.from([Buffer.from('')]), stream, createWriteStream(path(name)));
  return path(name);
}

describe('rechazos de la restauración', () => {
  it('un byte cambiado → corrupted', async () => {
    const bytes = await readFile(path(backup.file));
    const at = Math.floor(bytes.length / 2);
    bytes[at] = (bytes[at] ?? 0) ^ 0x01;
    await writeFile(path('danada.cbak'), bytes);
    await expectRejected(path('danada.cbak'), 'corrupted');
  });

  it('truncada → corrupted', async () => {
    const bytes = await readFile(path(backup.file));
    await writeFile(path('truncada.cbak'), bytes.subarray(0, bytes.length - 40));
    await expectRejected(path('truncada.cbak'), 'corrupted');
  });

  it('fichero ajeno → not_a_backup', async () => {
    await writeFile(path('ajeno.cbak'), '-- PostgreSQL database dump\n');
    await expectRejected(path('ajeno.cbak'), 'not_a_backup');
  });

  it('otra BACKUP_KEY → wrong_key con el keyId y sin la clave en el mensaje', async () => {
    const error = await expectRejected(path(backup.file), 'wrong_key', {
      config: { ...config, key: TEST_KEY_2 },
    });
    expect(error.details.keyId).toBe(keyId(Buffer.from(TEST_KEY, 'hex')));
    expect(JSON.stringify(error)).not.toContain(TEST_KEY);
    expect(error.message).not.toContain(TEST_KEY);
  });

  it('la clave anterior en BACKUP_KEYS_PREVIOUS restaura', async () => {
    const report = await restoreBackup({
      databaseUrl: test.url,
      file: path(backup.file),
      config: { ...config, key: TEST_KEY_2, previousKeys: [TEST_KEY] },
    });
    expect(report.sourceInstance).toBe('test-01');
  });

  it('copia de otra instancia: sin --from-instance o con otro valor → other_instance', async () => {
    const a = await expectRejected(path(foreign.file), 'other_instance');
    expect(a.details.sourceInstance).toBe('otra-02');
    await expectRejected(path(foreign.file), 'other_instance', { fromInstance: 'otra-03' });
  });

  it('copia de otra instancia con --from-instance igual a la cabecera → restaura', async () => {
    const logger = captureLogger();
    const report = await restoreBackup({
      databaseUrl: test.url,
      file: path(foreign.file),
      config,
      fromInstance: 'otra-02',
      logger,
    });
    expect(report).toMatchObject({ sourceInstance: 'otra-02', crossInstance: true });
    expect(logger.events('restore_completed')[0]).toMatchObject({ crossInstance: true });
  });

  it('esquema posterior al instalado → schema_newer con el núcleo de la copia', async () => {
    const file = await forged('futura.cbak', {
      index: installedSchema().index + 1,
      tag: '0005_futura',
      hash: 'b'.repeat(64),
    });
    const error = await expectRejected(file, 'schema_newer');
    expect(error.details).toMatchObject({
      schema: '0005_futura',
      coreVersion: '9.0.0',
      installedSchema: installedSchema().tag,
    });
  });

  it('mismo índice con otro hash → schema_mismatch', async () => {
    const installed = installedSchema();
    const file = await forged('rama.cbak', { ...installed, hash: 'c'.repeat(64) });
    await expectRejected(file, 'schema_mismatch');
  });

  it('con la instancia en marcha → instance_running', async () => {
    const lock = await tryAdvisoryLock(test.url, INSTANCE_RUNNING);
    try {
      await expectRejected(path(backup.file), 'instance_running');
    } finally {
      await lock?.release();
    }
  });

  it('mientras restaura, nadie más puede tomar el bloqueo de instancia en marcha', async () => {
    let observed: unknown = 'sin comprobar';
    await restoreBackup({
      databaseUrl: test.url,
      file: path(backup.file),
      config,
      internal: {
        afterTable: async (loaded) => {
          if (loaded !== 1) return;
          const lock = await tryAdvisoryLock(test.url, INSTANCE_RUNNING);
          observed = lock;
          await lock?.release();
        },
      },
    });
    expect(observed).toBeNull();
  });

  it('una copia copiada con otro nombre sigue siendo la misma copia', async () => {
    await copyFile(path(backup.file), path('renombrada.cbak'));
    const report = await restoreBackup({
      databaseUrl: test.url,
      file: path('renombrada.cbak'),
      config,
    });
    expect(report.file).toBe('renombrada.cbak');
  });

  it('sin ninguna clave → key_missing', async () => {
    await expectRejected(path(backup.file), 'key_missing', {
      config: { ...config, key: undefined },
    });
  });

  it('clave aleatoria distinta que no es de ninguna copia → wrong_key', async () => {
    await expectRejected(path(backup.file), 'wrong_key', {
      config: { ...config, key: randomBytes(32).toString('hex') },
    });
  });
});
