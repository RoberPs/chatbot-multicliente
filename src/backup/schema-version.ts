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
 *
 * Los valores que una migración añade a un enum (`ALTER TYPE … ADD VALUE`) se integran en su
 * `CREATE TYPE` (ver `foldEnumAdditions`): PostgreSQL no deja usar un valor añadido en una
 * transacción sin confirmar, y la restauración carga los datos en la misma transacción.
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
  const migrations = journal(folder).filter((m) => m.index <= index);
  const statements = foldEnumAdditions(migrations.map((m) => m.sql));
  for (const [i, migration] of migrations.entries()) {
    for (const statement of statements[i] ?? []) await client.query(statement);
    await client.query(
      'insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values ($1, $2)',
      [migration.hash, migration.folderMillis],
    );
  }
}

const TYPE_NAME = String.raw`("[^"]+"\."[^"]+"|"[^"]+")`;
const LABEL = String.raw`'((?:[^']|'')*)'`;
const CREATE_ENUM = new RegExp(
  String.raw`CREATE TYPE\s+${TYPE_NAME}\s+AS ENUM\s*\(([^)]*)\)`,
  'gi',
);
const ADD_VALUE = new RegExp(
  String.raw`^ALTER TYPE\s+${TYPE_NAME}\s+ADD VALUE\s+(IF NOT EXISTS\s+)?${LABEL}(?:\s+(BEFORE|AFTER)\s+${LABEL})?\s*;?$`,
  'i',
);

/** `"t"` → `"public"."t"`, para comparar nombres con y sin esquema. */
const qualifiedType = (name: string): string => (name.includes('.') ? name : `"public".${name}`);
const quoteLabel = (label: string): string => `'${label.replaceAll("'", "''")}'`;

function parseLabels(list: string): string[] {
  return [...list.matchAll(new RegExp(LABEL, 'g'))].map((m) => (m[1] ?? '').replaceAll("''", "'"));
}

/** Sentencia sin líneas de comentario, para reconocerla aunque lleve un comentario delante. */
const withoutComments = (statement: string): string =>
  statement
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .trim();

/**
 * Integra los `ALTER TYPE … ADD VALUE` en el `CREATE TYPE … AS ENUM` del mismo tipo, con el
 * orden que tendría el enum tras aplicar las migraciones una a una (al final, o antes/después
 * del valor indicado), y quita esos `ALTER TYPE`. Recibe y devuelve las sentencias agrupadas por
 * migración. Un `ADD VALUE` de un tipo que no se crea en estas migraciones se deja tal cual.
 */
export function foldEnumAdditions(migrations: string[][]): string[][] {
  const labels = new Map<string, string[]>();
  const folded = new Set<string>();
  // Primera pasada, en orden: tipos creados y valores añadidos después.
  for (const statements of migrations) {
    for (const statement of statements) {
      for (const match of statement.matchAll(CREATE_ENUM)) {
        labels.set(qualifiedType(match[1] ?? ''), parseLabels(match[2] ?? ''));
      }
      const add = ADD_VALUE.exec(withoutComments(statement));
      if (!add) continue;
      const type = qualifiedType(add[1] ?? '');
      const list = labels.get(type);
      if (!list) continue;
      const value = (add[3] ?? '').replaceAll("''", "'");
      folded.add(statement);
      if (list.includes(value)) continue;
      const anchor = (add[5] ?? '').replaceAll("''", "'");
      const at = add[4] ? list.indexOf(anchor) : -1;
      if (at < 0) list.push(value);
      else list.splice(add[4]?.toUpperCase() === 'BEFORE' ? at : at + 1, 0, value);
    }
  }
  // Segunda pasada: cada CREATE TYPE con su lista final y sin los ADD VALUE integrados.
  return migrations.map((statements) =>
    statements
      .filter((statement) => !folded.has(statement))
      .map((statement) =>
        statement.replace(CREATE_ENUM, (whole: string, name: string) => {
          const list = labels.get(qualifiedType(name));
          return list ? `CREATE TYPE ${name} AS ENUM(${list.map(quoteLabel).join(', ')})` : whole;
        }),
      ),
  );
}

/** `0004_handoff` */
export const schemaLabel = (schema: Pick<SchemaVersion, 'tag'>): string => schema.tag;
