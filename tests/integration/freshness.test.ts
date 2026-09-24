/**
 * Frescura (FR-020, FR-021, SC-003): un lector creado antes de los cambios —como una
 * conversación ya abierta— ve el dato nuevo en la siguiente lectura, sin reinicio.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import {
  buildTestApp,
  get,
  login,
  postForm,
  slotFields,
  TYPICAL_WEEK,
  type Session,
} from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

describe('US2: los cambios se aplican en la siguiente lectura del bot', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;

  beforeAll(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db);
    session = await login(app);
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it('precio, horario y borrado se reflejan sin reiniciar', async () => {
    await postForm(app, session, '/admin/hours', slotFields(TYPICAL_WEEK));
    await postForm(app, session, '/admin/services', {
      name: 'A',
      price_type: 'fixed',
      price: '20',
      duration: '30',
      bookable: true,
      active: true,
    });
    await postForm(app, session, '/admin/services', {
      name: 'B',
      price_type: 'from',
      price: '40',
      duration: '60',
      bookable: true,
      active: true,
    });

    // "Conversación abierta": el lector existe antes de los cambios.
    const reader = createKnowledgeReader(t.db);
    const before = await reader.getSnapshot();
    expect(before.services.find((s) => s.name === 'A')?.price).toEqual({
      type: 'fixed',
      amountCents: 2000,
    });

    const list = await get(app, session, '/admin/services');
    const idOf = (name: string) =>
      new RegExp(`/admin/services/([0-9a-f-]{36})">${name}<`).exec(list.body)?.[1] ?? '';

    let res = await postForm(app, session, `/admin/services/${idOf('A')}`, {
      name: 'A',
      price_type: 'fixed',
      price: '25',
      duration: '30',
      bookable: true,
      active: true,
    });
    expect(res.statusCode).toBe(303);
    const monday = TYPICAL_WEEK.filter(([d]) => d !== 1);
    res = await postForm(
      app,
      session,
      '/admin/hours',
      slotFields([[1, '10:00', '18:00'], ...monday]),
    );
    expect(res.statusCode).toBe(303);

    const after = await reader.getSnapshot();
    expect(after.services.find((s) => s.name === 'A')?.price).toEqual({
      type: 'fixed',
      amountCents: 2500,
    });
    expect(after.openingHours.filter((s) => s.weekday === 1)).toEqual([
      { weekday: 1, start: '10:00', end: '18:00' },
    ]);

    res = await postForm(app, session, `/admin/services/${idOf('B')}/delete`);
    expect(res.statusCode).toBe(303);
    expect((await reader.getSnapshot()).services.map((s) => s.name)).toEqual(['A']);
  });
});
