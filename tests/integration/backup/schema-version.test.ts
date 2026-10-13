import { readdirSync } from 'node:fs';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, describe, expect, it } from 'vitest';
import {
  databaseSchema,
  defaultMigrationsFolder,
  installedSchema,
  pendingMigrations,
} from '../../../src/backup/schema-version.js';
import {
  createDatabaseMigratedUpTo,
  withClient,
  type ScratchDatabase,
} from '../../helpers/backup.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const opened: Array<ScratchDatabase | TestDatabase> = [];
afterAll(async () => {
  for (const d of opened) await d.close();
});

describe('versión del esquema', () => {
  it('el núcleo instalado llega a 0009_unmeasured_usage con el hash que calcula Drizzle', () => {
    const files = readMigrationFiles({ migrationsFolder: defaultMigrationsFolder });
    const installed = installedSchema();
    expect(installed.tag).toBe('0009_unmeasured_usage');
    expect(installed.index).toBe(9);
    expect(installed.hash).toBe(files.at(-1)?.hash);
    expect(readdirSync(defaultMigrationsFolder).filter((f) => f.endsWith('.sql'))).toHaveLength(10);
  });

  it('BD recién creada vacía → empty y todas pendientes', async () => {
    const scratch = await createDatabaseMigratedUpTo(null);
    opened.push(scratch);
    await withClient(scratch.url, async (client) => {
      expect(await databaseSchema(client)).toBe('empty');
      expect((await pendingMigrations(client)).map((m) => m.tag)).toEqual([
        '0000_initial',
        '0001_conversations',
        '0002_channels',
        '0003_map_url',
        '0004_handoff',
        '0005_config_transfer',
        '0006_usage',
        '0007_chat_design',
        '0008_abuse_protection',
        '0009_unmeasured_usage',
      ]);
    });
  });

  it('BD de la plantilla → última migración y ninguna pendiente', async () => {
    const test = await createTestDatabase();
    opened.push(test);
    await withClient(test.url, async (client) => {
      expect(await databaseSchema(client)).toEqual(installedSchema());
      expect(await pendingMigrations(client)).toEqual([]);
    });
  });

  it('applyMigrationsUpTo(3) deja 0003 y el migrador de Drizzle aplica después de la 0004 a la 0009', async () => {
    const scratch = await createDatabaseMigratedUpTo(3);
    opened.push(scratch);
    await withClient(scratch.url, async (client) => {
      expect(await databaseSchema(client)).toMatchObject({ index: 3, tag: '0003_map_url' });
      expect((await pendingMigrations(client)).map((m) => m.tag)).toEqual([
        '0004_handoff',
        '0005_config_transfer',
        '0006_usage',
        '0007_chat_design',
        '0008_abuse_protection',
        '0009_unmeasured_usage',
      ]);
      const handoff = await client.query<{ t: string | null }>(
        `select to_regclass('public.handoff')::text as t`,
      );
      expect(handoff.rows[0]?.t).toBeNull();
    });
    await migrate(scratch.db, { migrationsFolder: defaultMigrationsFolder });
    await withClient(scratch.url, async (client) => {
      expect(await databaseSchema(client)).toEqual(installedSchema());
      const count = await client.query<{ n: string }>(
        'select count(*)::text as n from drizzle.__drizzle_migrations',
      );
      expect(count.rows[0]?.n).toBe('10');
    });
  });
});
