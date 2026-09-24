import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { saveBusiness } from '../../../src/knowledge/services/business-info.js';
import { createKnowledgeReader } from '../../../src/knowledge/snapshot.js';
import { buildTestApp, get, login, postForm, type Session } from '../../helpers/app.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

const codesIn = (html: string) => [...html.matchAll(/data-code="([A-Z_]+)"/g)].map((m) => m[1]);

describe('US5: avisos en el panel', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;

  beforeAll(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db);
    session = await login(app);
  });
  beforeEach(async () => {
    await resetDb(t.db);
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it('servicio reservable sin duración → 303, guardado y aviso; al completar desaparece', async () => {
    let res = await postForm(app, session, '/admin/services', {
      name: 'Corte',
      price_type: 'fixed',
      price: '15',
      duration: '',
      bookable: true,
      active: true,
    });
    expect(res.statusCode).toBe(303);
    const [service] = (await createKnowledgeReader(t.db).getSnapshot()).services;
    expect(service).toMatchObject({ name: 'Corte', bookable: false, durationMinutes: null });

    let home = await get(app, session, '/admin');
    expect(codesIn(home.body)).toContain('SERVICE_DURATION_MISSING');
    expect(home.body).toContain(`href="/admin/services/${service?.id}">Corregir`);

    const list = await get(app, session, '/admin/services');
    expect(codesIn(list.body)).toEqual(['SERVICE_DURATION_MISSING']);

    res = await postForm(app, session, `/admin/services/${service?.id}`, {
      name: 'Corte',
      price_type: 'fixed',
      price: '15',
      duration: '30',
      bookable: true,
      active: true,
    });
    expect(res.statusCode).toBe(303);
    home = await get(app, session, '/admin');
    expect(codesIn(home.body)).not.toContain('SERVICE_DURATION_MISSING');
  });

  it('el contador de la cabecera coincide con la lista de la portada', async () => {
    await postForm(app, session, '/admin/services', {
      name: 'X',
      price_type: 'fixed',
      bookable: true,
      active: true,
    });
    const home = await get(app, session, '/admin');
    const listed =
      /<ul class="warnings" id="warnings-list">([\s\S]*?)<\/ul>/.exec(home.body)?.[1] ?? '';
    const count = codesIn(listed).length;
    expect(count).toBe(4);
    expect(home.body).toContain(`Avisos: ${count} (1 crítico)`);
  });

  it('activar con solo avisos normales → activo', async () => {
    await saveBusiness(t.deps, {
      name: 'N',
      phone: '600123456',
      timezone: 'Europe/Madrid',
      currency: 'EUR',
    });
    await postForm(app, session, '/admin/services', {
      name: 'X',
      price_type: 'fixed',
      bookable: true,
      active: true,
    });
    const res = await postForm(app, session, '/admin/status/activate');
    expect(res.statusCode).toBe(303);
    expect((await createKnowledgeReader(t.db).getSnapshot()).status).toBe('active');
  });

  it('la página de derivación muestra sus avisos', async () => {
    const res = await get(app, session, '/admin/handoff');
    expect(codesIn(res.body)).toEqual(['HANDOFF_UNREACHABLE']);
  });

  it('un guardado htmx devuelve HX-Location para refrescar la página con los avisos', async () => {
    const res = await postForm(
      app,
      session,
      '/admin/services',
      { name: 'Y', price_type: 'on_request', active: true },
      { 'hx-request': 'true' },
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['hx-location']).toBe('/admin/services');
  });
});
