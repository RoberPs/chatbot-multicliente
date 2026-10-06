import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Tamaño y plazos de un pool (012, R9; contracts/public-routes-and-login.md § Base de datos). */
export interface PoolLimits {
  max: number;
  connectionTimeoutMillis: number;
  statementTimeoutMs: number;
  idleInTransactionMs: number;
}

/** Panel, procesador, recepción, derivación, retención y copias programadas. */
export const MAIN_POOL: PoolLimits = {
  max: 10,
  connectionTimeoutMillis: 5_000,
  statementTimeoutMs: 15_000,
  idleInTransactionMs: 60_000,
};

/** Lecturas del chat web: una avalancha pública no le quita conexiones al resto. */
export const PUBLIC_POOL: PoolLimits = {
  max: 3,
  connectionTimeoutMillis: 2_000,
  statementTimeoutMs: 5_000,
  idleInTransactionMs: 60_000,
};

/**
 * Crea el acceso a la BD de la instancia. La sesión trabaja en UTC solo para las marcas
 * `updated_at`; horarios y fechas del negocio son hora local sin conversión. Con `limits = null`
 * (migraciones) el pool no tiene plazos por sentencia.
 */
export function createDb(databaseUrl: string, limits: PoolLimits | null = MAIN_POOL): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    options: '-c timezone=UTC',
    ...(limits
      ? {
          max: limits.max,
          connectionTimeoutMillis: limits.connectionTimeoutMillis,
          statement_timeout: limits.statementTimeoutMs,
          idle_in_transaction_session_timeout: limits.idleInTransactionMs,
        }
      : {}),
  });
  return drizzle(pool, { schema });
}

/** Pool de las lecturas públicas del chat web (012, FR-022). */
export const createPublicDb = (databaseUrl: string): Db => createDb(databaseUrl, PUBLIC_POOL);

/**
 * El pool no dio conexión a tiempo (agotado): el chat responde «ocupado» en lugar de un error.
 * Drizzle envuelve el error de `pg` en `cause`.
 */
export function isPoolBusy(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 5; depth++) {
    if (e.message.includes('timeout exceeded when trying to connect')) return true;
    e = e.cause;
  }
  return false;
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
