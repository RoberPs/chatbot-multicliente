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

/**
 * Códigos de «la base de datos no está dando servicio» (016, research R2; data-model §2).
 *
 * Solo por código, nunca por texto: los textos de `pg` y de Node cambian entre versiones y
 * pueden llevar la dirección de la base de datos. Las dos únicas comparaciones de texto del
 * núcleo (`isPoolBusy` aquí y `PG_NO_SSL` en `src/config/database-url.ts`) se mantienen, pero no
 * se añade ninguna.
 */
const UNAVAILABLE_CODES = new Set([
  // Red de Node: el servidor no está, la conexión se cayó o el nombre no resuelve.
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  // El socket Unix no existe: la forma de producción cuando PostgreSQL está parado.
  'ENOENT',
  // SQLSTATE clase 08 (fallos de conexión) y apagado del servidor.
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '57P01',
  '57P02',
  '57P03',
]);

/**
 * «La base de datos no contesta», mirando el error y sus `cause` hasta 5 niveles, como
 * `isPoolBusy`, porque Drizzle envuelve los errores de `pg`.
 *
 * No distingue causas: para esta corrección basta saber que no hay servicio. Quien lo use decide
 * qué hacer —no morir, avisar al vigilante, responder con contacto—, y nunca muestra el error.
 */
export function isDbUnavailable(error: unknown): boolean {
  if (isPoolBusy(error)) return true;
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && UNAVAILABLE_CODES.has(code)) return true;
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
