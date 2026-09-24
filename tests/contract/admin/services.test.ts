import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createService } from '../../../src/knowledge/services/catalog.js';
import { createKnowledgeReader } from '../../../src/knowledge/snapshot.js';
import {
  buildTestApp,
  fieldErrorsIn,
  get,
  login,
  postForm,
  type Session,
} from '../../helpers/app.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

const serviceA = {
  name: 'A',
  price_type: 'fixed',
  price: '20',
  duration: '30',
  bookable: true,
  active: true,
};

describe('servicios', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;
  const snapshot = () => createKnowledgeReader(t.db).getSnapshot();

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

  it('alta de los tres tipos de precio → 303', async () => {
    for (const fields of [
      serviceA,
      { name: 'B', price_type: 'from', price: '40', duration: '60', bookable: true, active: true },
      { name: 'C', price_type: 'on_request', price: '', duration: '', active: true },
    ]) {
      const res = await postForm(app, session, '/admin/services', fields);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/admin/services');
    }
    expect((await snapshot()).services.map((s) => [s.name, s.price])).toEqual([
      ['A', { type: 'fixed', amountCents: 2000 }],
      ['B', { type: 'from', amountCents: 4000 }],
      ['C', { type: 'on_request' }],
    ]);
  });

  it('precio -5 → 422 con error en price', async () => {
    const res = await postForm(app, session, '/admin/services', { ...serviceA, price: '-5' });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['price']);
    expect((await snapshot()).services).toEqual([]);
  });

  it('nombre duplicado sin distinguir mayúsculas → 422 en name', async () => {
    await postForm(app, session, '/admin/services', serviceA);
    const res = await postForm(app, session, '/admin/services', { ...serviceA, name: 'a' });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['name']);
    expect(res.body).toContain('Ya existe un servicio con ese nombre');
  });

  it('POST /admin/services/reorder cambia el orden', async () => {
    const a = await createService(t.deps, { ...serviceA, name: 'A' });
    const b = await createService(t.deps, { ...serviceA, name: 'B' });
    const res = await postForm(app, session, '/admin/services/reorder', { ids: [b, a] });
    expect(res.statusCode).toBe(303);
    expect((await snapshot()).services.map((s) => s.name)).toEqual(['B', 'A']);
  });

  it('reorder con un id inexistente → 404 y sin cambios', async () => {
    const a = await createService(t.deps, { ...serviceA, name: 'A' });
    const res = await postForm(app, session, '/admin/services/reorder', {
      ids: ['00000000-0000-4000-8000-000000000000', a],
    });
    expect(res.statusCode).toBe(404);
  });

  it('la lista muestra precio formateado, duración, reservable y estado', async () => {
    await postForm(app, session, '/admin/services', { ...serviceA, price: '20,5' });
    const res = await get(app, session, '/admin/services');
    expect(res.body).toMatch(/20,50\s€/);
    expect(res.body).toContain('30 min');
    expect(res.body).toContain('Activo');
  });
});
