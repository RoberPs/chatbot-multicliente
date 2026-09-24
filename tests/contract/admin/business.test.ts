import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKnowledgeReader } from '../../../src/knowledge/snapshot.js';
import {
  buildTestApp,
  cookieHeader,
  fieldErrorsIn,
  get,
  login,
  postForm,
  type Session,
} from '../../helpers/app.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

const valid = {
  name: 'Mi negocio',
  address: 'Calle Mayor 1',
  directions: 'Junto a la plaza',
  phone: '600 123 456',
  email: 'info@ejemplo.es',
  timezone: 'Europe/Madrid',
  currency: 'EUR',
};

describe('POST /admin/business', () => {
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

  it('válido → 303 a la página con "Guardado"', async () => {
    const res = await postForm(app, session, '/admin/business', valid);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/admin/business');
    const snapshot = await createKnowledgeReader(t.db).getSnapshot();
    expect(snapshot.business).toMatchObject({ name: 'Mi negocio', phone: '+34600123456' });
  });

  it('con htmx → 200 y HX-Location', async () => {
    const res = await postForm(app, session, '/admin/business', valid, { 'hx-request': 'true' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['hx-location']).toBe('/admin/business');
  });

  it('email foo@ → 422 con error en email, valores conservados y nada guardado', async () => {
    const res = await postForm(app, session, '/admin/business', { ...valid, email: 'foo@' });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['email']);
    expect(res.body).toContain('value="foo@"');
    expect(res.body).toContain('value="Calle Mayor 1"');
    expect((await createKnowledgeReader(t.db).getSnapshot()).business.name).toBe('');
  });

  it('teléfono inválido → 422 con error en phone', async () => {
    const res = await postForm(app, session, '/admin/business', { ...valid, phone: '12' });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['phone']);
  });

  it('GET muestra los datos guardados y el aviso "Guardado" una sola vez', async () => {
    const saved = await postForm(app, session, '/admin/business', valid);
    const next = { ...session, cookie: cookieHeader(saved) ?? session.cookie };
    const res = await get(app, next, '/admin/business');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('value="+34600123456"');
    expect(res.body).toContain('class="flash" role="status">Guardado');
    const again = await get(
      app,
      { ...next, cookie: cookieHeader(res) ?? next.cookie },
      '/admin/business',
    );
    expect(again.body).not.toContain('class="flash"');
  });
});
