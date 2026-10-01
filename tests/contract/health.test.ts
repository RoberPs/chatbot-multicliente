/**
 * Contrato de `GET /health` (009, contracts/health-endpoint.md): dos niveles, estado también en el
 * código, 401 idéntico para cualquier credencial que no sea la de la instancia, límite de
 * peticiones y campos cerrados sin datos prohibidos en cuerpos ni registros (SC-003).
 */
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLifecycle } from '../../src/health/lifecycle.js';
import type { HealthReport, HealthStatus } from '../../src/health/report.js';
import { buildTestApp, login, TEST_SESSION_SECRET } from '../helpers/app.js';
import { seedInstance } from '../helpers/backup.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../helpers/db.js';

const HEALTH_SECRET = '5b8e2d4f6a1c3087e2a4c6f8093b5d7e9a1c3e5f7294b6d8f0a2c4e6b8d0f1a3';
const BACKUP_KEY = '9c4e1a7f3b5d2068e1a3c5f7092b4d6e8a0c2e4f6183a5c7e9b1d3f5a7c9e0b4';
const EXPECTED = { index: 5, tag: '0005_config_transfer' };

const reportOf = (status: HealthStatus): HealthReport => ({
  status,
  coreVersion: '1.4.0',
  schema: {
    applied: status === 'not_ready' ? null : status === 'ok' ? EXPECTED : { index: 6, tag: null },
    expected: EXPECTED,
  },
});

/** Claves permitidas por el contrato en cualquier respuesta. */
const ALLOWED_KEYS = new Set([
  'status',
  'instanceId',
  'coreVersion',
  'schema',
  'applied',
  'expected',
  'index',
  'tag',
  'error',
]);

function keysOf(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]);
}

let t: TestDatabase;
let seeded: Awaited<ReturnType<typeof seedInstance>>;
const bodies: string[] = [];
const logLines: string[] = [];
let addressCounter = 0;
/** Una IP distinta por petición salvo en la prueba del límite. */
const nextAddress = () => {
  addressCounter += 1;
  return `10.9.${Math.floor(addressCounter / 250)}.${(addressCounter % 250) + 1}`;
};

async function appWith(
  options: {
    secret?: string;
    report?: () => Promise<HealthReport>;
  } = {},
): Promise<FastifyInstance> {
  return buildTestApp(
    t.db,
    t.url,
    null,
    {
      INSTANCE_ID: 'demo-01',
      BACKUP_DIR: '/var/lib/chatbot/backups',
      BACKUP_KEY,
      ...(options.secret ? { HEALTH_SECRET: options.secret } : {}),
    },
    logLines,
    {
      health: {
        lifecycle: createLifecycle(),
        report: options.report ?? (() => Promise.resolve(reportOf('ok'))),
      },
    },
  );
}

async function health(
  app: FastifyInstance,
  headers: Record<string, string> = {},
  url = '/health',
  remoteAddress = nextAddress(),
): Promise<LightMyRequestResponse> {
  const res = await app.inject({ method: 'GET', url, headers, remoteAddress });
  bodies.push(res.body);
  return res;
}

const bearer = (value: string) => ({ authorization: `Bearer ${value}` });

beforeAll(async () => {
  t = await createTestDatabase();
  await resetDb(t.db);
  seeded = await seedInstance(t.db, undefined, new Date());
});

afterAll(async () => {
  await t.close();
});

describe('GET /health sin credencial', () => {
  it.each([
    ['ok', 200],
    ['degraded', 503],
    ['not_ready', 503],
  ] as const)('estado %s → %i con solo {status}', async (status, code) => {
    const app = await appWith({
      secret: HEALTH_SECRET,
      report: () => Promise.resolve(reportOf(status)),
    });
    const res = await health(app);
    expect(res.statusCode).toBe(code);
    expect(res.json()).toEqual({ status });
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('instancia sin HEALTH_SECRET: nivel público como cualquier otra', async () => {
    const app = await appWith();
    const res = await health(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('no exige sesión ni CSRF y no redirige al login', async () => {
    const app = await appWith({ secret: HEALTH_SECRET });
    const res = await health(app);
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    await app.close();
  });

  it('el secreto en la query string se ignora', async () => {
    const app = await appWith({ secret: HEALTH_SECRET });
    const res = await health(app, {}, `/health?secret=${HEALTH_SECRET}&token=${HEALTH_SECRET}`);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('HEAD /health responde el código sin cuerpo', async () => {
    const app = await appWith({ secret: HEALTH_SECRET });
    const res = await app.inject({ method: 'HEAD', url: '/health', remoteAddress: nextAddress() });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    await app.close();
  });
});

describe('GET /health con credencial', () => {
  it.each([
    ['ok', 200],
    ['degraded', 503],
    ['not_ready', 503],
  ] as const)(
    'credencial correcta, estado %s → %i con el informe completo',
    async (status, code) => {
      const app = await appWith({
        secret: HEALTH_SECRET,
        report: () => Promise.resolve(reportOf(status)),
      });
      const res = await health(app, bearer(HEALTH_SECRET));
      expect(res.statusCode).toBe(code);
      expect(res.json()).toEqual({
        status,
        instanceId: 'demo-01',
        coreVersion: '1.4.0',
        schema: reportOf(status).schema,
      });
      expect(res.headers['cache-control']).toBe('no-store');
      await app.close();
    },
  );

  it('la credencial en mayúsculas también vale', async () => {
    const app = await appWith({ secret: HEALTH_SECRET });
    const res = await health(app, bearer(HEALTH_SECRET.toUpperCase()));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('coreVersion');
    await app.close();
  });

  const UNAUTHORIZED = { error: 'unauthorized' };

  it.each([
    ['incorrecta', bearer(HEALTH_SECRET.replace(/.$/, '0'))],
    ['corta', bearer('0000')],
    ['mal formada (Basic)', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['mal formada (Bearer vacío)', { authorization: 'Bearer ' }],
  ])('credencial %s → 401 con WWW-Authenticate: Bearer', async (_name, headers) => {
    const app = await appWith({ secret: HEALTH_SECRET });
    const res = await health(app, headers);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual(UNAUTHORIZED);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('credencial enviada a una instancia sin HEALTH_SECRET → el mismo 401', async () => {
    const withSecret = await appWith({ secret: HEALTH_SECRET });
    const without = await appWith();
    const wrong = await health(withSecret, bearer('a'.repeat(64)));
    const noSecret = await health(without, bearer('a'.repeat(64)));
    expect(noSecret.statusCode).toBe(401);
    expect(noSecret.body).toBe(wrong.body);
    const pick = (r: LightMyRequestResponse) => ({
      type: r.headers['content-type'],
      auth: r.headers['www-authenticate'],
      cache: r.headers['cache-control'],
    });
    expect(pick(noSecret)).toEqual(pick(wrong));
    await withSecret.close();
    await without.close();
  });

  it('error inesperado del informe → 503 {"status":"degraded"} sin detalle', async () => {
    const app = await appWith({
      secret: HEALTH_SECRET,
      report: () => Promise.reject(new Error(`fallo en ${t.url} con ${TEST_SESSION_SECRET}`)),
    });
    for (const headers of [{}, bearer(HEALTH_SECRET)]) {
      const res = await health(app, headers);
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ status: 'degraded' });
    }
    await app.close();
  });
});

describe('límite de peticiones', () => {
  it('31 peticiones en un minuto desde la misma IP → 429 sin datos de la instancia', async () => {
    const app = await appWith({ secret: HEALTH_SECRET });
    const ip = '10.200.0.1';
    for (let i = 0; i < 30; i++) {
      expect((await health(app, {}, '/health', ip)).statusCode).toBe(200);
    }
    const limited = await health(app, bearer(HEALTH_SECRET), '/health', ip);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(limited.body).not.toMatch(/demo-01|1\.4\.0|0005_config_transfer/);
    // Otra IP sigue atendida.
    expect((await health(app)).statusCode).toBe(200);
    await app.close();
  });
});

describe('privacidad (FR-002, SC-003)', () => {
  it('ninguna respuesta tiene claves fuera del contrato', () => {
    expect(bodies.length).toBeGreaterThan(10);
    for (const body of bodies) {
      if (body === '') continue;
      for (const key of keysOf(JSON.parse(body))) expect(ALLOWED_KEYS.has(key)).toBe(true);
    }
  });

  it('ni cuerpos ni registros contienen datos prohibidos', () => {
    const forbidden = [
      ...seeded.phones,
      ...seeded.texts,
      seeded.businessName,
      HEALTH_SECRET,
      TEST_SESSION_SECRET,
      BACKUP_KEY,
      t.url,
      new URL(t.url).password,
      process.cwd(),
      '/var/lib/chatbot/backups',
    ].filter((v) => v.length >= 6);
    const everything = [...bodies, ...logLines].join('\n');
    for (const value of forbidden) expect(everything.includes(value)).toBe(false);
  });

  it('la sesión del panel no es necesaria ni se ve afectada', async () => {
    const app = await appWith({ secret: HEALTH_SECRET });
    const session = await login(app);
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { cookie: session.cookie },
      remoteAddress: nextAddress(),
    });
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
