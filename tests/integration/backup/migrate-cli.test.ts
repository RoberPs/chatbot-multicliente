import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseSchema, installedSchema } from '../../../src/backup/schema-version.js';
import { migrateMain } from '../../../src/db/migrate.js';
import {
  cliEnv,
  createDatabaseMigratedUpTo,
  seedSchema0003,
  tempBackupDir,
  testIO,
  withClient,
  type ScratchDatabase,
  type TempDir,
} from '../../helpers/backup.js';

const opened: ScratchDatabase[] = [];
let dir: TempDir;

beforeAll(async () => {
  dir = await tempBackupDir();
});
afterAll(async () => {
  for (const d of opened) await d.close();
  await dir.remove();
});

async function oldInstance(): Promise<ScratchDatabase> {
  const old = await createDatabaseMigratedUpTo(3);
  opened.push(old);
  await seedSchema0003(old.url);
  return old;
}

const noBackup = { INSTANCE_ID: undefined, BACKUP_DIR: undefined, BACKUP_KEY: undefined };

describe('pnpm db:migrate', () => {
  it('con datos y pendientes, sin configuración de copias → código 1 y el esquema no cambia', async () => {
    const old = await oldInstance();
    const io = testIO(cliEnv(old.url, dir.path, noBackup));
    expect(await migrateMain(io)).toBe(1);
    expect(io.stderr).toEqual([
      'No se aplican las migraciones pendientes (0004_handoff, 0005_config_transfer, 0006_usage, 0007_chat_design): no se pudo hacer la copia previa (backup_not_configured). El esquema no ha cambiado.',
    ]);
    expect(await withClient(old.url, (c) => databaseSchema(c))).toMatchObject({
      tag: '0003_map_url',
    });
  });

  it('con configuración de copias crea la copia previa y migra', async () => {
    const old = await oldInstance();
    const io = testIO(cliEnv(old.url, dir.path));
    expect(await migrateMain(io)).toBe(0);
    expect(io.stdout).toEqual(['Migraciones aplicadas']);
    expect(await readdir(dir.path)).toEqual([
      expect.stringMatching(/^test-01__0003_map_url__\d{8}T\d{6}Z__premigration\.cbak$/),
    ]);
    expect(await withClient(old.url, (c) => databaseSchema(c))).toEqual(installedSchema());
  });
});
