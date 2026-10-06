/**
 * Versión en el pie del panel (009, FR-007, research R7): núcleo y esquema en todas las páginas
 * tras iniciar sesión, con distintivo si el esquema no es el esperado y «Versión no disponible» si
 * el informe falla; nunca en la página de login.
 */
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { installedSchema } from '../../../src/backup/schema-version.js';
import { createLifecycle } from '../../../src/health/lifecycle.js';
import type { HealthReport } from '../../../src/health/report.js';
import { buildTestApp, get, login } from '../../helpers/app.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const schema = installedSchema();

let t: TestDatabase;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  t = await createTestDatabase();
  await resetDb(t.db);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

afterAll(async () => {
  await t.close();
});

const footer = (html: string): string => {
  const match = /<footer class="version"[^>]*>([\s\S]*?)<\/footer>/.exec(html);
  return (match?.[1] ?? '').replace(/\s+/g, ' ').trim();
};

describe('pie del panel con la versión', () => {
  it('con la instancia real: «Núcleo <package.json> · Esquema <última migración>» en cada página', async () => {
    app = await buildTestApp(t.db, t.url);
    const session = await login(app);
    for (const url of ['/admin', '/admin/business', '/admin/no-existe']) {
      const res = await get(app, session, url);
      const text = footer(res.body);
      expect(text).toContain(`Núcleo ${pkg.version} · Esquema ${schema.tag}`);
      expect(text).not.toContain('Esquema distinto del esperado');
    }
  });

  it('esquema distinto del esperado → distintivo', async () => {
    const report: HealthReport = {
      status: 'degraded',
      coreVersion: '1.3.0',
      schema: { applied: { index: 6, tag: null }, expected: { index: 5, tag: schema.tag } },
      spendCap: null,
    };
    app = await buildTestApp(t.db, t.url, null, {}, undefined, {
      health: { lifecycle: createLifecycle(), report: () => Promise.resolve(report) },
    });
    const session = await login(app);
    const text = footer((await get(app, session, '/admin')).body);
    expect(text).toContain('Núcleo 1.3.0');
    expect(text).toContain('Esquema distinto del esperado');
  });

  it('si el informe falla, la página se sirve con «Versión no disponible»', async () => {
    app = await buildTestApp(t.db, t.url, null, {}, undefined, {
      health: {
        lifecycle: createLifecycle(),
        report: () => Promise.reject(new Error('sin BD')),
      },
    });
    const session = await login(app);
    const res = await get(app, session, '/admin');
    expect(res.statusCode).toBe(200);
    expect(footer(res.body)).toBe('Versión no disponible');
  });

  it('la página de login no muestra la versión', async () => {
    app = await buildTestApp(t.db, t.url);
    const res = await app.inject({ method: 'GET', url: '/admin/login' });
    expect(res.body).not.toContain('Núcleo ');
    expect(res.body).not.toContain('class="version"');
  });
});
