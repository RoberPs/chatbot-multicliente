import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createKnowledgeReader } from '../../../src/knowledge/snapshot.js';
import {
  buildTestApp,
  fieldErrorsIn,
  get,
  login,
  postForm,
  slotFields,
  TYPICAL_WEEK,
  type Session,
} from '../../helpers/app.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

describe('horario y cierres', () => {
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

  it('POST /admin/hours reemplaza toda la semana', async () => {
    let res = await postForm(app, session, '/admin/hours', slotFields(TYPICAL_WEEK));
    expect(res.statusCode).toBe(303);
    expect((await snapshot()).openingHours).toHaveLength(11);

    res = await postForm(app, session, '/admin/hours', slotFields([[1, '10:00', '12:00']]));
    expect(res.statusCode).toBe(303);
    expect((await snapshot()).openingHours).toEqual([{ weekday: 1, start: '10:00', end: '12:00' }]);
  });

  it('las filas vacías del formulario se ignoran', async () => {
    const res = await postForm(app, session, '/admin/hours', {
      ...slotFields([[1, '09:00', '14:00']]),
      'slots[5].weekday': '2',
      'slots[5].start': '',
      'slots[5].end': '',
    });
    expect(res.statusCode).toBe(303);
    expect((await snapshot()).openingHours).toHaveLength(1);
  });

  it('franja 14:00–09:00 → 422 con error en slots[i].end y nada guardado', async () => {
    await postForm(app, session, '/admin/hours', slotFields(TYPICAL_WEEK));
    const res = await postForm(
      app,
      session,
      '/admin/hours',
      slotFields([
        [1, '09:00', '10:00'],
        [2, '14:00', '09:00'],
      ]),
    );
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['slots[1].end']);
    expect(res.body).toContain('value="14:00"');
    expect((await snapshot()).openingHours).toHaveLength(11);
  });

  it('franjas solapadas → 422', async () => {
    const res = await postForm(
      app,
      session,
      '/admin/hours',
      slotFields([
        [3, '09:00', '14:00'],
        [3, '12:00', '16:00'],
      ]),
    );
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['slots[1]']);
  });

  it('cierres: alta, edición y borrado', async () => {
    let res = await postForm(app, session, '/admin/closures', {
      start_date: '2026-12-25',
      end_date: '2026-12-25',
      reason: 'Navidad',
    });
    expect(res.statusCode).toBe(303);
    const page = await get(app, session, '/admin/hours');
    const id = /\/admin\/closures\/([0-9a-f-]{36})"/.exec(page.body)?.[1];
    expect(id).toBeDefined();

    res = await postForm(app, session, `/admin/closures/${id}`, {
      start_date: '2026-12-24',
      end_date: '2026-12-24',
      start_time: '14:00',
      end_time: '20:00',
      reason: 'Nochebuena',
    });
    expect(res.statusCode).toBe(303);
    expect((await snapshot()).closures).toEqual([
      {
        startDate: '2026-12-24',
        endDate: '2026-12-24',
        startTime: '14:00',
        endTime: '20:00',
        reason: 'Nochebuena',
      },
    ]);

    res = await postForm(app, session, `/admin/closures/${id}/delete`);
    expect(res.statusCode).toBe(303);
    expect((await snapshot()).closures).toEqual([]);
  });

  it('cierre con fecha fin anterior → 422 con error en end_date', async () => {
    const res = await postForm(app, session, '/admin/closures', {
      start_date: '2026-08-15',
      end_date: '2026-08-01',
    });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['end_date']);
    expect((await snapshot()).closures).toEqual([]);
  });
});
