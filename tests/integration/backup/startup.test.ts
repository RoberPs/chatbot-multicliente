/**
 * Orden del arranque (006, R7, R9, R11): bloqueo de instancia, migraciones con copia previa,
 * purga de conversaciones caducadas antes de escuchar y tareas periódicas.
 */
import { readdir } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOptions } from '../../../src/app.js';
import { InstanceBusyError, MigrationBlockedError } from '../../../src/backup/errors.js';
import { INSTANCE_RUNNING, tryAdvisoryLock } from '../../../src/backup/locks.js';
import { loadEnv } from '../../../src/config/env.js';
import { startInstance } from '../../../src/startup.js';
import {
  captureLogger,
  cliEnv,
  createDatabaseMigratedUpTo,
  seedInstance,
  tableSnapshot,
  tempBackupDir,
  withClient,
  type ScratchDatabase,
} from '../../helpers/backup.js';
import { seedSchema0003 } from '../../helpers/backup.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const opened: Array<TestDatabase | ScratchDatabase> = [];
afterAll(async () => {
  for (const d of opened) await d.close();
});

const quietApp = (options: BuildAppOptions) => buildApp({ ...options, logger: false });
const noBackup = { INSTANCE_ID: undefined, BACKUP_DIR: undefined, BACKUP_KEY: undefined };

const countConversations = (url: string) =>
  withClient(url, async (client) => {
    const r = await client.query<{ n: string }>(
      `select count(*)::text as n from conversation where last_message_at < now() - interval '30 days'`,
    );
    return Number(r.rows[0]?.n);
  });

describe('arranque de la instancia', () => {
  it('borra las conversaciones de más de 30 días antes de escuchar (SC-005)', async () => {
    const test = await createTestDatabase();
    opened.push(test);
    await seedInstance(test.db, undefined, new Date());
    expect(await countConversations(test.url)).toBe(1);

    const env = loadEnv(cliEnv(test.url, '/no/usado', noBackup));
    let atListen: number | null = null;
    const logger = captureLogger();
    const instance = await startInstance({
      env,
      logger,
      buildApp: quietApp,
      listen: async () => {
        atListen = await countConversations(test.url);
      },
    });
    await instance.stop();
    expect(atListen).toBe(0);
    // Fuera de production y sin configuración de copias se avisa una vez.
    expect(logger.events('backup_disabled')).toEqual([
      {
        channel: 'backup',
        event: 'backup_disabled',
        missing: ['INSTANCE_ID', 'BACKUP_DIR', 'BACKUP_KEY'],
      },
    ]);
  });

  it('con datos, migraciones pendientes y sin copias configuradas no migra ni escucha (SC-003)', async () => {
    const old = await createDatabaseMigratedUpTo(3);
    opened.push(old);
    await seedSchema0003(old.url);
    const before = await tableSnapshot(old.url);
    const env = loadEnv(cliEnv(old.url, '/no/usado', noBackup));
    const logger = captureLogger();
    let listened = false;
    const error = await startInstance({
      env,
      logger,
      buildApp: quietApp,
      listen: () => {
        listened = true;
        return Promise.resolve();
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(MigrationBlockedError);
    expect((error as MigrationBlockedError).failure).toBe('backup_not_configured');
    expect(listened).toBe(false);
    expect(await tableSnapshot(old.url)).toEqual(before);
    expect(logger.events('migration_blocked')).toEqual([
      {
        channel: 'backup',
        event: 'migration_blocked',
        pending: ['0004_handoff', '0005_config_transfer', '0006_usage'],
        failure: 'backup_not_configured',
      },
    ]);
    // El bloqueo de instancia se ha liberado al fallar.
    const lock = await tryAdvisoryLock(old.url, INSTANCE_RUNNING);
    expect(lock).not.toBeNull();
    await lock?.release();
  });

  it('con el bloqueo de instancia tomado no arranca ni migra', async () => {
    const old = await createDatabaseMigratedUpTo(3);
    opened.push(old);
    const lock = await tryAdvisoryLock(old.url, INSTANCE_RUNNING);
    try {
      const env = loadEnv(cliEnv(old.url, '/no/usado', noBackup));
      const error = await startInstance({
        env,
        buildApp: quietApp,
        listen: () => Promise.resolve(),
      }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(InstanceBusyError);
      expect((error as Error).message).toBe(
        'Hay una restauración en curso o la instancia ya está en marcha',
      );
      const count = await withClient(old.url, async (client) => {
        const r = await client.query<{ n: string }>(
          'select count(*)::text as n from drizzle.__drizzle_migrations',
        );
        return r.rows[0]?.n;
      });
      expect(count).toBe('4');
    } finally {
      await lock?.release();
    }
  });

  it('con copias configuradas, el programador arranca tras escuchar y stop() espera su copia', async () => {
    const test = await createTestDatabase();
    opened.push(test);
    const dir = await tempBackupDir();
    try {
      // 00:00: la copia diaria toca a cualquier hora.
      const env = loadEnv(cliEnv(test.url, dir.path, { BACKUP_DAILY_TIME: '00:00' }));
      let atListen: string[] | null = null;
      const logger = captureLogger();
      const instance = await startInstance({
        env,
        logger,
        buildApp: quietApp,
        listen: async () => {
          atListen = await readdir(dir.path);
        },
      });
      await instance.stop();
      expect(atListen).toEqual([]);
      const files = await readdir(dir.path);
      expect(files).toEqual([expect.stringMatching(/__daily\.cbak$/)]);
      expect(logger.events('backup_disabled')).toEqual([]);
    } finally {
      await dir.remove();
    }
  });

  it('mientras vive tiene el bloqueo de instancia y lo libera al parar', async () => {
    const test = await createTestDatabase();
    opened.push(test);
    const env = loadEnv(cliEnv(test.url, '/no/usado', noBackup));
    let app: FastifyInstance | null = null;
    const instance = await startInstance({
      env,
      logger: captureLogger(),
      buildApp: quietApp,
      listen: (a) => {
        app = a;
        return Promise.resolve();
      },
    });
    expect(app).not.toBeNull();
    expect(await tryAdvisoryLock(test.url, INSTANCE_RUNNING)).toBeNull();
    await instance.stop();
    const lock = await tryAdvisoryLock(test.url, INSTANCE_RUNNING);
    expect(lock).not.toBeNull();
    await lock?.release();
  });
});
