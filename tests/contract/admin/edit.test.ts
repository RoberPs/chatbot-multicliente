import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClosure } from '../../../src/knowledge/services/business-info.js';
import { createService } from '../../../src/knowledge/services/catalog.js';
import { createKnowledgeReader } from '../../../src/knowledge/snapshot.js';
import { buildTestApp, get, login, postForm, type Session } from '../../helpers/app.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

const MISSING = '00000000-0000-4000-8000-000000000000';

describe('US2: edición y eliminación', () => {
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

  it('el formulario de servicio muestra los valores guardados con el importe formateado', async () => {
    const id = await createService(t.deps, {
      name: 'A',
      price_type: 'from',
      price: '20,5',
      duration: '45',
      bookable: 'on',
      active: 'on',
    });
    const res = await get(app, session, `/admin/services/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('value="20,50"');
    expect(res.body).toContain('value="45"');
    expect(res.body).toMatch(/<option value="from" selected>/);
    expect(res.body).toContain('Última modificación');
  });

  it('el formulario de cierre muestra los valores guardados', async () => {
    const id = await createClosure(t.deps, {
      start_date: '2026-12-24',
      end_date: '2026-12-24',
      start_time: '14:00',
      end_time: '20:00',
      reason: 'Nochebuena',
    });
    const res = await get(app, session, `/admin/closures/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('value="2026-12-24"');
    expect(res.body).toContain('value="14:00"');
    expect(res.body).toContain('value="Nochebuena"');
    expect(res.body).toContain(`action="/admin/closures/${id}"`);
  });

  it.each([
    ['GET', `/admin/services/${MISSING}`],
    ['GET', '/admin/services/no-es-un-id'],
    ['GET', `/admin/closures/${MISSING}`],
    ['POST', `/admin/services/${MISSING}`],
    ['POST', `/admin/services/${MISSING}/delete`],
    ['POST', `/admin/closures/${MISSING}/delete`],
  ])('%s %s inexistente → 404', async (method, url) => {
    const res =
      method === 'GET'
        ? await get(app, session, url)
        : await postForm(app, session, url, {
            name: 'X',
            price_type: 'fixed',
            price: '1',
            start_date: '2026-01-01',
            end_date: '2026-01-01',
          });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('no existe');
  });

  it('solo se elimina por POST …/delete', async () => {
    const id = await createService(t.deps, { name: 'A', price_type: 'on_request', active: 'on' });
    const res = await get(app, session, `/admin/services/${id}/delete`);
    expect(res.statusCode).toBe(404);
    expect((await createKnowledgeReader(t.db).getSnapshot()).services).toHaveLength(1);
  });

  it('un 422 en edición no modifica el dato guardado', async () => {
    const id = await createService(t.deps, {
      name: 'A',
      price_type: 'fixed',
      price: '20',
      duration: '30',
      active: 'on',
    });
    const res = await postForm(app, session, `/admin/services/${id}`, {
      name: 'A cambiado',
      price_type: 'fixed',
      price: '-5',
      duration: '30',
      active: true,
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('value="A cambiado"');
    const [s] = (await createKnowledgeReader(t.db).getSnapshot()).services;
    expect(s).toMatchObject({ name: 'A', price: { type: 'fixed', amountCents: 2000 } });
  });
});
