/**
 * Salud con BD real (009, SC-004, FR-006): esquema real, BD parada o colgada, esquema adelantado y
 * atrasado, ciclo de vida del arranque y del cierre, solo lectura, no retrasa al bot y tiempo de
 * respuesta.
 */
import { createServer, type Server, type Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { installedSchema } from '../../../src/backup/schema-version.js';
import { loadEnv } from '../../../src/config/env.js';
import { closeDb, createDb } from '../../../src/db/client.js';
import { createLifecycle } from '../../../src/health/lifecycle.js';
import { createInstanceHealth } from '../../../src/health/report.js';
import { readCoreVersion } from '../../../src/health/version.js';
import { startInstance } from '../../../src/startup.js';
import { buildTestApp } from '../../helpers/app.js';
import { cliEnv, seedInstance, withClient } from '../../helpers/backup.js';
import { createTestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const HEALTH_SECRET = '2e6b9d1f4a7c3085e1a3c5f7092b4d6e8a0c2e4f6183a5c7e9b1d3f5a7c9e0d7';
const auth = { authorization: `Bearer ${HEALTH_SECRET}` };
const expected = installedSchema();
const coreVersion = readCoreVersion();

const opened: TestDatabase[] = [];
const apps: FastifyInstance[] = [];
const servers: Server[] = [];
afterAll(async () => {
  for (const app of apps) await app.close().catch(() => undefined);
  for (const server of servers) server.close();
  for (const d of opened) await d.close();
});

async function database(): Promise<TestDatabase> {
  const t = await createTestDatabase();
  opened.push(t);
  return t;
}

async function appFor(t: TestDatabase, databaseUrl = t.url): Promise<FastifyInstance> {
  const lifecycle = createLifecycle();
  lifecycle.markReady();
  const app = await buildTestApp(t.db, t.url, null, { HEALTH_SECRET }, undefined, {
    health: createInstanceHealth({ databaseUrl, coreVersion, lifecycle }),
  });
  apps.push(app);
  return app;
}

const getHealth = (app: FastifyInstance, remoteAddress = '10.50.0.1') =>
  app.inject({ method: 'GET', url: '/health', headers: auth, remoteAddress });

let address = 0;
const fresh = () => {
  address += 1;
  return `10.60.${Math.floor(address / 250)}.${(address % 250) + 1}`;
};

describe('/health con la BD real', () => {
  it('esquema real aplicado → 200 ok con applied = installedSchema()', async () => {
    const t = await database();
    const res = await getHealth(await appFor(t));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      instanceId: null,
      coreVersion,
      schema: {
        applied: { index: expected.index, tag: expected.tag },
        expected: { index: expected.index, tag: expected.tag },
      },
      // 010: leído en el mismo sondeo; la BD nueva tiene el tope desactivado.
      spendCap: 'none',
    });
  });

  /**
   * 016 (FR-003): la BD que **no contesta** ya no es `degraded` (503) sino `db_unavailable` con
   * **200**. El proceso vive y sirve; con 503, la sonda del contenedor daría la instancia por
   * enferma y la política de reinicio la relanzaría en mitad del corte, que es el bucle de
   * reinicios que la 016 elimina. `degraded` queda para la BD que **sí** contesta con un
   * esquema que no es el esperado, que es lo que de verdad necesita al operador.
   */
  it('BD parada (conexión rechazada) → 200 db_unavailable en ≤ 3 s, applied null (SC-004)', async () => {
    const t = await database();
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as { port: number }).port;
    await new Promise<void>((r) => {
      closed.close(() => {
        r();
      });
    });
    const app = await appFor(t, `postgres://u:p@127.0.0.1:${String(port)}/x`);
    const started = Date.now();
    const res = await getHealth(app, fresh());
    expect(Date.now() - started).toBeLessThanOrEqual(3000);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'db_unavailable', schema: { applied: null } });
    expect(res.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });

  it('BD colgada (acepta y no contesta) → 200 db_unavailable en ≤ 3 s', async () => {
    const t = await database();
    const sockets: Socket[] = [];
    const blackHole = createServer((socket) => sockets.push(socket));
    servers.push(blackHole);
    await new Promise<void>((r) => blackHole.listen(0, '127.0.0.1', r));
    const port = (blackHole.address() as { port: number }).port;
    const app = await appFor(t, `postgres://u:p@127.0.0.1:${String(port)}/x`);
    const started = Date.now();
    const res = await getHealth(app, fresh());
    expect(Date.now() - started).toBeLessThanOrEqual(3000);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'db_unavailable', schema: { applied: null } });
    for (const s of sockets) s.destroy();
  });

  it('migración desconocida para este núcleo → degraded con tag null e índice adelantado', async () => {
    const t = await database();
    await withClient(t.url, (c) =>
      c.query(
        `insert into drizzle.__drizzle_migrations (hash, created_at) values ('desconocida', $1)`,
        [Date.now() + 86_400_000],
      ),
    );
    const res = await getHealth(await appFor(t), fresh());
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'degraded',
      schema: { applied: { index: expected.index + 1, tag: null } },
    });
  });

  it('esquema atrasado (última migración no aplicada) → degraded', async () => {
    const t = await database();
    await withClient(t.url, (c) =>
      c.query(
        `delete from drizzle.__drizzle_migrations
          where created_at = (select max(created_at) from drizzle.__drizzle_migrations)`,
      ),
    );
    const res = await getHealth(await appFor(t), fresh());
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      status: 'degraded',
      schema: { applied: { index: expected.index - 1 } },
    });
  });
});

describe('ciclo de vida con startInstance', () => {
  it('not_ready antes de terminar el arranque, ok después y not_ready al parar', async () => {
    const t = await database();
    const env = loadEnv(
      cliEnv(t.url, '/no/usado', {
        INSTANCE_ID: undefined,
        BACKUP_DIR: undefined,
        BACKUP_KEY: undefined,
        HEALTH_SECRET,
      }),
    );
    let duringStart: number | null = null;
    const instance = await startInstance({
      env,
      buildApp: async (options) => {
        const { buildApp } = await import('../../../src/app.js');
        return buildApp({ ...options, logger: false });
      },
      listen: async (app) => {
        duringStart = (await getHealth(app, fresh())).statusCode;
        const body = (await getHealth(app, fresh())).json<{ status: string }>();
        expect(body.status).toBe('not_ready');
      },
    });
    expect(duringStart).toBe(503);
    const ready = await getHealth(instance.app, fresh());
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ok', coreVersion });

    const stopping = instance.stop();
    expect(instance.app.lifecycle.state).toBe('stopping');
    await stopping;
  });
});

describe('solo lectura y sin competir con el bot (FR-006)', () => {
  it('/health no escribe en la BD', async () => {
    const t = await database();
    await seedInstance(t.db, undefined, new Date());
    // Se cierra el pool de la siembra para que sus estadísticas queden publicadas.
    await t.close();
    opened.splice(opened.indexOf(t), 1);
    const db = createDb(t.url);
    const lifecycle = createLifecycle();
    lifecycle.markReady();
    const app = await buildTestApp(db, t.url, null, { HEALTH_SECRET }, undefined, {
      health: createInstanceHealth({ databaseUrl: t.url, coreVersion, lifecycle }),
    });
    apps.push(app);
    await new Promise((r) => setTimeout(r, 1200));

    const snapshot = () =>
      withClient(t.url, async (c) => {
        await c.query('select pg_stat_clear_snapshot()');
        const stats = await c.query<{ changes: string }>(
          `select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::text as changes
             from pg_stat_user_tables`,
        );
        const tables = await c.query<{ schemaname: string; relname: string }>(
          `select schemaname, relname from pg_stat_user_tables order by schemaname, relname`,
        );
        const counts: Record<string, number> = {};
        for (const { schemaname, relname } of tables.rows) {
          const r = await c.query<{ n: string }>(
            `select count(*)::text as n from "${schemaname}"."${relname}"`,
          );
          counts[`${schemaname}.${relname}`] = Number(r.rows[0]?.n);
        }
        return { changes: stats.rows[0]?.changes, counts };
      });

    const before = await snapshot();
    for (let i = 0; i < 20; i++) expect((await getHealth(app, fresh())).statusCode).toBe(200);
    await app.close();
    await closeDb(db);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await snapshot()).toEqual(before);
  });

  it('el bot responde mientras el sondeo está bloqueado en la BD', async () => {
    const t = await database();
    const bot = await createTestBot(t);
    const locker = new pg.Client({ connectionString: t.url });
    await locker.connect();
    try {
      await locker.query('begin');
      await locker.query('lock table drizzle.__drizzle_migrations in access exclusive mode');

      const healthDone = bot.app
        .inject({ method: 'GET', url: '/health', remoteAddress: fresh() })
        .then((r) => ({ status: r.statusCode, at: Date.now() }));
      await new Promise((r) => setTimeout(r, 100));

      const started = Date.now();
      expect(await bot.send('¿Qué horario tenéis?')).toBe(200);
      await bot.settle();
      const answeredAt = Date.now();
      expect(bot.sender.sent.length).toBeGreaterThan(0);
      expect(answeredAt - started).toBeLessThan(1500);

      const health = await healthDone;
      // 016 (FR-003): el sondeo bloqueado da `db_unavailable` con 200, no 503.
      expect(health.status).toBe(200);
      expect(answeredAt).toBeLessThan(health.at);
    } finally {
      await locker.query('rollback').catch(() => undefined);
      await locker.end();
      await bot.close();
    }
  });
});

describe('tiempo de respuesta', () => {
  it('con la BD sana, p95 < 250 ms en 50 consultas con credencial', async () => {
    const t = await database();
    const app = await appFor(t);
    for (let i = 0; i < 5; i++) await getHealth(app, fresh());
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const started = performance.now();
      const res = await getHealth(app, fresh());
      times.push(performance.now() - started);
      expect(res.statusCode).toBe(200);
    }
    times.sort((a, b) => a - b);
    expect(times[Math.ceil(times.length * 0.95) - 1]).toBeLessThan(250);
  });
});
