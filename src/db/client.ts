import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Crea el acceso a la BD de la instancia. La sesión trabaja en UTC solo para las marcas
 * `updated_at`; horarios y fechas del negocio son hora local sin conversión.
 */
export function createDb(databaseUrl: string): Db {
  const pool = new pg.Pool({ connectionString: databaseUrl, options: '-c timezone=UTC' });
  return drizzle(pool, { schema });
}

export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}

export function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}

/** Serializa las escrituras bloqueando la fila única del negocio (research R6). */
export async function lockBusiness(tx: Tx): Promise<void> {
  await tx.execute(sql`select id from business where id = 1 for update`);
}

/** Lectura coherente: una sola transacción REPEATABLE READ de solo lectura. */
export function withReadSnapshot<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
