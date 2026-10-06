/**
 * Una restauración que falla a mitad deja la BD exactamente como estaba (US2-7, FR-011, SC-008).
 */
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RestoreFailure } from '../../../src/backup/errors.js';
import { databaseSchema } from '../../../src/backup/schema-version.js';
import { createBackup, restoreBackup, type BackupReport } from '../../../src/backup/service.js';
import { business } from '../../../src/db/schema.js';
import {
  seedInstance,
  tableSnapshot,
  tempBackupDir,
  testBackupConfig,
  withClient,
  type TempDir,
} from '../../helpers/backup.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

let test: TestDatabase;
let dir: TempDir;
let backup: BackupReport;
let config: ReturnType<typeof testBackupConfig>;

beforeAll(async () => {
  test = await createTestDatabase();
  dir = await tempBackupDir();
  await seedInstance(test.db);
  config = testBackupConfig({ dir: dir.path });
  backup = await createBackup({ databaseUrl: test.url, config, reason: 'manual' });
  // Estado posterior a la copia: una restauración correcta lo cambiaría.
  await test.db.update(business).set({ name: 'Cambiado tras la copia' }).where(eq(business.id, 1));
});
afterAll(async () => {
  await test.close();
  await dir.remove();
});

async function expectUnchanged(run: () => Promise<unknown>, code: string): Promise<void> {
  const before = await tableSnapshot(test.url);
  const schemaBefore = await withClient(test.url, (c) => databaseSchema(c));
  const error = await run().then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RestoreFailure);
  expect((error as RestoreFailure).code).toBe(code);
  expect(await tableSnapshot(test.url)).toEqual(before);
  expect(await withClient(test.url, (c) => databaseSchema(c))).toEqual(schemaBefore);
  // La conexión de la aplicación sigue utilizable.
  const [row] = await test.db.select({ name: business.name }).from(business);
  expect(row?.name).toBe('Cambiado tras la copia');
}

describe('restauración total o nula', () => {
  it('un fallo tras cargar la N-ésima tabla deshace todo', async () => {
    await expectUnchanged(
      () =>
        restoreBackup({
          databaseUrl: test.url,
          file: join(dir.path, backup.file),
          config,
          internal: {
            afterTable: (loaded) => {
              if (loaded === 5) throw new Error('fallo inyectado');
              return Promise.resolve();
            },
          },
        }),
      'db_error',
    );
  });

  it('un recuento distinto de la cabecera (count_mismatch) deshace todo', async () => {
    await expectUnchanged(
      () =>
        restoreBackup({
          databaseUrl: test.url,
          file: join(dir.path, backup.file),
          config,
          internal: {
            afterTable: async (_loaded, table, client) => {
              if (table.name === 'faq') await client.query('delete from faq');
            },
          },
        }),
      'count_mismatch',
    );
  });
});
