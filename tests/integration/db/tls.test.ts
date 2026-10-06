/**
 * TLS verificado hacia PostgreSQL en todas las conexiones de la instancia (013, FR-008,
 * contracts/database-tls.md): con `sslmode=verify-full` y una autoridad propia funcionan los
 * pools, `/health`, las migraciones, el arranque, la copia, la restauración y la verificación; con
 * un nombre fuera del certificado o una autoridad ilegible fallan con mensajes sin datos.
 */
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp, type BuildAppOptions } from '../../../src/app.js';
import { main as backupMain } from '../../../src/cli/backup.js';
import { main as restoreMain } from '../../../src/cli/restore.js';
import { main as verifyMain } from '../../../src/cli/verify.js';
import { DatabaseConfigError } from '../../../src/config/database-url.js';
import { loadEnv } from '../../../src/config/env.js';
import { closeDb, createDb, createPublicDb } from '../../../src/db/client.js';
import { migrateMain, runMigrations } from '../../../src/db/migrate.js';
import { startInstance, startupErrorMessage } from '../../../src/startup.js';
import { cliEnv, tempBackupDir, testIO, type TempDir } from '../../helpers/backup.js';
import { expectNoUrlParts } from '../../helpers/provisioning.js';
import { startTlsPostgres, type TlsPostgres } from '../../helpers/tls-postgres.js';

const DB = 'chatbot_tls';
const MISSING_CA = '/no/existe-ca-secreta.crt';

let tls: TlsPostgres;
let dir: TempDir;
let url: string;
let backupFile = '';

const quietApp = (options: BuildAppOptions) => buildApp({ ...options, logger: false });
const noListen = () => Promise.resolve();

beforeAll(async () => {
  tls = await startTlsPostgres();
  dir = await tempBackupDir();
  const admin = new pg.Client({ connectionString: tls.adminUrl });
  await admin.connect();
  try {
    await admin.query(`create database ${DB}`);
  } finally {
    await admin.end();
  }
  url = tls.urlFor(DB);
}, 180_000);

afterAll(async () => {
  await dir.remove();
  await tls.stop();
});

const envFor = (databaseUrl: string, verifyUrl = tls.adminUrl) =>
  cliEnv(databaseUrl, dir.path, { BACKUP_VERIFY_URL: verifyUrl });
const json = (io: ReturnType<typeof testIO>) =>
  JSON.parse(io.stdout.join('\n')) as Record<string, unknown>;

describe('con verify-full y la autoridad propia', () => {
  it('migraciones, pools, arranque con su cerrojo y /health', async () => {
    await runMigrations(url, { timezone: 'Europe/Madrid', currency: 'EUR' });
    for (const db of [createDb(url), createPublicDb(url)]) {
      try {
        const r = await db.execute(sql`select ssl from pg_stat_ssl where pid = pg_backend_pid()`);
        expect(r.rows[0]).toEqual({ ssl: true });
      } finally {
        await closeDb(db);
      }
    }

    const instance = await startInstance({
      env: loadEnv(envFor(url)),
      buildApp: quietApp,
      listen: noListen,
    });
    try {
      const health = await instance.app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toMatchObject({ status: 'ok' });
    } finally {
      await instance.stop();
    }
  });

  it('db:migrate, db:backup, db:restore y db:verify', async () => {
    const migrate = testIO(envFor(url));
    expect(await migrateMain(migrate)).toBe(0);

    const backup = testIO(envFor(url));
    expect(await backupMain(['--json'], backup)).toBe(0);
    backupFile = String(json(backup).file);

    const restore = testIO(envFor(url));
    expect(await restoreMain([backupFile, '--yes', '--json'], restore)).toBe(0);

    const verify = testIO(envFor(url));
    expect(await verifyMain([backupFile, '--json'], verify)).toBe(0);
    expect(json(verify)).toMatchObject({ restorable: true });
  });
});

describe('certificado que no vale: otro nombre u otra autoridad', () => {
  // Otro servidor con un certificado para otro nombre y su propia autoridad. Con una IP en la URL
  // no se puede probar: `pg` no pasa la IP a TLS y Node compara el certificado con `localhost`.
  let other: TlsPostgres;
  beforeAll(async () => {
    other = await startTlsPostgres({ serverName: 'otro-servidor.pruebas' });
  }, 180_000);
  afterAll(async () => {
    await other.stop();
  });

  /** Se conecta por `localhost` a un servidor cuyo certificado es de `otro-servidor.pruebas`. */
  const wrongName = () => other.urlFor('postgres');
  /** El servidor bueno con la autoridad del otro. */
  const wrongCa = () => tls.urlFor(DB, { sslrootcert: other.caPath });
  const UNTRUSTED =
    'DATABASE_URL: el certificado del servidor no es válido para ese nombre o no lo firma una autoridad de confianza.\n→ Revisa el nombre del servidor en la URL y sslrootcert.';

  async function startupError(databaseUrl: string): Promise<unknown> {
    return startInstance({
      env: loadEnv(envFor(databaseUrl)),
      buildApp: quietApp,
      listen: noListen,
    }).then(
      async (instance) => {
        await instance.stop();
        return null;
      },
      (e: unknown) => e,
    );
  }

  it.each([
    ['nombre fuera del certificado', () => wrongName()],
    ['autoridad que no lo firma', () => wrongCa()],
  ])('el arranque falla con tls_untrusted (%s) y sin datos', async (_name, url) => {
    const error = await startupError(url());
    expect(error).not.toBeNull();
    const text = startupErrorMessage(error);
    expect(text).toBe(UNTRUSTED);
    expect(text).not.toMatch(/otro-servidor|localhost|autoridad-pruebas/);
  });

  it('las órdenes de copias devuelven db_tls_untrusted', async () => {
    const backup = testIO(envFor(wrongCa()));
    expect(await backupMain(['--json'], backup)).toBe(1);
    expect(json(backup)).toEqual({ ok: false, failure: 'db_tls_untrusted' });

    const restore = testIO(envFor(wrongCa()));
    expect(await restoreMain([backupFile, '--yes', '--json'], restore)).toBe(1);
    expect(json(restore)).toMatchObject({ ok: false, failure: 'db_tls_untrusted' });
    expect(restore.stderr.join('\n')).toContain('DATABASE_URL: el certificado del servidor');

    const verify = testIO(envFor(url, wrongName()));
    expect(await verifyMain([backupFile, '--json'], verify)).toBe(1);
    expect(json(verify)).toMatchObject({ restorable: false, failure: 'db_tls_untrusted' });

    const verifyText = testIO(envFor(url, wrongName()));
    expect(await verifyMain([backupFile], verifyText)).toBe(1);
    expect(verifyText.stderr.join('\n')).toContain(
      'BACKUP_VERIFY_URL: el certificado del servidor',
    );

    for (const io of [backup, restore, verify, verifyText]) {
      expect(io.all()).not.toMatch(/otro-servidor|autoridad-pruebas/);
      expectNoUrlParts(io.all(), wrongCa(), [other.caPath, tls.caPath]);
      expectNoUrlParts(io.all(), wrongName());
    }
  });
});

describe('autoridad ilegible', () => {
  const badCa = () => tls.urlFor(DB, { sslrootcert: MISSING_CA });

  it('el arranque y db:migrate fallan con ca_unreadable antes de conectar', async () => {
    const error = await startInstance({
      env: loadEnv(envFor(badCa())),
      buildApp: quietApp,
      listen: noListen,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect((error as DatabaseConfigError).reason).toBe('ca_unreadable');
    expect(startupErrorMessage(error)).not.toContain('existe-ca-secreta');

    const migrate = testIO(envFor(badCa()));
    expect(await migrateMain(migrate)).toBe(2);
    expect(migrate.stderr.join('\n')).toContain(
      'DATABASE_URL: no se puede leer el certificado de la autoridad indicado en sslrootcert.',
    );
    expect(migrate.all()).not.toContain('existe-ca-secreta');
  });

  it('las órdenes de copias devuelven db_ca_unreadable con sus códigos de salida', async () => {
    const backup = testIO(envFor(badCa()));
    expect(await backupMain(['--json'], backup)).toBe(1);
    expect(json(backup)).toEqual({ ok: false, failure: 'db_ca_unreadable' });

    const restore = testIO(envFor(badCa()));
    expect(await restoreMain([backupFile, '--yes', '--json'], restore)).toBe(2);
    expect(json(restore)).toEqual({ ok: false, failure: 'db_ca_unreadable' });

    const verify = testIO(envFor(url, tls.urlFor('postgres', { sslrootcert: MISSING_CA })));
    expect(await verifyMain([backupFile, '--json'], verify)).toBe(2);
    expect(json(verify)).toEqual({
      restorable: false,
      failure: 'db_ca_unreadable',
      orphans: { listed: false, removed: 0, failed: 0 },
    });
    expect(verify.stderr.join('\n')).toContain('BACKUP_VERIFY_URL: no se puede leer');

    for (const io of [backup, restore, verify]) {
      expect(io.all()).not.toContain('existe-ca-secreta');
      expectNoUrlParts(io.all(), badCa());
    }
  });
});

describe('servidor sin TLS', () => {
  it('db:backup con verify-full → db_tls_unsupported', async () => {
    const plain = new URL(inject('pgAdminUrl'));
    plain.searchParams.set('sslmode', 'verify-full');
    const backup = testIO(cliEnv(plain.toString(), dir.path));
    expect(await backupMain(['--json'], backup)).toBe(1);
    expect(json(backup)).toEqual({ ok: false, failure: 'db_tls_unsupported' });
  });
});
