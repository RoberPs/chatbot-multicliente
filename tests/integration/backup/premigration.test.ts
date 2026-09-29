/**
 * Copia obligatoria antes de las migraciones (US3, R9, FR-014 – FR-017, SC-003).
 */
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MigrationBlockedError, MigrationFailedError } from '../../../src/backup/errors.js';
import { readHeader } from '../../../src/backup/format.js';
import {
  databaseSchema,
  defaultMigrationsFolder,
  installedSchema,
} from '../../../src/backup/schema-version.js';
import { restoreBackup } from '../../../src/backup/service.js';
import { runMigrations } from '../../../src/db/migrate.js';
import {
  captureLogger,
  createDatabaseMigratedUpTo,
  seedInstance,
  seedSchema0003,
  tableSnapshot,
  tempBackupDir,
  testBackupConfig,
  testClock,
  withClient,
  type ScratchDatabase,
  type TempDir,
} from '../../helpers/backup.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const defaults = { timezone: 'Europe/Madrid', currency: 'EUR' };
const opened: Array<TestDatabase | ScratchDatabase> = [];
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

const schemaOf = (url: string) => withClient(url, (client) => databaseSchema(client));
const files = async (prefix: string) =>
  (await readdir(dir.path)).filter((f) => f.startsWith(prefix)).sort();

describe('copia previa a las migraciones', () => {
  it('con datos y pendientes copia antes de migrar y después migra', async () => {
    const old = await oldInstance();
    const config = testBackupConfig({ dir: dir.path, instanceId: 'pre-01' });
    const clock = testClock('2026-09-29T08:00:00.000Z');
    const logger = captureLogger();
    await runMigrations(old.url, defaults, { backup: { config, clock }, logger });

    const created = await files('pre-01__');
    expect(created).toEqual(['pre-01__0003_map_url__20260929T080000Z__premigration.cbak']);
    const { header } = await readHeader(join(dir.path, created[0] ?? ''));
    expect(header.reason).toBe('premigration');
    expect(header.tables.find((t) => t.name === '__drizzle_migrations')?.rows).toBe(4);
    expect(await schemaOf(old.url)).toEqual(installedSchema());
    expect(logger.events('backup_created')[0]).toMatchObject({ reason: 'premigration' });

    // Sin pendientes: ninguna copia más.
    clock.advance(60_000);
    await runMigrations(old.url, defaults, { backup: { config, clock } });
    expect(await files('pre-01__')).toHaveLength(1);
  });

  it('una BD vacía migra sin copia', async () => {
    const empty = await createDatabaseMigratedUpTo(null);
    opened.push(empty);
    const config = testBackupConfig({ dir: dir.path, instanceId: 'vacia-01' });
    await runMigrations(empty.url, defaults, { backup: { config } });
    expect(await files('vacia-01__')).toEqual([]);
    expect(await schemaOf(empty.url)).toEqual(installedSchema());
  });

  it('sin configuración de copias no migra y lo registra', async () => {
    const old = await oldInstance();
    const before = await tableSnapshot(old.url);
    const logger = captureLogger();
    const error = await runMigrations(old.url, defaults, { logger }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MigrationBlockedError);
    expect(error).toMatchObject({ failure: 'backup_not_configured', pending: ['0004_handoff'] });
    expect(await tableSnapshot(old.url)).toEqual(before);
    expect(logger.events('migration_blocked')).toEqual([
      {
        channel: 'backup',
        event: 'migration_blocked',
        pending: ['0004_handoff'],
        failure: 'backup_not_configured',
      },
    ]);
  });

  it('si la copia falla (directorio inexistente) no migra', async () => {
    const old = await oldInstance();
    const before = await tableSnapshot(old.url);
    const config = testBackupConfig({ dir: join(dir.path, 'no-existe') });
    const error = await runMigrations(old.url, defaults, { backup: { config } }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MigrationBlockedError);
    expect((error as MigrationBlockedError).failure).toBe('dir_missing');
    expect((error as Error).message).toBe(
      'No se aplican las migraciones pendientes (0004_handoff): no se pudo hacer la copia previa (dir_missing). El esquema no ha cambiado.',
    );
    expect(await tableSnapshot(old.url)).toEqual(before);
  });

  it('una migración que falla tras la copia da el nombre de la copia previa', async () => {
    const test = await createTestDatabase();
    opened.push(test);
    await seedInstance(test.db);
    const folder = await mkdtemp(join(tmpdir(), 'migrations-'));
    try {
      await cp(defaultMigrationsFolder, folder, { recursive: true });
      await writeFile(join(folder, '0005_rota.sql'), 'SELECT * FROM "tabla_que_no_existe";');
      const journalPath = join(folder, 'meta', '_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: Array<Record<string, unknown>>;
      };
      journal.entries.push({
        idx: 5,
        version: '7',
        when: Number(journal.entries.at(-1)?.when) + 1000,
        tag: '0005_rota',
        breakpoints: true,
      });
      await writeFile(journalPath, JSON.stringify(journal));

      const config = testBackupConfig({ dir: dir.path, instanceId: 'rota-01' });
      const logger = captureLogger();
      const error = await runMigrations(test.url, defaults, {
        backup: { config },
        logger,
        migrationsFolder: folder,
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(MigrationFailedError);
      const [file = ''] = await files('rota-01__');
      expect(file).toMatch(/^rota-01__0004_handoff__\d{8}T\d{6}Z__premigration\.cbak$/);
      expect((error as Error).message).toContain(`Copia previa: ${file}.`);
      expect(logger.events('migration_failed')).toEqual([
        {
          channel: 'backup',
          event: 'migration_failed',
          pending: ['0005_rota'],
          premigrationFile: file,
        },
      ]);
      expect(await schemaOf(test.url)).toEqual(installedSchema());
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('la copia previa se restaura con el núcleo anterior y vuelve a migrar con su copia previa', async () => {
    // FR-017: el núcleo anterior se simula con el código actual limitado a la migración 3.
    const old = await oldInstance();
    const before = await tableSnapshot(old.url);
    const config = testBackupConfig({ dir: dir.path, instanceId: 'vuelta-01' });
    const clock = testClock('2026-09-29T09:00:00.000Z');
    await runMigrations(old.url, defaults, { backup: { config, clock } });
    const [premigration = ''] = await files('vuelta-01__');

    const previousCore = await createDatabaseMigratedUpTo(3);
    opened.push(previousCore);
    const report = await restoreBackup({
      databaseUrl: previousCore.url,
      file: join(dir.path, premigration),
      config,
    });
    expect(report.pendingMigrations).toEqual(['0004_handoff']);
    expect(await tableSnapshot(previousCore.url)).toEqual(before);

    // US2-3: al arrancar con el núcleo actual se hace su copia previa y se migra.
    clock.advance(60 * 60 * 1000);
    await runMigrations(previousCore.url, defaults, { backup: { config, clock } });
    expect(await files('vuelta-01__')).toHaveLength(2);
    expect(await schemaOf(previousCore.url)).toEqual(installedSchema());
  });
});
