/**
 * Arranque de la instancia (006, contracts/backup-commands.md): bloqueo de instancia en marcha,
 * migraciones con copia previa, borrado de conversaciones caducadas antes de escuchar, servidor
 * y tareas periódicas. Las dependencias se inyectan para poder probar el orden.
 */
import type { FastifyInstance } from 'fastify';
import { buildApp as defaultBuildApp, type BuildAppOptions } from './app.js';
import { backupConfigFromEnv } from './backup/config.js';
import { InstanceBusyError } from './backup/errors.js';
import { INSTANCE_RUNNING, tryAdvisoryLock, type AdvisoryLock } from './backup/locks.js';
import { createBackupLog } from './backup/log.js';
import { createBackupScheduler } from './backup/scheduler.js';
import { createBot, type Bot } from './bot.js';
import { BACKUP_VARS, type Env } from './config/env.js';
import { createActivityLog, type LoggerLike } from './conversation/activity-log.js';
import { systemClock, type Clock } from './conversation/ports.js';
import { createRetention } from './conversation/retention.js';
import { closeDb, createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';

export interface StartInstanceOptions {
  env: Env;
  clock?: Clock;
  /** Registros de arranque y de las copias; por defecto, el logger de la app. */
  logger?: LoggerLike;
  buildApp?: (options: BuildAppOptions) => Promise<FastifyInstance>;
  /** Empieza a escuchar; por defecto `app.listen` en `PORT`. */
  listen?: (app: FastifyInstance) => Promise<unknown>;
  /** Carpeta de migraciones (pruebas). */
  migrationsFolder?: string;
}

export interface RunningInstance {
  app: FastifyInstance;
  /** Cierre ordenado: deja de recibir, espera lo que está en curso y cierra la BD. */
  stop(): Promise<void>;
}

export async function startInstance(options: StartInstanceOptions): Promise<RunningInstance> {
  const { env } = options;
  const clock = options.clock ?? systemClock;
  const build = options.buildApp ?? defaultBuildApp;
  const listen =
    options.listen ?? ((app: FastifyInstance) => app.listen({ port: env.PORT, host: '0.0.0.0' }));

  // Antes que nada: una restauración en curso o una segunda copia del servidor no arrancan (R7).
  const lock: AdvisoryLock | null = await tryAdvisoryLock(env.DATABASE_URL, INSTANCE_RUNNING);
  if (!lock) throw new InstanceBusyError();

  const db = createDb(env.DATABASE_URL);
  const started: { bot: Bot | null } = { bot: null };
  let app: FastifyInstance | null = null;
  try {
    app = await build({
      env,
      db,
      bot: (log) => (started.bot = createBot({ env, db, logger: log, clock })),
    });
    const logger = options.logger ?? app.log;

    const backup = backupConfigFromEnv(env);
    if (!backup && env.NODE_ENV !== 'production') {
      createBackupLog(logger).log({
        event: 'backup_disabled',
        missing: BACKUP_VARS.filter((k) => env[k] === undefined),
      });
    }

    await runMigrations(
      env.DATABASE_URL,
      { timezone: env.DEFAULT_TIMEZONE, currency: env.DEFAULT_CURRENCY },
      {
        ...(backup ? { backup: { config: backup, clock } } : {}),
        logger,
        ...(options.migrationsFolder ? { migrationsFolder: options.migrationsFolder } : {}),
      },
    );

    // Ninguna conversación de más de 30 días es visible al escuchar, haya o no bot (R11).
    await createRetention({
      db,
      clock,
      activityLog: createActivityLog(logger, env.SESSION_SECRET),
    }).purge();

    await listen(app);
  } catch (error) {
    await app?.close().catch(() => undefined);
    await closeDb(db).catch(() => undefined);
    await lock.release();
    throw error;
  }

  const bot = started.bot;
  bot?.processor.start();
  bot?.retention.start();
  // Copia diaria (R10), independiente de que haya bot.
  const backup = backupConfigFromEnv(env);
  const scheduler = backup
    ? createBackupScheduler({
        databaseUrl: env.DATABASE_URL,
        db,
        config: backup,
        clock,
        logger: options.logger ?? app.log,
        fallbackTimezone: env.DEFAULT_TIMEZONE,
      })
    : null;
  scheduler?.start();

  const running = app;
  return {
    app: running,
    async stop() {
      // Primero deja de recibir; después espera a lo que está en curso; por último, la BD.
      await running.close();
      await bot?.transcriber?.stop();
      await bot?.processor.stop();
      await bot?.retention.stop();
      await scheduler?.stop();
      await closeDb(db);
      await lock.release();
    },
  };
}
