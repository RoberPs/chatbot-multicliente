/**
 * Base de datos de una instancia (007, US3, research R8): nombres, contraseña aleatoria enviada
 * como verificador SCRAM-SHA-256 (la contraseña en claro no viaja al servidor), plan SQL y
 * creación paso a paso. Nunca se borra una base de datos: el único deshacer es retirar el usuario
 * recién creado si falla la creación de la base de datos (FR-019, FR-023). Los errores de `pg` se
 * traducen a códigos propios: su texto podría llevar la URL de administración (FR-020).
 *
 * 013 (research R3): la URL de administración se clasifica con la misma regla que
 * `instance:check`; la `DATABASE_URL` generada lleva `sslmode=verify-full` por defecto con un
 * servidor remoto y, si se pide, el `sslrootcert` del contenedor.
 */
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import pg from 'pg';
import { classifyDatabaseUrl, isLocalHost } from '../config/database-url.js';
import type { DatabaseIdentity } from './fingerprint.js';
import { cryptoRandom, secretQuality, type RandomSource } from './secrets.js';

export interface DatabaseNames {
  database: string;
  user: string;
}

/** `chatbot_<id>` con los guiones cambiados por `_` (≤ 48 caracteres). */
export function databaseNames(instanceId: string): DatabaseNames {
  const name = `chatbot_${instanceId.replaceAll('-', '_')}`;
  return { database: name, user: name };
}

/** Contraseña del usuario: 24 bytes en base64url (32 caracteres, nada que codificar en la URL). */
export function generateDbPassword(random: RandomSource = cryptoRandom): string {
  for (let i = 0; i < 20; i++) {
    const value = random.bytes(24).toString('base64url');
    if (secretQuality('DATABASE_URL', value).length === 0) return value;
  }
  throw new Error('No se ha podido generar una contraseña válida');
}

const hmac = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest();

/**
 * Verificador SCRAM-SHA-256 en el formato que PostgreSQL guarda tal cual:
 * `SCRAM-SHA-256$<iteraciones>:<sal>$<StoredKey>:<ServerKey>` (RFC 5802/7677).
 */
export function scramVerifier(password: string, salt: Buffer, iterations = 4096): string {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  const serverKey = hmac(salted, 'Server Key');
  return `SCRAM-SHA-256$${String(iterations)}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

// ---------------------------------------------------------------------------
// Plan SQL
// ---------------------------------------------------------------------------

export interface SqlPlan {
  names: DatabaseNames;
  checkRole: string;
  checkDatabase: string;
  createRole: string;
  createDatabase: string;
  revoke: string;
  dropRole: string;
}

/** Sentencias de los pasos 1–4, con el verificador (nunca la contraseña). */
export function planSql(names: DatabaseNames, verifier: string): SqlPlan {
  const db = pg.escapeIdentifier(names.database);
  const user = pg.escapeIdentifier(names.user);
  return {
    names,
    checkRole: `SELECT 1 FROM pg_roles    WHERE rolname = ${pg.escapeLiteral(names.user)};`,
    checkDatabase: `SELECT 1 FROM pg_database WHERE datname = ${pg.escapeLiteral(names.database)};`,
    createRole: `CREATE ROLE ${user} LOGIN PASSWORD ${pg.escapeLiteral(verifier)};`,
    createDatabase: `CREATE DATABASE ${db} OWNER ${user};`,
    revoke: `REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC;`,
    dropRole: `DROP ROLE ${user};`,
  };
}

/** Texto de `--print-sql`. */
export function printableSql(plan: SqlPlan): string[] {
  return [
    '-- Ejecuta con un usuario que pueda crear bases de datos y usuarios (psql o consola del proveedor).',
    '-- Si alguna de estas dos consultas devuelve filas, NO sigas: ya existen.',
    plan.checkRole,
    plan.checkDatabase,
    plan.createRole,
    plan.createDatabase,
    plan.revoke,
  ];
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

export interface AdminTarget {
  host: string;
  port: number;
  sslmode: string | null;
  /** Ruta del equipo del operador: sirve para la conexión de prueba, nunca para el entorno. */
  sslrootcert: string | null;
  /** Clasificación común (`classifyDatabaseUrl`). */
  local: boolean;
  verifiedTls: boolean;
  /** Host IP con `verify-full`: no se comprueba el nombre del certificado. */
  ipHost: boolean;
}

/** Servidor, puerto, TLS y clasificación de la URL de administración, o `null` si no es válida. */
export function parseAdminUrl(adminUrl: string): AdminTarget | null {
  const c = classifyDatabaseUrl(adminUrl);
  if (c.kind !== 'ok') return null;
  let url: URL;
  try {
    url = new URL(adminUrl.trim());
  } catch {
    return null;
  }
  // Un socket no sirve: la conexión de prueba y la DATABASE_URL necesitan un servidor.
  if (url.hostname === '') return null;
  return {
    host: url.hostname.toLowerCase(),
    port: url.port === '' ? 5432 : Number(url.port),
    sslmode: url.searchParams.get('sslmode'),
    sslrootcert: c.caFile,
    local: c.local,
    verifiedTls: c.verifiedTls,
    ipHost: c.ipHost && c.verifyFull,
  };
}

/** `host:puerto` de la URL de administración: lo único que se muestra de ella. */
export function describeAdminUrl(adminUrl: string): string {
  const target = parseAdminUrl(adminUrl);
  return target ? `${target.host}:${String(target.port)}` : '?';
}

export function buildDatabaseUrl(input: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslmode?: string | null;
  /** Ruta del certificado de la autoridad dentro del contenedor (`--sslrootcert`). */
  sslrootcert?: string | null;
  /** Sin `sslmode` y con un servidor remoto, `sslmode=verify-full` (013). */
  defaultVerifyFull?: boolean;
}): string {
  const url = new URL('postgres://placeholder');
  url.hostname = input.host;
  url.port = String(input.port);
  url.username = encodeURIComponent(input.user);
  url.password = encodeURIComponent(input.password);
  url.pathname = `/${encodeURIComponent(input.database)}`;
  const sslmode =
    input.sslmode ??
    (input.defaultVerifyFull === true && !isLocalHost(input.host) ? 'verify-full' : null);
  if (sslmode) url.searchParams.set('sslmode', sslmode);
  if (input.sslrootcert) url.searchParams.set('sslrootcert', input.sslrootcert);
  // `new URL` omite el puerto por defecto de esquemas conocidos; postgres no lo es.
  return url.toString();
}

// ---------------------------------------------------------------------------
// Creación
// ---------------------------------------------------------------------------

export type DbStep = 'role' | 'database' | 'revoke' | 'probe';
export type DbFailureCode =
  | 'db_exists'
  | 'role_exists'
  | 'admin_connect_failed'
  | 'permission_denied'
  | 'step_failed'
  | 'probe_failed';

export interface DbFailure {
  code: DbFailureCode;
  step: DbStep | 'check' | 'connect';
}

export interface CreateDatabaseResult {
  database: DatabaseIdentity;
  steps: DbStep[];
  rolledBack: 'role'[];
  failure: DbFailure | null;
}

/** Lo mínimo de un cliente `pg` que se usa (sustituible en las pruebas). */
export interface PgLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export type PgConnect = (connectionString: string) => Promise<PgLike>;

export const connectPg: PgConnect = async (connectionString) => {
  const client = new pg.Client({ connectionString });
  client.on('error', () => undefined);
  await client.connect();
  return client;
};

export interface CreateDatabaseDeps {
  connect?: PgConnect;
  /** Pruebas: falla justo antes de ejecutar ese paso. */
  failAt?: DbStep;
}

/** Código propio para un error de `pg` (sin su texto). */
export function translatePgError(error: unknown, step: DbFailure['step']): DbFailure {
  const code = (error as { code?: unknown } | null)?.code;
  if (step === 'connect') return { code: 'admin_connect_failed', step };
  if (code === '42501') return { code: 'permission_denied', step };
  if (step === 'probe') return { code: 'probe_failed', step };
  return { code: 'step_failed', step };
}

class InjectedFailure extends Error {}

/**
 * URL del usuario nuevo con el servidor de administración (para la prueba de conexión). Se
 * ejecuta en el equipo del operador: conserva `sslmode` y `sslrootcert` de la URL de
 * administración (R3).
 */
export function probeUrl(adminUrl: string, names: DatabaseNames, password: string): string {
  const target = parseAdminUrl(adminUrl);
  return buildDatabaseUrl({
    host: target?.host ?? 'localhost',
    port: target?.port ?? 5432,
    database: names.database,
    user: names.user,
    password,
    sslmode: target?.sslmode ?? null,
    sslrootcert: target?.sslrootcert ?? null,
  });
}

/**
 * Crea usuario y base de datos: comprobación previa, `CREATE ROLE` con el verificador,
 * `CREATE DATABASE … OWNER` (fuera de transacción), `REVOKE CONNECT, TEMPORARY … FROM PUBLIC` y
 * `select 1` como el usuario nuevo. Cierra siempre las conexiones.
 */
export async function createDatabase(
  adminUrl: string,
  plan: SqlPlan,
  password: string,
  identity: DatabaseIdentity,
  deps: CreateDatabaseDeps = {},
): Promise<CreateDatabaseResult> {
  const connect = deps.connect ?? connectPg;
  const result: CreateDatabaseResult = {
    database: identity,
    steps: [],
    rolledBack: [],
    failure: null,
  };
  const run = async (client: PgLike, step: DbStep, sql: string) => {
    if (deps.failAt === step) throw new InjectedFailure(step);
    await client.query(sql);
  };

  let admin: PgLike;
  try {
    admin = await connect(adminUrl);
  } catch (error) {
    return { ...result, failure: translatePgError(error, 'connect') };
  }
  try {
    try {
      const role = await admin.query('select 1 from pg_roles where rolname = $1', [
        plan.names.user,
      ]);
      if (role.rows.length > 0)
        return { ...result, failure: { code: 'role_exists', step: 'check' } };
      const db = await admin.query('select 1 from pg_database where datname = $1', [
        plan.names.database,
      ]);
      if (db.rows.length > 0) return { ...result, failure: { code: 'db_exists', step: 'check' } };
    } catch (error) {
      return { ...result, failure: translatePgError(error, 'check') };
    }

    try {
      await run(admin, 'role', plan.createRole);
      result.steps.push('role');
    } catch (error) {
      return { ...result, failure: translatePgError(error, 'role') };
    }

    try {
      await run(admin, 'database', plan.createDatabase);
      result.steps.push('database');
    } catch (error) {
      // No hay base de datos que use el usuario: se retira (el único deshacer permitido).
      try {
        await admin.query(plan.dropRole);
        result.rolledBack.push('role');
      } catch {
        // Queda el usuario: el informe lo dice.
      }
      return { ...result, failure: translatePgError(error, 'database') };
    }

    try {
      await run(admin, 'revoke', plan.revoke);
      result.steps.push('revoke');
    } catch (error) {
      return { ...result, failure: translatePgError(error, 'revoke') };
    }
  } finally {
    await admin.end().catch(() => undefined);
  }

  let probe: PgLike | null = null;
  try {
    if (deps.failAt === 'probe') throw new InjectedFailure('probe');
    probe = await connect(probeUrl(adminUrl, plan.names, password));
    await probe.query('select 1');
    result.steps.push('probe');
  } catch (error) {
    return { ...result, failure: translatePgError(error, 'probe') };
  } finally {
    await probe?.end().catch(() => undefined);
  }
  return result;
}
