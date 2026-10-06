/**
 * Operaciones de copia (006): copiar, restaurar, comprobar y listar. Módulo de operación sin
 * HTTP: habla con PostgreSQL por `pg` y con el disco por `node:fs`.
 */
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, constants, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, type Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { describeDatabaseError } from '../config/database-url.js';
import type { LoggerLike } from '../conversation/activity-log.js';
import { systemClock, type Clock } from '../conversation/ports.js';
import { conversationSettings } from '../conversation/settings.js';
import { coreVersion, findReadKey, parseKey, type BackupConfig } from './config.js';
import {
  countRows,
  drainDump,
  DumpReadError,
  DUMP_SCHEMAS,
  DUMP_SESSION_OPTIONS,
  listTables,
  openDump,
  qualified,
  quoteIdent,
  readDump,
  type DumpHooks,
  type DumpTable,
} from './dump.js';
import {
  BackupError,
  backupFailureCode,
  RestoreFailure,
  type DbTlsFailureCode,
  type RestoreFailureCode,
} from './errors.js';
import { createBackupWriter, openBackup, readHeader, type BackupHeader } from './format.js';
import { BACKUP_IN_PROGRESS, INSTANCE_RUNNING, tryAdvisoryLock } from './locks.js';
import { createBackupLog, silentLogger, type TableCount } from './log.js';
import { backupFileName, isOwnPartial, partialName, type BackupReason } from './naming.js';
import { applyRetention, expiresAt, scanBackups } from './retention.js';
import {
  applyMigrationsUpTo,
  installedSchema,
  journal,
  pendingMigrations,
} from './schema-version.js';
import { selectOrphans, verifyDatabaseName } from './verify-names.js';

const HOUR = 60 * 60 * 1000;

export interface RetentionSummary {
  deleted: number;
  kept: number;
}

export interface BackupReport {
  /** Nombre del fichero, sin ruta. */
  file: string;
  sizeBytes: number;
  /** `0004_handoff` */
  schema: string;
  coreVersion: string;
  reason: BackupReason;
  /** ISO UTC del instante de la copia. */
  createdAt: string;
  tables: TableCount[];
  durationMs: number;
  retention: RetentionSummary;
}

/** Ganchos internos para las pruebas (escrituras concurrentes, destino lento o que falla). */
export interface BackupInternals extends DumpHooks {
  /** Se intercala entre el cifrado y el fichero. */
  throughput?: () => Transform;
}

export interface CreateBackupOptions {
  databaseUrl: string;
  config: BackupConfig;
  reason: BackupReason;
  clock?: Clock;
  logger?: LoggerLike;
  internal?: BackupInternals;
}

/** Abre una conexión propia con los parámetros fijos del volcado. */
export async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: url,
    options: DUMP_SESSION_OPTIONS,
    application_name: 'chatbot-backup',
  });
  // Un error de conexión llega también por la consulta en curso; aquí no debe tumbar el proceso.
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

/**
 * Fallo al conectar, clasificado por su código y nunca por su texto (013,
 * contracts/database-tls.md): los de TLS tienen código propio; el resto es `fallback`.
 */
function connectFailure<T extends string>(error: unknown, fallback: T): T | DbTlsFailureCode {
  // La variable no importa aquí: solo se usa el motivo.
  switch (describeDatabaseError(error, 'DATABASE_URL').reason) {
    case 'ca_unreadable':
      return 'db_ca_unreadable';
    case 'tls_untrusted':
      return 'db_tls_untrusted';
    case 'tls_unsupported':
      return 'db_tls_unsupported';
    default:
      return fallback;
  }
}

async function checkDirectory(dir: string): Promise<void> {
  let info;
  try {
    info = await stat(dir);
  } catch (error) {
    throw new BackupError(backupFailureCode(error, 'dir_missing'));
  }
  if (!info.isDirectory()) throw new BackupError('dir_missing');
  try {
    await access(dir, constants.W_OK);
  } catch {
    throw new BackupError('dir_not_writable');
  }
}

/** Borra los `.partial` propios de más de una hora (copias interrumpidas, R8). */
async function removeStalePartials(dir: string, instanceId: string): Promise<void> {
  const limit = Date.now() - HOUR;
  for (const name of await readdir(dir)) {
    if (!isOwnPartial(name, instanceId)) continue;
    const path = join(dir, name);
    try {
      if ((await stat(path)).mtimeMs < limit) await unlink(path);
    } catch {
      // Otro proceso lo ha borrado o no se puede: se intentará en la siguiente copia.
    }
  }
}

async function fsyncPath(path: string, flags: string): Promise<void> {
  const handle = await open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** `fsync` del directorio tras el `rename`; Windows no permite abrir directorios. */
async function fsyncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  await fsyncPath(dir, 'r');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hace una copia coherente de un único instante en `BACKUP_DIR` (US1, FR-001 – FR-007). Nunca
 * deja un fichero con nombre de copia a medias: escribe `.<nombre>.partial`, `fsync` y
 * `rename`. Lanza `BackupError` con un código cerrado.
 */
export async function createBackup(options: CreateBackupOptions): Promise<BackupReport> {
  const { databaseUrl, config, reason } = options;
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? silentLogger;
  const log = createBackupLog(logger);
  const started = Date.now();
  let lock: Awaited<ReturnType<typeof tryAdvisoryLock>> = null;
  let partial: string | null = null;
  let client: pg.Client | null = null;
  try {
    const key = parseKey(config.key);
    try {
      lock = await tryAdvisoryLock(databaseUrl, BACKUP_IN_PROGRESS);
    } catch (error) {
      throw new BackupError(connectFailure(error, 'db_error'));
    }
    if (!lock) throw new BackupError('busy');
    await checkDirectory(config.dir);
    await removeStalePartials(config.dir, config.instanceId);

    try {
      client = await connect(databaseUrl);
    } catch (error) {
      throw new BackupError(connectFailure(error, 'db_error'));
    }
    let dump;
    try {
      dump = await openDump(client, options.internal);
    } catch {
      throw new BackupError('db_error');
    }
    const createdAt = clock.now();
    const { stream: writer } = createBackupWriter(
      {
        instanceId: config.instanceId,
        schema: dump.schema,
        coreVersion: coreVersion(),
        createdAt: createdAt.toISOString(),
        reason,
        tables: dump.tables.map((t) => ({ schema: t.schema, name: t.name, rows: t.rows })),
      },
      key,
    );
    const name = backupFileName({
      instanceId: config.instanceId,
      schema: dump.schema,
      createdAt,
      reason,
    });
    const target = join(config.dir, name);
    if (await exists(target)) {
      dump.stream.destroy();
      throw new BackupError('io_error');
    }
    partial = join(config.dir, partialName(name));

    const file = createWriteStream(partial, { flags: 'wx', mode: 0o600 });
    const through = options.internal?.throughput?.();
    try {
      if (through) await pipeline(dump.stream, writer, through, file);
      else await pipeline(dump.stream, writer, file);
    } catch (error) {
      throw new BackupError(
        error instanceof DumpReadError ? 'db_error' : backupFailureCode(error, 'io_error'),
      );
    }
    await fsyncPath(partial, 'r+');
    await rename(partial, target);
    partial = null;
    await fsyncDirectory(config.dir).catch(() => undefined);

    const sizeBytes = (await stat(target)).size;
    const tables = dump.tables.map((t) => ({ name: t.name, rows: t.rows }));
    const report: BackupReport = {
      file: name,
      sizeBytes,
      schema: dump.schema.tag,
      coreVersion: coreVersion(),
      reason,
      createdAt: createdAt.toISOString(),
      tables,
      durationMs: Date.now() - started,
      retention: { deleted: 0, kept: 0 },
    };
    log.log({
      event: 'backup_created',
      file: name,
      reason,
      sizeBytes,
      schema: report.schema,
      durationMs: report.durationMs,
      tables,
    });
    // La retención no invalida una copia ya hecha: su fallo solo se registra (US4, R8).
    try {
      const { deleted, kept } = await applyRetention({ config, clock, logger });
      report.retention = { deleted, kept };
    } catch {
      // Directorio ilegible o similar: se aplicará en la siguiente copia o pasada diaria.
    }
    return report;
  } catch (error) {
    const code = backupFailureCode(error, 'io_error');
    log.log({ event: 'backup_failed', reason, failure: code });
    throw error instanceof BackupError ? error : new BackupError(code);
  } finally {
    if (partial) await unlink(partial).catch(() => undefined);
    if (client) await client.end().catch(() => undefined);
    if (lock) await lock.release();
  }
}

export interface BackupListing {
  file: string;
  sizeBytes: number;
  createdAt: string;
  reason: BackupReason;
  schema: string;
  valid: boolean;
  /** Fecha en que caduca según la retención configurada. */
  expiresAt: string;
}

/** Copias propias de `BACKUP_DIR`, de la más reciente a la más antigua (US4, FR-020). */
export async function listBackups(options: { config: BackupConfig }): Promise<BackupListing[]> {
  const { config } = options;
  return (await scanBackups(config))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map((b) => ({
      file: b.name,
      sizeBytes: b.sizeBytes,
      createdAt: b.header.createdAt,
      reason: b.header.reason,
      schema: b.header.schema.tag,
      valid: b.valid,
      expiresAt: expiresAt(b.createdAt, config.retentionDays).toISOString(),
    }));
}

// ---------------------------------------------------------------------------
// Restauración (US2, research R6)
// ---------------------------------------------------------------------------

export interface RestoreReport {
  file: string;
  sourceInstance: string;
  crossInstance: boolean;
  /** Esquema de la copia, `0003_map_url`. */
  schema: string;
  installedSchema: string;
  coreVersion: string;
  createdAt: string;
  tables: TableCount[];
  /** Conversaciones restauradas que ya superan los 30 días: se borran al arrancar (R11). */
  expiredConversations: number;
  /** Migraciones que aplicará el siguiente arranque (con su copia previa). */
  pendingMigrations: string[];
  durationMs: number;
}

export interface RestoreOptions {
  config: BackupConfig;
  /** Instancia de origen declarada por el operador (`--from-instance`, FR-010). */
  fromInstance?: string;
  /** Comprobación: acepta cualquier instancia (el informe la muestra). */
  acceptAnyInstance?: boolean;
  clock?: Clock;
}

/** Ganchos internos para las pruebas de atomicidad. */
export interface RestoreInternals {
  /** Tras cargar cada tabla, dentro de la transacción (puede lanzar o alterar filas). */
  afterTable?: (loaded: number, table: DumpTable, client: pg.ClientBase) => Promise<void>;
}

export interface PrecheckedBackup {
  path: string;
  file: string;
  header: BackupHeader;
  key: Buffer;
}

function checkKeys(config: BackupConfig): void {
  const current = config.key?.trim() ?? '';
  if (current === '' && config.previousKeys.length === 0) throw new RestoreFailure('key_missing');
  if (current !== '') {
    try {
      parseKey(current);
    } catch {
      throw new RestoreFailure('key_invalid');
    }
  }
}

/**
 * Primera pasada, sin tocar la BD (R6): cabecera, clave, instancia, esquema y lectura completa
 * de todos los bloques y del volcado. Cualquier problema termina aquí con un código cerrado.
 */
export async function precheckBackup(
  path: string,
  options: RestoreOptions,
): Promise<PrecheckedBackup> {
  const file = basename(path);
  let header: BackupHeader;
  try {
    ({ header } = await readHeader(path));
  } catch (error) {
    if (error instanceof RestoreFailure) throw error;
    throw new RestoreFailure('not_a_backup');
  }
  checkKeys(options.config);
  const key = findReadKey(options.config, header.keyId);
  if (!key) throw new RestoreFailure('wrong_key', { keyId: header.keyId });

  const own = header.instanceId === options.config.instanceId;
  const declared = options.fromInstance === header.instanceId;
  if (options.fromInstance !== undefined && !declared) {
    throw new RestoreFailure('other_instance', { sourceInstance: header.instanceId });
  }
  if (!own && !declared && options.acceptAnyInstance !== true) {
    throw new RestoreFailure('other_instance', { sourceInstance: header.instanceId });
  }

  const installed = installedSchema();
  if (header.schema.index > installed.index) {
    throw new RestoreFailure('schema_newer', {
      schema: header.schema.tag,
      coreVersion: header.coreVersion,
      installedSchema: installed.tag,
    });
  }
  const migration = journal().find((m) => m.index === header.schema.index);
  if (migration?.tag !== header.schema.tag || migration.hash !== header.schema.hash) {
    throw new RestoreFailure('schema_mismatch', { schema: header.schema.tag });
  }

  try {
    const { stream } = await openBackup(path, [key]);
    await drainDump(stream, header);
  } catch (error) {
    if (error instanceof RestoreFailure) throw error;
    throw new RestoreFailure('corrupted');
  }
  return { path, file, header, key };
}

const notExtension = (oid: string): string =>
  `not exists (select 1 from pg_depend d where d.objid = ${oid} and d.deptype = 'e')`;

const RELATION_ORDER: Array<[string, string]> = [
  ['v', 'view'],
  ['m', 'materialized view'],
  ['f', 'foreign table'],
  ['r', 'table'],
  ['p', 'table'],
  ['S', 'sequence'],
];

/**
 * Vacía `public` y `drizzle` sin borrar los esquemas (no se depende de su propietario): vistas,
 * tablas, secuencias, rutinas y tipos que no sean de una extensión.
 */
async function wipeSchemas(client: pg.ClientBase): Promise<void> {
  const relations = await client.query<{ kind: string; name: string }>(
    `select c.relkind::text as kind, format('%I.%I', n.nspname, c.relname) as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1::text[]) and c.relkind in ('v', 'm', 'r', 'p', 'f', 'S')
        and ${notExtension('c.oid')}`,
    [DUMP_SCHEMAS],
  );
  for (const [kind, verb] of RELATION_ORDER) {
    for (const r of relations.rows.filter((x) => x.kind === kind)) {
      await client.query(`drop ${verb} if exists ${r.name} cascade`);
    }
  }
  const routines = await client.query<{ name: string }>(
    `select p.oid::regprocedure::text as name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any($1::text[]) and ${notExtension('p.oid')}`,
    [DUMP_SCHEMAS],
  );
  for (const r of routines.rows) await client.query(`drop routine if exists ${r.name} cascade`);
  const types = await client.query<{ kind: string; name: string }>(
    `select t.typtype::text as kind, format('%I.%I', n.nspname, t.typname) as name
       from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = any($1::text[]) and t.typtype in ('e', 'd', 'r', 'c')
        and (t.typtype <> 'c' or exists (
          select 1 from pg_class c where c.oid = t.typrelid and c.relkind = 'c'))
        and ${notExtension('t.oid')}`,
    [DUMP_SCHEMAS],
  );
  for (const t of types.rows) {
    await client.query(`drop ${t.kind === 'd' ? 'domain' : 'type'} if exists ${t.name} cascade`);
  }
}

interface ForeignKey {
  table: string;
  name: string;
  definition: string;
}

async function foreignKeys(client: pg.ClientBase): Promise<ForeignKey[]> {
  const result = await client.query<ForeignKey>(
    `select format('%I.%I', n.nspname, c.relname) as table, k.conname::text as name,
            pg_get_constraintdef(k.oid) as definition
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
       join pg_namespace n on n.oid = c.relnamespace
      where k.contype = 'f' and n.nspname = any($1::text[])
      order by 1, 2`,
    [DUMP_SCHEMAS],
  );
  return result.rows;
}

/** Conversaciones sin mensajes en los últimos 30 días (0 si el esquema no las tiene). */
async function countExpiredConversations(client: pg.ClientBase, now: Date): Promise<number> {
  const exists = await client.query<{ n: string }>(
    `select count(*)::text as n from information_schema.columns
      where table_schema = 'public' and table_name = 'conversation'
        and column_name = 'last_message_at'`,
  );
  if (exists.rows[0]?.n !== '1') return 0;
  const cutoff = new Date(now.getTime() - conversationSettings.retentionMs);
  const result = await client.query<{ n: string }>(
    'select count(*)::text as n from public.conversation where last_message_at < $1',
    [cutoff],
  );
  return Number(result.rows[0]?.n ?? 0);
}

type LoadResult = Pick<RestoreReport, 'tables' | 'expiredConversations' | 'pendingMigrations'>;

/**
 * Segunda pasada, en una única transacción (FR-011): vacía los esquemas, reconstruye el de la
 * copia con las migraciones del núcleo, carga los datos, fija las secuencias y recuenta. Ante
 * cualquier error, `ROLLBACK` y la BD queda como estaba.
 *
 * Las claves ajenas se quitan antes de cargar y se vuelven a crear (y validar) al final, como
 * hace `pg_restore`: el volcado se carga en su orden sin depender de las relaciones.
 *
 * No pasa por la escritura protegida (FR-032 de la 001): deja el estado de la copia tal cual.
 */
export async function loadBackup(
  client: pg.ClientBase,
  pre: PrecheckedBackup,
  options: { clock?: Clock; internal?: RestoreInternals } = {},
): Promise<LoadResult> {
  const { header } = pre;
  const clock = options.clock ?? systemClock;
  await client.query('begin');
  try {
    await client.query(`set local lock_timeout = '5s'`);
    await wipeSchemas(client);
    await applyMigrationsUpTo(client, header.schema.index);

    const rebuilt = (await listTables(client)).map((t) => `${t.schema}.${t.name}`).sort();
    const expected = header.tables.map((t) => `${t.schema}.${t.name}`).sort();
    if (rebuilt.join('|') !== expected.join('|')) {
      throw new RestoreFailure('schema_mismatch', { schema: header.schema.tag });
    }
    // Las migraciones insertan filas iniciales (y sus propias filas): se cargan las de la copia.
    await client.query(
      `truncate ${header.tables.map((t) => qualified(t.schema, t.name)).join(', ')} cascade`,
    );
    const keys = await foreignKeys(client);
    for (const k of keys) {
      await client.query(`alter table ${k.table} drop constraint ${quoteIdent(k.name)}`);
    }

    const { stream } = await openBackup(pre.path, [pre.key]);
    let loaded = 0;
    await readDump(stream, header, {
      async table(table, rows) {
        const columns = table.columns.map(quoteIdent).join(', ');
        const copy = client.query(
          copyFrom(`copy ${qualified(table.schema, table.name)} (${columns}) from stdin`),
        );
        await pipeline(Readable.from(rows), copy);
        loaded += 1;
        await options.internal?.afterTable?.(loaded, table, client);
      },
      async sequences(values) {
        for (const v of values) {
          await client.query('select setval($1::regclass, $2::bigint, $3)', [
            qualified(v.schema, v.name),
            v.value,
            v.called,
          ]);
        }
      },
    });

    for (const k of keys) {
      await client.query(
        `alter table ${k.table} add constraint ${quoteIdent(k.name)} ${k.definition}`,
      );
    }
    for (const t of header.tables) {
      if ((await countRows(client, t.schema, t.name)) !== t.rows) {
        throw new RestoreFailure('count_mismatch');
      }
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    if (error instanceof RestoreFailure) throw error;
    throw new RestoreFailure('db_error');
  }
  return {
    tables: header.tables.map((t) => ({ name: t.name, rows: t.rows })),
    expiredConversations: await countExpiredConversations(client, clock.now()),
    pendingMigrations: (await pendingMigrations(client)).map((m) => m.tag),
  };
}

function reportFor(
  pre: PrecheckedBackup,
  config: BackupConfig,
  loaded: LoadResult,
): Omit<RestoreReport, 'durationMs'> {
  const { header } = pre;
  return {
    file: pre.file,
    sourceInstance: header.instanceId,
    crossInstance: header.instanceId !== config.instanceId,
    schema: header.schema.tag,
    installedSchema: installedSchema().tag,
    coreVersion: header.coreVersion,
    createdAt: header.createdAt,
    ...loaded,
  };
}

/** Comprobación previa + carga sobre la conexión recibida (restauración y comprobación). */
export async function restoreInto(
  client: pg.ClientBase,
  path: string,
  options: RestoreOptions & { internal?: RestoreInternals },
): Promise<Omit<RestoreReport, 'durationMs'>> {
  const pre = await precheckBackup(path, options);
  const loaded = await loadBackup(client, pre, options);
  return reportFor(pre, options.config, loaded);
}

export interface RestoreBackupOptions extends RestoreOptions {
  databaseUrl: string;
  /** Ruta del fichero. */
  file: string;
  logger?: LoggerLike;
  internal?: RestoreInternals;
}

/**
 * Restaura la instancia (US2): exige la instancia parada (bloqueo `instance_running`, que se
 * mantiene mientras dura), comprueba la copia entera y la carga en una transacción.
 */
export async function restoreBackup(options: RestoreBackupOptions): Promise<RestoreReport> {
  const log = createBackupLog(options.logger ?? silentLogger);
  const file = basename(options.file);
  const started = Date.now();
  let lock: Awaited<ReturnType<typeof tryAdvisoryLock>> = null;
  let client: pg.Client | null = null;
  try {
    try {
      lock = await tryAdvisoryLock(options.databaseUrl, INSTANCE_RUNNING);
    } catch (error) {
      throw new RestoreFailure(connectFailure(error, 'db_error'));
    }
    if (!lock) throw new RestoreFailure('instance_running');
    const pre = await precheckBackup(options.file, options);
    try {
      client = await connect(options.databaseUrl);
    } catch (error) {
      throw new RestoreFailure(connectFailure(error, 'db_error'));
    }
    const loaded = await loadBackup(client, pre, options);
    const report: RestoreReport = {
      ...reportFor(pre, options.config, loaded),
      durationMs: Date.now() - started,
    };
    log.log({
      event: 'restore_completed',
      file,
      sourceInstance: report.sourceInstance,
      crossInstance: report.crossInstance,
      schema: report.schema,
      installedSchema: report.installedSchema,
      durationMs: report.durationMs,
      tables: report.tables,
      expiredConversations: report.expiredConversations,
    });
    return report;
  } catch (error) {
    const failure = error instanceof RestoreFailure ? error : new RestoreFailure('db_error');
    log.log({ event: 'restore_rejected', file, failure: failure.code });
    throw failure;
  } finally {
    if (client) await client.end().catch(() => undefined);
    if (lock) await lock.release();
  }
}

// ---------------------------------------------------------------------------
// Comprobación en una BD temporal (US5, research R12)
// ---------------------------------------------------------------------------

/** Limpieza de bases temporales huérfanas antes de verificar (013, contracts/verify-cleanup.md). */
export interface OrphanCleanup {
  /** `false` si no se pudo listar el servidor (la verificación sigue). */
  listed: boolean;
  removed: number;
  /** Huérfanas que no se pudieron borrar (permisos u otro error). */
  failed: number;
}

export interface VerifyReport {
  file: string;
  restorable: boolean;
  failure?: RestoreFailureCode;
  sourceInstance?: string;
  schema?: string;
  installedSchema: string;
  coreVersion?: string;
  createdAt?: string;
  tables?: TableCount[];
  expiredConversations?: number;
  /** Sin nombres de base: solo recuentos. */
  orphans: OrphanCleanup;
  durationMs: number;
}

/** Ganchos de prueba de `verifyBackup`. */
export interface VerifyInternals {
  /** Sustituye el listado de bases `verify_%` (p. ej. para simular que falla). */
  listOrphans?: (admin: pg.ClientBase) => Promise<Array<{ name: string; connections: number }>>;
  /** Tras conectar a la temporal y antes de cargar la copia. */
  beforeLoad?: (database: string) => Promise<void>;
}

/** La misma URL apuntando a otra base de datos del servidor. */
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Bases `verify_%` del servidor con sus conexiones; legible para cualquier usuario (R5). */
async function listVerifyDatabases(
  admin: pg.ClientBase,
): Promise<Array<{ name: string; connections: number }>> {
  const result = await admin.query<{ name: string; connections: number }>(
    `select d.datname as name, count(a.pid)::int as connections
       from pg_database d left join pg_stat_activity a on a.datname = d.datname
      where d.datname like 'verify\\_%'
      group by d.datname`,
  );
  return result.rows;
}

/**
 * Borra las huérfanas (patrón exacto, sin conexiones y más de 6 h o formato anterior) con `DROP`
 * **sin** `FORCE`: si alguien se conecta entre el listado y el borrado, PostgreSQL lo rechaza
 * (`55006`) y la base se respeta sin contarla. Ningún fallo detiene la verificación (FR-012).
 */
async function cleanupOrphans(
  admin: pg.ClientBase,
  now: Date,
  internal: VerifyInternals | undefined,
): Promise<OrphanCleanup> {
  let rows;
  try {
    rows = await (internal?.listOrphans ?? listVerifyDatabases)(admin);
  } catch {
    return { listed: false, removed: 0, failed: 0 };
  }
  const result: OrphanCleanup = { listed: true, removed: 0, failed: 0 };
  for (const name of selectOrphans(rows, now)) {
    try {
      // `selectOrphans` solo devuelve nombres del patrón exacto: no se puede inyectar nada.
      await admin.query(`drop database ${quoteIdent(name)}`);
      result.removed += 1;
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== '55006') result.failed += 1;
    }
  }
  return result;
}

/**
 * Restaura la copia en una BD temporal `verify_<yyyymmddhhmmss UTC>_<16 hex>` del servidor de
 * `BACKUP_VERIFY_URL`, recuenta contra la cabecera y la borra siempre. Nunca lee ni escribe las
 * tablas de la instancia: de ese servidor solo usa la BD de mantenimiento de la URL para limpiar
 * las huérfanas y crear y borrar la temporal, que no admite conexiones de otros usuarios
 * (`REVOKE … FROM PUBLIC`, 013 FR-009). Acepta copias de cualquier instancia (el informe dice de
 * cuál es).
 */
export async function verifyBackup(options: {
  file: string;
  config: BackupConfig;
  clock?: Clock;
  logger?: LoggerLike;
  internal?: VerifyInternals;
}): Promise<VerifyReport> {
  const log = createBackupLog(options.logger ?? silentLogger);
  const file = basename(options.file);
  const started = Date.now();
  const installed = installedSchema().tag;
  const clock = options.clock ?? systemClock;
  let header: BackupHeader | null = null;
  let orphans: OrphanCleanup = { listed: false, removed: 0, failed: 0 };

  const finish = (
    report: Omit<VerifyReport, 'durationMs' | 'installedSchema' | 'orphans'>,
  ): VerifyReport => {
    const full: VerifyReport = {
      ...report,
      installedSchema: installed,
      orphans,
      durationMs: Date.now() - started,
    };
    log.log({
      event: 'verify_completed',
      file,
      restorable: full.restorable,
      ...(full.failure ? { failure: full.failure } : {}),
      ...(full.schema ? { schema: full.schema } : {}),
      durationMs: full.durationMs,
      orphansListed: orphans.listed,
      orphansRemoved: orphans.removed,
      orphansFailed: orphans.failed,
    });
    return full;
  };
  const fromHeader = () =>
    header
      ? {
          sourceInstance: header.instanceId,
          schema: header.schema.tag,
          coreVersion: header.coreVersion,
          createdAt: header.createdAt,
        }
      : {};

  const now = clock.now();
  const database = verifyDatabaseName(now, randomBytes(8));
  let admin: pg.Client | null = null;
  let created = false;
  try {
    header = (await readHeader(options.file).catch(() => null))?.header ?? null;
    const pre = await precheckBackup(options.file, {
      config: options.config,
      acceptAnyInstance: true,
    });
    try {
      admin = new pg.Client({ connectionString: options.config.verifyUrl });
      admin.on('error', () => undefined);
      await admin.connect();
    } catch (error) {
      throw new RestoreFailure(connectFailure(error, 'verify_db_unavailable'));
    }
    orphans = await cleanupOrphans(admin, now, options.internal);
    try {
      // El nombre solo lleva cifras, `_` y [0-9a-f]: no se puede inyectar nada.
      await admin.query(`create database ${quoteIdent(database)}`);
      created = true;
      // Antes de cargar ningún dato: solo su dueño (y un superusuario) puede entrar.
      await admin.query(
        `revoke connect, temporary on database ${quoteIdent(database)} from public`,
      );
    } catch {
      // Si la base llegó a crearse, el `finally` la borra.
      throw new RestoreFailure('verify_db_unavailable');
    }
    let client: pg.Client | null = null;
    try {
      try {
        client = await connect(withDatabase(options.config.verifyUrl, database));
      } catch (error) {
        throw new RestoreFailure(connectFailure(error, 'verify_db_unavailable'));
      }
      await options.internal?.beforeLoad?.(database);
      const loaded = await loadBackup(client, pre, options.clock ? { clock: options.clock } : {});
      return finish({
        file,
        restorable: true,
        ...fromHeader(),
        tables: loaded.tables,
        expiredConversations: loaded.expiredConversations,
      });
    } finally {
      if (client) await client.end().catch(() => undefined);
    }
  } catch (error) {
    const failure = error instanceof RestoreFailure ? error.code : 'db_error';
    return finish({ file, restorable: false, failure, ...fromHeader() });
  } finally {
    if (admin) {
      if (created) {
        await admin
          .query(`drop database if exists ${quoteIdent(database)} with (force)`)
          .catch(() => undefined);
      }
      await admin.end().catch(() => undefined);
    }
  }
}
