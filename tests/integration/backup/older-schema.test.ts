/**
 * Copia de un esquema anterior (US2-3, FR-017): se restaura con su esquema y las migraciones
 * posteriores quedan pendientes para el siguiente arranque.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readHeader } from '../../../src/backup/format.js';
import { databaseSchema, pendingMigrations } from '../../../src/backup/schema-version.js';
import { createBackup, restoreBackup } from '../../../src/backup/service.js';
import {
  PENDING_AFTER_0003,
  CURRENT_SCHEMA,
  createDatabaseMigratedUpTo,
  seedSchema0003,
  tempBackupDir,
  testBackupConfig,
  withClient,
  type ScratchDatabase,
  type TempDir,
} from '../../helpers/backup.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

let old: ScratchDatabase;
let current: TestDatabase;
let dir: TempDir;

beforeAll(async () => {
  old = await createDatabaseMigratedUpTo(3);
  await seedSchema0003(old.url);
  current = await createTestDatabase();
  dir = await tempBackupDir();
});
afterAll(async () => {
  await old.close();
  await current.close();
  await dir.remove();
});

describe('copia de un esquema anterior', () => {
  it('se restaura con su esquema y deja la 0004 y la 0005 pendientes', async () => {
    const config = testBackupConfig({ dir: dir.path });
    const backup = await createBackup({ databaseUrl: old.url, config, reason: 'manual' });
    expect(backup.file).toContain('__0003_map_url__');
    expect((await readHeader(join(dir.path, backup.file))).header.schema.tag).toBe('0003_map_url');

    const report = await restoreBackup({
      databaseUrl: current.url,
      file: join(dir.path, backup.file),
      config,
    });
    expect(report).toMatchObject({
      schema: '0003_map_url',
      installedSchema: CURRENT_SCHEMA,
      pendingMigrations: PENDING_AFTER_0003,
      expiredConversations: 0,
    });

    await withClient(current.url, async (client) => {
      expect(await databaseSchema(client)).toMatchObject({ tag: '0003_map_url' });
      expect((await pendingMigrations(client)).map((m) => m.tag)).toEqual(PENDING_AFTER_0003);
      for (const table of ['handoff', 'handoff_notice', 'handoff_alerts']) {
        const r = await client.query<{ t: string | null }>(`select to_regclass($1)::text as t`, [
          `public.${table}`,
        ]);
        expect(r.rows[0]?.t).toBeNull();
      }
      const types = await client.query<{ n: string }>(
        `select count(*)::text as n from pg_type
          where typname in ('handoff_kind', 'handoff_status', 'handoff_route')
            and typnamespace = 'public'::regnamespace`,
      );
      expect(types.rows[0]?.n).toBe('0');
      const name = await client.query<{ name: string }>('select name from business');
      expect(name.rows[0]?.name).toBe('Negocio de la versión anterior');
    });
  });
});
