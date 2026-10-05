/**
 * Comprobación de una copia en una BD temporal (US5, R12, FR-021): la instancia no cambia y la
 * BD temporal se borra siempre.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { readHeader } from '../../../src/backup/format.js';
import { createBackup, verifyBackup, type BackupReport } from '../../../src/backup/service.js';
import { main } from '../../../src/cli/verify.js';
import {
  captureLogger,
  cliEnv,
  databasesLike,
  seedInstance,
  tableSnapshot,
  tempBackupDir,
  testBackupConfig,
  testIO,
  TEST_KEY_2,
  withClient,
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

describe('comprobación de una copia', () => {
  it('copia válida → restaurable, con los recuentos de la cabecera y sin BD temporal', async () => {
    const before = await tableSnapshot(test.url);
    const logger = captureLogger();
    const report = await verifyBackup({ file: path(backup.file), config, logger });
    const { header } = await readHeader(path(backup.file));
    expect(report).toMatchObject({
      file: backup.file,
      restorable: true,
      sourceInstance: 'test-01',
      schema: '0007_chat_design',
      createdAt: header.createdAt,
      tables: header.tables.map((t) => ({ name: t.name, rows: t.rows })),
    });
    expect(await databasesLike('verify_')).toEqual([]);
    expect(await tableSnapshot(test.url)).toEqual(before);
    expect(logger.events('verify_completed')).toEqual([
      {
        channel: 'backup',
        event: 'verify_completed',
        file: backup.file,
        restorable: true,
        schema: '0007_chat_design',
        durationMs: report.durationMs,
      },
    ]);
  });

  it('copia con un byte cambiado → no restaurable (corrupted) y sin BD temporal', async () => {
    const bytes = await readFile(path(backup.file));
    const at = Math.floor(bytes.length / 2);
    bytes[at] = (bytes[at] ?? 0) ^ 0x10;
    await writeFile(path('danada.cbak'), bytes);
    const report = await verifyBackup({ file: path('danada.cbak'), config });
    expect(report).toMatchObject({ restorable: false, failure: 'corrupted' });
    expect(await databasesLike('verify_')).toEqual([]);
  });

  it('otra clave → wrong_key', async () => {
    const report = await verifyBackup({
      file: path(backup.file),
      config: { ...config, key: TEST_KEY_2 },
    });
    expect(report).toMatchObject({ restorable: false, failure: 'wrong_key' });
  });

  it('copia de otra instancia → restaurable y dice de cuál es', async () => {
    const report = await verifyBackup({ file: path(foreign.file), config });
    expect(report).toMatchObject({ restorable: true, sourceInstance: 'otra-02' });
  });

  it('usuario sin CREATEDB o servidor inalcanzable → verify_db_unavailable', async () => {
    const admin = inject('pgAdminUrl');
    await withClient(admin, async (client) => {
      await client.query(`drop role if exists sin_createdb`);
      await client.query(`create role sin_createdb login password 'sin-createdb' nocreatedb`);
    });
    const url = new URL(admin);
    url.username = 'sin_createdb';
    url.password = 'sin-createdb';
    const noCreate = await verifyBackup({
      file: path(backup.file),
      config: { ...config, verifyUrl: url.toString() },
    });
    expect(noCreate).toMatchObject({ restorable: false, failure: 'verify_db_unavailable' });

    const unreachable = await verifyBackup({
      file: path(backup.file),
      config: { ...config, verifyUrl: 'postgres://nadie:nada@127.0.0.1:1/postgres' },
    });
    expect(unreachable).toMatchObject({ restorable: false, failure: 'verify_db_unavailable' });
    expect(await databasesLike('verify_')).toEqual([]);
  });

  it('pnpm db:verify sale con 0 si es restaurable y 1 si no', async () => {
    const env = cliEnv(test.url, dir.path, { BACKUP_VERIFY_URL: inject('pgAdminUrl') });
    const ok = testIO(env);
    expect(await main([backup.file], ok)).toBe(0);
    expect(ok.stdout[0]).toBe(`Comprobación: ${backup.file}`);
    expect(ok.stdout[1]).toMatch(
      /^ {2}RESTAURABLE · instancia test-01 · esquema 0007_chat_design · núcleo /,
    );
    expect(ok.stdout[2]).toMatch(/tablas; recuentos iguales a la copia\)$/);
    expect(ok.stdout[3]).toBe('  Base de datos temporal eliminada.');

    const bad = testIO(env);
    expect(await main(['danada.cbak'], bad)).toBe(1);
    expect(bad.stdout[1]).toBe('  NO RESTAURABLE: la copia está dañada o incompleta (corrupted).');

    const json = testIO(env);
    expect(await main([backup.file, '--json'], json)).toBe(0);
    expect(JSON.parse(json.stdout[0] ?? '{}')).toMatchObject({ restorable: true });
  });
});
