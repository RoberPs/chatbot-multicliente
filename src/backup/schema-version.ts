/**
 * Versión del esquema (006, research R5): la última migración aplicada, con su índice, etiqueta
 * del journal de Drizzle y hash. Los hashes y las fechas salen de `readMigrationFiles`, así que
 * coinciden con los que escribe el migrador de Drizzle.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type pg from 'pg';

export const defaultMigrationsFolder = fileURLToPath(new URL('../db/migrations', import.meta.url));

export interface SchemaVersion {
  index: number;
  tag: string;
  hash: string;
}

export interface Migration extends SchemaVersion {
  folderMillis: number;
  /** Sentencias troceadas por `--> statement-breakpoint`, como Drizzle. */
  sql: string[];
}

/** Lo que se necesita de una conexión: `pg.Client` o `pg.PoolClient`. */
export type Queryable = Pick<pg.ClientBase, 'query'>;

/** Migraciones del núcleo en orden del journal. */
export function journal(folder = defaultMigrationsFolder): Migration[] {
  const entries = (
    JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    }
  ).entries;
  const files = readMigrationFiles({ migrationsFolder: folder });
  return files.map((file, i) => {
    const entry = entries[i];
    if (!entry) throw new Error('Journal de migraciones incoherente');
    return {
      index: entry.idx,
      tag: entry.tag,
      hash: file.hash,
      folderMillis: file.folderMillis,
      sql: file.sql,
    };
  });
}

/** Última migración del núcleo instalado. */
export function installedSchema(folder = defaultMigrationsFolder): SchemaVersion {
  const last = journal(folder).at(-1);
  if (!last) throw new Error('El núcleo no tiene migraciones');
  return { index: last.index, tag: last.tag, hash: last.hash };
}

async function lastApplied(client: Queryable): Promise<{ hash: string; createdAt: number } | null> {
  const exists = await client.query<{ oid: string | null }>(
    `select to_regclass('drizzle.__drizzle_migrations')::text as oid`,
  );
  if (exists.rows[0]?.oid === null || exists.rows[0]?.oid === undefined) return null;
  const rows = await client.query<{ hash: string; created_at: string | null }>(
    'select hash, created_at::text from drizzle.__drizzle_migrations order by created_at desc limit 1',
  );
  const row = rows.rows[0];
  if (!row) return null;
  return { hash: row.hash, createdAt: Number(row.created_at) };
}

/**
 * Última migración aplicada en la BD, o `empty` si no hay tabla de migraciones o no tiene filas.
 * Se cruza por `created_at` = `folderMillis`, como el migrador de Drizzle.
 */
export async function databaseSchema(
  client: Queryable,
  folder = defaultMigrationsFolder,
): Promise<SchemaVersion | 'empty'> {
  const last = await lastApplied(client);
  if (!last) return 'empty';
  const migration = journal(folder).find((m) => m.folderMillis === last.createdAt);
  if (!migration) throw new Error('La BD tiene una migración que este núcleo no conoce');
  return { index: migration.index, tag: migration.tag, hash: last.hash };
}

/** Migraciones que aplicaría el migrador de Drizzle (misma regla que `PgDialect.migrate`). */
export async function pendingMigrations(
  client: Queryable,
  folder = defaultMigrationsFolder,
): Promise<Migration[]> {
  const last = await lastApplied(client);
  return journal(folder).filter((m) => last === null || last.createdAt < m.folderMillis);
}

/**
 * Reconstruye el esquema hasta la migración `index` (incluida) en la transacción de `client`:
 * ejecuta sus SQL y anota cada una en `drizzle.__drizzle_migrations` con el mismo hash y
 * `created_at` que escribiría el migrador, así el siguiente arranque solo aplica las posteriores.
 */
export async function applyMigrationsUpTo(
  client: Queryable,
  index: number,
  folder = defaultMigrationsFolder,
): Promise<void> {
  await client.query('create schema if not exists "drizzle"');
  await client.query(`
    create table if not exists "drizzle"."__drizzle_migrations" (
      id serial primary key,
      hash text not null,
      created_at bigint
    )`);
  for (const migration of journal(folder).filter((m) => m.index <= index)) {
    for (const statement of migration.sql) await client.query(statement);
    await client.query(
      'insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values ($1, $2)',
      [migration.hash, migration.folderMillis],
    );
  }
}

/** `0004_handoff` */
export const schemaLabel = (schema: Pick<SchemaVersion, 'tag'>): string => schema.tag;
