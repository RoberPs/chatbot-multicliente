import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFaq } from '../../../src/knowledge/services/faqs.js';
import { createKnowledgeReader } from '../../../src/knowledge/snapshot.js';
import { buildTestApp, fieldErrorsIn, login, postForm, type Session } from '../../helpers/app.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

describe('/admin/faqs', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;
  const faqs = async () => (await createKnowledgeReader(t.db).getSnapshot()).faqs;

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

  it('alta → 303; sin respuesta → 422 en answer', async () => {
    let res = await postForm(app, session, '/admin/faqs', {
      question: '¿Hay aparcamiento?',
      answer: 'Sí, gratuito.',
    });
    expect(res.statusCode).toBe(303);
    res = await postForm(app, session, '/admin/faqs', { question: '¿Otra?', answer: '' });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['answer']);
    expect(await faqs()).toEqual([{ question: '¿Hay aparcamiento?', answer: 'Sí, gratuito.' }]);
  });

  it('edición, reorden y borrado', async () => {
    const a = await createFaq(t.deps, { question: 'P1', answer: 'R1' });
    const b = await createFaq(t.deps, { question: 'P2', answer: 'R2' });

    let res = await postForm(app, session, `/admin/faqs/${a}`, {
      question: 'P1 editada',
      answer: 'R1',
    });
    expect(res.statusCode).toBe(303);

    res = await postForm(app, session, `/admin/faqs/${a}`, { question: '', answer: 'R1' });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['question']);

    res = await postForm(app, session, '/admin/faqs/reorder', { ids: [b, a] });
    expect(res.statusCode).toBe(303);
    expect((await faqs()).map((f) => f.question)).toEqual(['P2', 'P1 editada']);

    res = await postForm(app, session, `/admin/faqs/${b}/delete`);
    expect(res.statusCode).toBe(303);
    expect((await faqs()).map((f) => f.question)).toEqual(['P1 editada']);
  });
});
