import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { saveBusiness } from '../../src/knowledge/services/business-info.js';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import { buildTestApp, get, login, postForm, type Session } from '../helpers/app.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../helpers/db.js';

describe('estado del negocio (FR-029 – FR-031)', () => {
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

  it('la portada muestra estado y avisos de una instancia nueva', async () => {
    const res = await get(app, session, '/admin');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('En preparación');
    expect(res.body).toContain('data-code="HANDOFF_UNREACHABLE"');
    expect(res.body).toContain('data-code="BUSINESS_HOURS_MISSING"');
    expect(res.body).toContain('Avisos: 2 (1 crítico)');
  });

  it('activar con HANDOFF_UNREACHABLE → 409, lista de bloqueo y sigue en draft', async () => {
    const res = await postForm(app, session, '/admin/status/activate');
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('No se puede activar');
    expect(res.body).toMatch(/general-error[\s\S]*data-code="HANDOFF_UNREACHABLE"/);
    expect((await createKnowledgeReader(t.db).getSnapshot()).status).toBe('draft');
  });

  it('activar con solo avisos normales → 303 y activo; desactivar → draft', async () => {
    await saveBusiness(t.deps, {
      name: 'N',
      phone: '600123456',
      timezone: 'Europe/Madrid',
      currency: 'EUR',
    });
    const res = await postForm(app, session, '/admin/status/activate');
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/admin');
    const reader = createKnowledgeReader(t.db);
    expect((await reader.getSnapshot()).status).toBe('active');
    expect((await get(app, session, '/admin')).body).toContain('Activo');

    const off = await postForm(app, session, '/admin/status/deactivate');
    expect(off.statusCode).toBe(303);
    expect((await reader.getSnapshot()).status).toBe('draft');
  });
});
