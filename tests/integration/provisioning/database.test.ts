import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';
import {
  buildDatabaseUrl,
  connectPg,
  createDatabase,
  databaseNames,
  generateDbPassword,
  parseAdminUrl,
  planSql,
  printableSql,
  scramVerifier,
  type DbStep,
  type PgConnect,
} from '../../../src/provisioning/database.js';

const adminUrl = () => inject('pgAdminUrl');

/** Id único por prueba: el servidor se comparte con el resto de la suite. */
const newId = () => `t-${randomBytes(4).toString('hex')}`;

function prepare(id = newId()) {
  const names = databaseNames(id);
  const password = generateDbPassword();
  const plan = planSql(names, scramVerifier(password, randomBytes(16)));
  const admin = parseAdminUrl(adminUrl());
  const identity = {
    host: admin?.host ?? '',
    port: admin?.port ?? 0,
    name: names.database,
    user: names.user,
  };
  const url = buildDatabaseUrl({
    host: identity.host,
    port: identity.port,
    database: names.database,
    user: names.user,
    password,
  });
  return { id, names, password, plan, identity, url };
}

async function adminQuery<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

/** Catálogos del servidor que la creación podría cambiar. */
const catalog = async () =>
  JSON.stringify([
    await adminQuery(
      "select datname, datacl::text from pg_database where datname like 'chatbot_%' order by 1",
    ),
    await adminQuery("select rolname from pg_roles where rolname like 'chatbot_%' order by 1"),
  ]);

/** Cliente que registra las sentencias enviadas. */
function recording(sent: string[]): PgConnect {
  return async (url) => {
    const client = await connectPg(url);
    return {
      query: (sql, params) => {
        sent.push(sql);
        return client.query(sql, params);
      },
      end: () => client.end(),
    };
  };
}

describe('creación de la base de datos (US3, research R8)', () => {
  it('SC-006: cada usuario entra solo en la suya y un usuario sin privilegios en ninguna', async () => {
    const a = prepare();
    const b = prepare();
    for (const x of [a, b]) {
      const result = await createDatabase(adminUrl(), x.plan, x.password, x.identity);
      expect(result.failure).toBeNull();
      expect(result.steps).toEqual(['role', 'database', 'revoke', 'probe']);
    }
    expect(await canConnect(a.url)).toBe(true);
    expect(await canConnect(b.url)).toBe(true);
    expect(await canConnect(withDb(a.url, b.names.database))).toBe(false);
    expect(await canConnect(withDb(b.url, a.names.database))).toBe(false);

    const outsider = `intruso_${randomBytes(3).toString('hex')}`;
    const outsiderPassword = randomBytes(18).toString('base64url');
    await adminQuery(`create role ${outsider} login password '${outsiderPassword}'`);
    const outsiderUrl = buildDatabaseUrl({
      ...a.identity,
      database: a.names.database,
      user: outsider,
      password: outsiderPassword,
    });
    expect(await canConnect(outsiderUrl)).toBe(false);
    expect(await canConnect(withDb(outsiderUrl, b.names.database))).toBe(false);
  });

  it('usuario sin privilegios de administración; BD vacía con public de su usuario', async () => {
    const x = prepare();
    expect((await createDatabase(adminUrl(), x.plan, x.password, x.identity)).failure).toBeNull();
    const [role] = await adminQuery<{
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolsuper: boolean;
    }>('select rolcreatedb, rolcreaterole, rolsuper from pg_roles where rolname = $1', [
      x.names.user,
    ]);
    expect(role).toEqual({ rolcreatedb: false, rolcreaterole: false, rolsuper: false });

    const client = new pg.Client({ connectionString: x.url });
    await client.connect();
    try {
      const tables = await client.query("select 1 from pg_tables where schemaname = 'public'");
      expect(tables.rows).toEqual([]);
      const owner = await client.query<{ owner: string }>(
        "select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'public'",
      );
      expect(owner.rows[0]?.owner).toBe('pg_database_owner');
      await client.query('create table prueba (id int)'); // el propietario puede crear en public
    } finally {
      await client.end();
    }
  });

  it('segundo intento con BD o usuario existentes → rechazo sin cambiar nada', async () => {
    const x = prepare();
    expect((await createDatabase(adminUrl(), x.plan, x.password, x.identity)).failure).toBeNull();
    const before = await catalog();
    const again = prepare(x.id);
    const result = await createDatabase(adminUrl(), again.plan, again.password, again.identity);
    expect(result.failure).toEqual({ code: 'role_exists', step: 'check' });
    expect(await catalog()).toBe(before);
    expect(await canConnect(x.url)).toBe(true); // la contraseña original sigue valiendo

    const onlyDb = prepare();
    await adminQuery(`create database ${onlyDb.names.database}`);
    const before2 = await catalog();
    const result2 = await createDatabase(adminUrl(), onlyDb.plan, onlyDb.password, onlyDb.identity);
    expect(result2.failure).toEqual({ code: 'db_exists', step: 'check' });
    expect(await catalog()).toBe(before2);
  });

  it('fallo en CREATE DATABASE → el usuario se retira', async () => {
    const x = prepare();
    const result = await createDatabase(adminUrl(), x.plan, x.password, x.identity, {
      failAt: 'database',
    });
    expect(result).toMatchObject({
      steps: ['role'],
      rolledBack: ['role'],
      failure: { code: 'step_failed', step: 'database' },
    });
    expect(await adminQuery('select 1 from pg_roles where rolname = $1', [x.names.user])).toEqual(
      [],
    );
  });

  it.each(['revoke', 'probe'] as DbStep[])(
    'fallo en %s → BD y usuario siguen existiendo; informe con los pasos exactos',
    async (step) => {
      const x = prepare();
      const result = await createDatabase(adminUrl(), x.plan, x.password, x.identity, {
        failAt: step,
      });
      expect(result.rolledBack).toEqual([]);
      expect(result.steps).toEqual(
        step === 'revoke' ? ['role', 'database'] : ['role', 'database', 'revoke'],
      );
      expect(result.failure?.step).toBe(step);
      expect(
        await adminQuery('select 1 from pg_database where datname = $1', [x.names.database]),
      ).toHaveLength(1);
      expect(
        await adminQuery('select 1 from pg_roles where rolname = $1', [x.names.user]),
      ).toHaveLength(1);
    },
  );

  it('el SQL de --print-sql produce el mismo estado y la URL conecta', async () => {
    const x = prepare();
    for (const sql of printableSql(x.plan)) {
      if (!sql.startsWith('--')) await adminQuery(sql);
    }
    expect(await canConnect(x.url)).toBe(true);
    const [acl] = await adminQuery<{ datacl: string }>(
      'select datacl::text from pg_database where datname = $1',
      [x.names.database],
    );
    // Sin entrada para PUBLIC (`=c/…` o `=Tc/…`): solo el propietario.
    expect(acl?.datacl ?? '').not.toMatch(/(^|[{,])=/);
  });

  it('la contraseña no viaja: ni en las sentencias ni en pg_stat_activity', async () => {
    const x = prepare();
    const sent: string[] = [];
    expect(
      (
        await createDatabase(adminUrl(), x.plan, x.password, x.identity, {
          connect: recording(sent),
        })
      ).failure,
    ).toBeNull();
    expect(sent.some((s) => s.includes('SCRAM-SHA-256$4096:'))).toBe(true);
    expect(sent.some((s) => s.includes(x.password))).toBe(false);
    const activity = await adminQuery<{ query: string }>('select query from pg_stat_activity');
    expect(activity.some((a) => a.query.includes(x.password))).toBe(false);
  });
});
