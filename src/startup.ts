/**
 * Arranque de la instancia (006, contracts/backup-commands.md): bloqueo de instancia en marcha,
 * migraciones con copia previa, borrado de conversaciones caducadas antes de escuchar, servidor
 * y tareas periódicas. Las dependencias se inyectan para poder probar el orden.
 */
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp as defaultBuildApp, type BuildAppOptions } from './app.js';
import { backupConfigFromEnv } from './backup/config.js';
import { InstanceBusyError, MigrationBlockedError, MigrationFailedError } from './backup/errors.js';
import { INSTANCE_RUNNING, tryAdvisoryLock, type AdvisoryLock } from './backup/locks.js';
import { createBackupLog } from './backup/log.js';
import { createBackupScheduler } from './backup/scheduler.js';
import { createBot, type Bot } from './bot.js';
import {
  assertCaReadable,
  DatabaseConfigError,
  describeDatabaseError,
} from './config/database-url.js';
import { BACKUP_VARS, protectionConfigFromEnv, type Env } from './config/env.js';
import { checkSecrets, SECRET_VARIABLES } from './config/secret-rules.js';
import { createActivityLog, type LoggerLike } from './conversation/activity-log.js';
import { systemClock, type Clock } from './conversation/ports.js';
import { createRetention } from './conversation/retention.js';
import { closeDb, createDb, createPublicDb } from './db/client.js';
import { createOutageWatcher, noteDbError, setOutageWatcher } from './db/outage.js';
import { runMigrations } from './db/migrate.js';
import { createInstanceHealth } from './health/report.js';
import { CoreVersionError, readCoreVersion } from './health/version.js';

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

/**
 * Fuera de producción los secretos débiles no impiden arrancar (en producción ya los rechazó
 * `loadEnv`, 012 R14), pero quedan en el registro de arranque: variable y regla, sin valores.
 */
function logWeakSecrets(env: Env, logger: LoggerLike): void {
  if (env.NODE_ENV === 'production') return;
  const source = Object.fromEntries(
    SECRET_VARIABLES.map((variable) => {
      const value: unknown = env[variable];
      return [variable, Array.isArray(value) ? value.join(',') : (value as string | undefined)];
    }),
  );
  const findings = checkSecrets(source)
    // HEALTH_SECRET solo es obligatoria en producción.
    .filter((f) => f.rule !== 'health_secret_required')
    .map(({ variable, rule }) => ({ variable, rule }));
  if (findings.length === 0) return;
  createActivityLog(logger, env.SESSION_SECRET).log({ event: 'weak_secrets', findings });
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

  // Sin versión del núcleo no se arranca: nunca se declara una versión desconocida (009, R4).
  const coreVersion = readCoreVersion();

  // 013: el certificado de la autoridad se comprueba antes de crear ningún cliente.
  assertCaReadable(env.DATABASE_URL, 'DATABASE_URL');

  // Antes que nada: una restauración en curso o una segunda copia del servidor no arrancan (R7).
  const lock: AdvisoryLock | null = await tryAdvisoryLock(env.DATABASE_URL, INSTANCE_RUNNING);
  if (!lock) throw new InstanceBusyError();

  const db = createDb(env.DATABASE_URL);
  // Lecturas del chat web en su propio pool pequeño (012, FR-022).
  const publicDb = createPublicDb(env.DATABASE_URL);

  /**
   * Vigilante del corte (016, FR-014, FR-004): recoge los errores de los pools, registra el
   * corte una sola vez y sondea la base hasta que vuelve, que es lo que permite recuperar el
   * servicio sin reiniciar el proceso. Se instala aquí, antes de nada, para que ya esté puesto
   * si la base se cae durante el propio arranque; su registro llega en cuanto exista el logger.
   */
  const outage = createOutageWatcher({
    probe: () => db.execute(sql`select 1`),
  });
  setOutageWatcher(outage);
  const started: { bot: Bot | null } = { bot: null };
  let app: FastifyInstance | null = null;
  try {
    app = await build({
      env,
      db,
      publicDb,
      bot: (log) => (started.bot = createBot({ env, db, logger: log, clock })),
      health: createInstanceHealth({
        databaseUrl: env.DATABASE_URL,
        coreVersion,
        protection: protectionConfigFromEnv(env),
        // El pool del sondeo también se cae en un corte: su error va al mismo vigilante.
        onPoolError: noteDbError,
      }),
    });
    const logger = options.logger ?? app.log;
    // Desde aquí el vigilante ya puede escribir; antes era silencioso.
    outage.attachLogger(createActivityLog(logger, env.SESSION_SECRET));
    logWeakSecrets(env, logger);

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
    // El arranque sin base de datos sigue terminando el proceso (assumption de la 016): lo que
    // cambia es el comportamiento de una instancia **ya en marcha**.
    outage.close();
    setOutageWatcher(null);
    await app?.close().catch(() => undefined);
    await closeDb(db).catch(() => undefined);
    await closeDb(publicDb).catch(() => undefined);
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
  // Servidor, bot y tareas en marcha: /health deja de responder `not_ready` (009, R3).
  running.lifecycle.markReady();
  return {
    app: running,
    async stop() {
      // Desde aquí /health responde `not_ready`.
      running.lifecycle.markStopping();
      // Primero deja de recibir; después espera a lo que está en curso; por último, la BD.
      await running.close();
      await bot?.transcriber?.stop();
      await bot?.processor.stop();
      await bot?.retention.stop();
      await scheduler?.stop();
      outage.close();
      setOutageWatcher(null);
      await closeDb(db);
      await closeDb(publicDb);
      await lock.release();
    },
  };
}

/**
 * Texto que muestra el proceso si el arranque falla (013, contracts/database-tls.md): el de los
 * errores propios, que no llevan datos; para cualquier otro, el texto fijo del fallo de conexión,
 * nunca `error.message` (el de un error TLS lleva el host y los nombres del certificado).
 */
export function startupErrorMessage(error: unknown): string {
  if (error instanceof DatabaseConfigError) return error.describe();
  if (
    error instanceof InstanceBusyError ||
    error instanceof MigrationBlockedError ||
    error instanceof MigrationFailedError ||
    error instanceof CoreVersionError
  ) {
    return error.message;
  }
  return describeDatabaseError(error, 'DATABASE_URL').describe();
}
