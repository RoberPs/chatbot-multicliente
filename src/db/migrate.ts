import { pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { closeDb, createDb } from './client.js';
import { business } from './schema.js';
import { backupConfigFromEnv, type BackupConfig } from '../backup/config.js';
import { BackupError, MigrationBlockedError, MigrationFailedError } from '../backup/errors.js';
import { createBackupLog, silentLogger } from '../backup/log.js';
import {
  databaseSchema,
  defaultMigrationsFolder,
  pendingMigrations,
} from '../backup/schema-version.js';
import { createBackup } from '../backup/service.js';
import { loadDotEnvIfPresent, loadEnv } from '../config/env.js';
import type { LoggerLike } from '../conversation/activity-log.js';
import type { Clock } from '../conversation/ports.js';

export interface MigrationDefaults {
  timezone: string;
  currency: string;
}

/** Configuración de la copia previa a las migraciones (006, R9). */
export interface BackupGuard {
  config: BackupConfig;
  clock?: Clock;
}

export interface MigrationOptions {
  /** Sin él, una BD con datos y migraciones pendientes no se migra (fail-closed, FR-015). */
  backup?: BackupGuard;
  logger?: LoggerLike;
  migrationsFolder?: string;
}

/** Versión actual y migraciones pendientes, leídas con una conexión propia. */
async function inspect(databaseUrl: string, folder: string) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return {
      current: await databaseSchema(client, folder),
      pending: (await pendingMigrations(client, folder)).map((m) => m.tag),
    };
  } finally {
    await client.end();
  }
}

/**
 * Aplica las migraciones del núcleo y crea el negocio vacío en "draft" si no existe. Con datos
 * y migraciones pendientes hace antes una copia `premigration`; si no puede, no migra (006,
 * R9, FR-014 – FR-016). Una BD vacía o sin pendientes migra (o nada) sin copia.
 */
export async function runMigrations(
  databaseUrl: string,
  defaults: MigrationDefaults,
  options: MigrationOptions = {},
): Promise<void> {
  const folder = options.migrationsFolder ?? defaultMigrationsFolder;
  const logger = options.logger ?? silentLogger;
  const log = createBackupLog(logger);
  const { current, pending } = await inspect(databaseUrl, folder);

  let premigrationFile: string | null = null;
  if (current !== 'empty' && pending.length > 0) {
    if (!options.backup) {
      log.log({ event: 'migration_blocked', pending, failure: 'backup_not_configured' });
      throw new MigrationBlockedError(pending, 'backup_not_configured');
    }
    try {
      const report = await createBackup({
        databaseUrl,
        config: options.backup.config,
        reason: 'premigration',
        ...(options.backup.clock ? { clock: options.backup.clock } : {}),
        logger,
      });
      premigrationFile = report.file;
    } catch (error) {
      const failure = error instanceof BackupError ? error.code : 'io_error';
      log.log({ event: 'migration_blocked', pending, failure });
      throw new MigrationBlockedError(pending, failure);
    }
  }

  const db = createDb(databaseUrl);
  try {
    try {
      await migrate(db, { migrationsFolder: folder });
    } catch (error) {
      if (premigrationFile === null || current === 'empty') throw error;
      log.log({ event: 'migration_failed', pending, premigrationFile });
      throw new MigrationFailedError(pending, premigrationFile, current.tag);
    }
    await db
      .insert(business)
      .values({
        id: 1,
        status: 'draft',
        name: '',
        timezone: defaults.timezone,
        currency: defaults.currency,
      })
      .onConflictDoNothing();
  } finally {
    await closeDb(db);
  }
}

export interface MigrateIO {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  logger?: LoggerLike;
}

/** `pnpm db:migrate`: mismas reglas que el arranque del servidor. Devuelve el código de salida. */
export async function migrateMain(io: MigrateIO): Promise<number> {
  if (io.env === process.env) loadDotEnvIfPresent();
  let env;
  try {
    env = loadEnv(io.env);
  } catch (error) {
    io.err((error as Error).message);
    return 2;
  }
  const backup = backupConfigFromEnv(env);
  try {
    await runMigrations(
      env.DATABASE_URL,
      { timezone: env.DEFAULT_TIMEZONE, currency: env.DEFAULT_CURRENCY },
      {
        ...(backup ? { backup: { config: backup } } : {}),
        ...(io.logger ? { logger: io.logger } : {}),
      },
    );
  } catch (error) {
    if (error instanceof MigrationBlockedError || error instanceof MigrationFailedError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
  io.out('Migraciones aplicadas');
  return 0;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = await migrateMain({
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    env: process.env,
  });
}
