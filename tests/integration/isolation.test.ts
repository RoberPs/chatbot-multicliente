/** FR-022: cada instancia solo ve su propia base de datos. */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import { buildTestApp, get, login, postForm, type Session } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

describe('aislamiento entre instancias', () => {
  let a: TestDatabase;
  let b: TestDatabase;
  let appA: FastifyInstance;
  let appB: FastifyInstance;
  let sessionA: Session;
  let sessionB: Session;

  beforeAll(async () => {
    a = await createTestDatabase();
    b = await createTestDatabase();
    appA = await buildTestApp(a.db, a.url);
    appB = await buildTestApp(b.db, b.url);
    sessionA = await login(appA);
    sessionB = await login(appB);
  });
  afterAll(async () => {
    await appA.close();
    await appB.close();
    await a.close();
    await b.close();
  });

  it('un servicio registrado en A no aparece en el snapshot ni en el panel de B', async () => {
    const res = await postForm(appA, sessionA, '/admin/services', {
      name: 'Solo de la instancia A',
      price_type: 'on_request',
      active: true,
    });
    expect(res.statusCode).toBe(303);

    expect((await createKnowledgeReader(a.db).getSnapshot()).services.map((s) => s.name)).toEqual([
      'Solo de la instancia A',
    ]);
    expect((await createKnowledgeReader(b.db).getSnapshot()).services).toEqual([]);
    expect((await get(appB, sessionB, '/admin/services')).body).not.toContain(
      'Solo de la instancia A',
    );
    expect((await get(appA, sessionA, '/admin/services')).body).toContain('Solo de la instancia A');
  });
});
