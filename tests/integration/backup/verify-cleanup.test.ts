/**
 * Bases temporales de `db:verify` (013, US2, contracts/verify-cleanup.md): limpieza de huérfanas
 * con patrón exacto, sin conexiones y más de 6 h (o formato anterior), `DROP` sin `FORCE`, y
 * temporal sin acceso para otros usuarios durante la carga.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createBackup, verifyBackup, type BackupReport } from '../../../src/backup/service.js';
import { verifyDatabaseName } from '../../../src/backup/verify-names.js';
import { main } from '../../../src/cli/verify.js';
import {
  cliEnv,
  databasesLike,
  seedInstance,
  tempBackupDir,
  testBackupConfig,
  testClock,
  testIO,
  withClient,
  type TempDir,
} from '../../helpers/backup.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const NOW = '2026-10-06T09:30:00.000Z';
const HOUR = 60 * 60 * 1000;
const suffix = randomBytes(3).toString('hex');
const VERIFIER = `verificador_${suffix}`;
const OTHER_OWNER = `otro_dueno_${suffix}`;
const NO_PRIVILEGES = `sin_privilegios_${suffix}`;
const PASSWORD = 'clave-de-pruebas-013';

let test: TestDatabase;
let dir: TempDir;
let backup: BackupReport;
let verifierUrl: string;

const admin = () => inject('pgAdminUrl');
const urlAs = (user: string, database = 'postgres') => {
  const u = new URL(admin());
  u.username = user;
  u.password = PASSWORD;
  u.pathname = `/${database}`;
  return u.toString();
};
const hex = () => randomBytes(8).toString('hex');
const ago = (hours: number) => new Date(new Date(NOW).getTime() - hours * HOUR);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function createDatabase(name: string, owner = VERIFIER): Promise<void> {
  await withClient(admin(), (c) => c.query(`create database ${quote(name)} owner ${owner}`));
}
async function dropDatabase(name: string): Promise<void> {
  await withClient(admin(), (c) => c.query(`drop database if exists ${quote(name)} with (force)`));
}
async function exists(name: string): Promise<boolean> {
  return (await databasesLike(name)).includes(name);
}

beforeAll(async () => {
  test = await createTestDatabase();
  dir = await tempBackupDir();
  await seedInstance(test.db);
  backup = await createBackup({
    databaseUrl: test.url,
    config: testBackupConfig({ dir: dir.path }),
    reason: 'manual',
  });
  await withClient(admin(), async (c) => {
    await c.query(`create role ${VERIFIER} login createdb password '${PASSWORD}'`);
    await c.query(`create role ${OTHER_OWNER} login password '${PASSWORD}'`);
    await c.query(`create role ${NO_PRIVILEGES} login password '${PASSWORD}'`);
  });
  verifierUrl = urlAs(VERIFIER);
});

afterAll(async () => {
  for (const name of await databasesLike('verify_')) await dropDatabase(name);
  await withClient(admin(), async (c) => {
    for (const role of [VERIFIER, OTHER_OWNER, NO_PRIVILEGES]) {
      await c.query(`drop owned by ${role} cascade`).catch(() => undefined);
      await c.query(`drop role if exists ${role}`);
    }
  });
  await test.close();
  await dir.remove();
});

const config = () => testBackupConfig({ dir: dir.path, verifyUrl: verifierUrl });
const verify = (internal?: Parameters<typeof verifyBackup>[0]['internal']) =>
  verifyBackup({
    file: `${dir.path}/${backup.file}`,
    config: config(),
    clock: testClock(NOW),
    ...(internal ? { internal } : {}),
  });

describe('limpieza de huérfanas', () => {
  it('borra solo las que debe y respeta nombres ajenos, recientes y en uso', async () => {
    const oldCurrent = verifyDatabaseName(ago(7), randomBytes(8));
    const recent = verifyDatabaseName(ago(1), randomBytes(8));
    const legacyFree = `verify_${hex()}`;
    const legacyBusy = `verify_${hex()}`;
    const foreign = [
      'verify_x',
      'verify_otra_cosa',
      `verify_${hex()}_extra`,
      `chatbot_a_${suffix}`,
    ];
    for (const name of [oldCurrent, recent, legacyFree, legacyBusy, ...foreign]) {
      await createDatabase(name);
    }
    const busy = new pg.Client({ connectionString: urlAs(VERIFIER, legacyBusy) });
    await busy.connect();
    try {
      const report = await verify();
      expect(report.restorable).toBe(true);
      expect(report.orphans).toEqual({ listed: true, removed: 2, failed: 0 });
    } finally {
      await busy.end();
    }
    expect(await exists(oldCurrent)).toBe(false);
    expect(await exists(legacyFree)).toBe(false);
    for (const name of [recent, legacyBusy, ...foreign]) {
      expect(await exists(name)).toBe(true);
      await dropDatabase(name);
    }
  });

  it('una huérfana de otro dueño cuenta como failed y la verificación sigue', async () => {
    const theirs = verifyDatabaseName(ago(8), randomBytes(8));
    await createDatabase(theirs, OTHER_OWNER);
    try {
      const report = await verify();
      expect(report).toMatchObject({
        restorable: true,
        orphans: { listed: true, removed: 0, failed: 1 },
      });
      expect(await exists(theirs)).toBe(true);
    } finally {
      await dropDatabase(theirs);
    }
  });

  it('si no se puede listar el servidor → listed: false y la verificación sigue', async () => {
    const report = await verify({
      listOrphans: () => Promise.reject(new Error('permission denied for table pg_database')),
    });
    expect(report).toMatchObject({
      restorable: true,
      orphans: { listed: false, removed: 0, failed: 0 },
    });
  });
});

describe('la temporal no admite conexiones de otros usuarios (FR-009)', () => {
  it('un rol sin privilegios recibe permission denied durante la carga', async () => {
    let temporary = '';
    let refused: unknown = null;
    const report = await verify({
      async beforeLoad(database) {
        temporary = database;
        const intruder = new pg.Client({ connectionString: urlAs(NO_PRIVILEGES, database) });
        intruder.on('error', () => undefined);
        try {
          await intruder.connect();
        } catch (error) {
          refused = error;
        } finally {
          await intruder.end().catch(() => undefined);
        }
      },
    });
    expect(report.restorable).toBe(true);
    expect(temporary).toMatch(/^verify_20261006093000_[0-9a-f]{16}$/);
    expect((refused as { code?: string } | null)?.code).toBe('42501');
    expect((refused as Error).message).toContain('permission denied for database');
    expect(await exists(temporary)).toBe(false);
  });
});

describe('salida de pnpm db:verify', () => {
  const env = () => cliEnv(test.url, dir.path, { BACKUP_VERIFY_URL: verifierUrl });

  it('sin nada que contar no hay línea', async () => {
    const io = testIO(env());
    expect(await main([backup.file], io)).toBe(0);
    expect(io.stdout.join('\n')).not.toContain('huérfanas');
  });

  it('borradas, sin poder borrar y JSON; también si la copia no es restaurable', async () => {
    const mine = [`verify_${hex()}`, `verify_${hex()}`];
    for (const name of mine) await createDatabase(name);
    const io = testIO(env());
    expect(await main([backup.file], io)).toBe(0);
    expect(io.stdout).toContain('  Bases temporales huérfanas: 2 borradas.');
    expect(io.stdout.at(-1)).toBe('  Base de datos temporal eliminada.');

    const one = `verify_${hex()}`;
    const theirs = `verify_${hex()}`;
    await createDatabase(one);
    await createDatabase(theirs, OTHER_OWNER);
    try {
      const mixed = testIO(env());
      expect(await main([backup.file], mixed)).toBe(0);
      expect(mixed.stdout).toContain(
        '  Bases temporales huérfanas: 1 borrada, 1 sin poder borrar (permisos del usuario de BACKUP_VERIFY_URL).',
      );

      const json = testIO(env());
      expect(await main([backup.file, '--json'], json)).toBe(0);
      expect(JSON.parse(json.stdout[0] ?? '{}')).toMatchObject({
        restorable: true,
        orphans: { listed: true, removed: 0, failed: 1 },
      });

      // Con una copia que no se puede leer con esta clave, la línea sale igual.
      const wrongKey = testIO({ ...env(), BACKUP_KEY: randomBytes(32).toString('hex') });
      expect(await main([backup.file], wrongKey)).toBe(1);
      expect(wrongKey.stdout[1]).toMatch(/NO RESTAURABLE/);

      for (const io2 of [io, mixed, json, wrongKey]) {
        for (const name of [...mine, one, theirs]) expect(io2.all()).not.toContain(name);
        expect(io2.all()).not.toMatch(/verify_[0-9a-f]{16}|verify_\d{14}_/);
      }
    } finally {
      await dropDatabase(theirs);
    }
  });

  it('listado imposible: la línea de no comprobado', async () => {
    const { orphansLine } = await import('../../../src/cli/verify.js');
    expect(orphansLine({ listed: false, removed: 0, failed: 0 })).toBe(
      '  Bases temporales huérfanas: no se ha podido comprobar el servidor; puede quedar alguna.',
    );
    expect(orphansLine({ listed: true, removed: 0, failed: 0 })).toBeNull();
    expect(orphansLine({ listed: true, removed: 1, failed: 0 })).toBe(
      '  Bases temporales huérfanas: 1 borrada.',
    );
  });
});
