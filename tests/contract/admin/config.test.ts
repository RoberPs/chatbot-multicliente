/**
 * Contrato de la página "Exportar e importar" (008, contracts/admin-config-transfer.md):
 * sesión, navegación y exportación.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfigFile } from '../../../src/config-transfer/parse.js';
import {
  buildTestApp,
  encodeForm,
  get,
  loggedEvents,
  login,
  postForm,
  type Session,
} from '../../helpers/app.js';
import { FULL_ALERTS, instanceEnv, seedFullBusiness } from '../../helpers/config-transfer.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

describe('Exportar e importar (/admin/config)', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;

  beforeAll(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db);
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });
  beforeEach(async () => {
    await resetDb(t.db);
    session = await login(app);
  });

  describe('sesión y navegación', () => {
    it('sin sesión: 302 al login, y con htmx 401 + HX-Redirect', async () => {
      const anon = await app.inject({ method: 'GET', url: '/admin/config' });
      expect(anon.statusCode).toBe(302);
      expect(anon.headers.location).toBe('/admin/login');

      const htmx = await app.inject({
        method: 'GET',
        url: '/admin/config',
        headers: { 'hx-request': 'true' },
      });
      expect(htmx.statusCode).toBe(401);
      expect(htmx.headers['hx-redirect']).toBe('/admin/login');
    });

    it('con sesión: 200 y Cache-Control no-store', async () => {
      const res = await get(app, session, '/admin/config');
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain('<h1>Exportar e importar</h1>');
    });

    it('la navegación de cualquier página lleva a "Exportar e importar"', async () => {
      for (const url of ['/admin', '/admin/services', '/admin/config']) {
        const res = await get(app, session, url);
        expect(res.body).toMatch(/<a href="\/admin\/config"[^>]*>Exportar e importar<\/a>/);
      }
      const page = await get(app, session, '/admin/config');
      expect(page.body).toContain(
        '<a href="/admin/config" aria-current="page">Exportar e importar</a>',
      );
    });
  });

  describe('exportar (US1)', () => {
    it('el formulario lleva la casilla desmarcada y el aviso de lo que no incluye', async () => {
      const res = await get(app, session, '/admin/config');
      expect(res.body).toContain('action="/admin/config/export"');
      expect(res.body).toMatch(
        /<input[^>]*name="include_alerts"[^>]*type="checkbox"(?![^>]*checked)[^>]*>/,
      );
      expect(res.body).toContain('Incluir los destinos de los avisos de derivación');
      expect(res.body).toContain(
        'El fichero no incluye conversaciones, clientes ni secretos de la instancia',
      );
    });

    it('sin CSRF se rechaza como el resto del panel', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/config/export',
        headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: encodeForm({}),
      });
      expect(res.statusCode).toBe(403);
    });
  });
});

describe('Exportar con INSTANCE_ID y registro (/admin/config/export)', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;
  const lines: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db, 'postgres://no-usada', null, instanceEnv('demo-01'), lines);
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });
  beforeEach(async () => {
    lines.length = 0;
    session = await login(app);
  });

  it('sin la casilla: fichero válido, sin destinos, con las cabeceras del contrato', async () => {
    await seedFullBusiness(t.deps, { alerts: FULL_ALERTS });
    const res = await postForm(app, session, '/admin/config/export');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="configuracion-demo-01-\d{8}-\d{4}\.json"$/,
    );
    const parsed = parseConfigFile(res.rawPayload, { phoneRegion: 'ES' });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(parsed.envelope.includesAlertDestinations).toBe(false);
    expect(parsed.envelope.source.instanceId).toBe('demo-01');
    expect(res.body).not.toContain('alertDestinations');
    expect(res.body).not.toContain(FULL_ALERTS.whatsapp);
    expect(parsed.document.services).toHaveLength(2);
  });

  it('con include_alerts: el fichero trae los destinos', async () => {
    await seedFullBusiness(t.deps, { alerts: FULL_ALERTS });
    const res = await postForm(app, session, '/admin/config/export', { include_alerts: 'on' });
    const parsed = parseConfigFile(res.rawPayload, { phoneRegion: 'ES' });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(parsed.envelope.includesAlertDestinations).toBe(true);
    expect(parsed.document.alertDestinations).toEqual(FULL_ALERTS);
  });

  it('con el negocio en preparación y con avisos críticos también se exporta (US1-4)', async () => {
    await resetDb(t.db);
    const res = await postForm(app, session, '/admin/config/export');
    expect(res.statusCode).toBe(200);
    const parsed = parseConfigFile(res.rawPayload, { phoneRegion: 'ES' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.envelope.info.businessStatus).toBe('draft');
  });

  it('registra config_exported con includesAlerts y los recuentos', async () => {
    await seedFullBusiness(t.deps);
    await postForm(app, session, '/admin/config/export', { include_alerts: 'on' });
    const event = loggedEvents(lines, 'config').find((l) => l.event === 'config_exported');
    expect(event).toMatchObject({
      channel: 'config',
      includesAlerts: true,
      counts: { services: 2, resources: 1, faqs: 2, alertDestinations: 1 },
    });
  });
});

describe('Exportar sin INSTANCE_ID', () => {
  let t: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db);
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it('el nombre del fichero usa "instancia"', async () => {
    const session = await login(app);
    const res = await postForm(app, session, '/admin/config/export');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="configuracion-instancia-\d{8}-\d{4}\.json"$/,
    );
  });
});
