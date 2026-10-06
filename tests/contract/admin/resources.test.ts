import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createService } from '../../../src/knowledge/services/catalog.js';
import { createResource } from '../../../src/knowledge/services/resources.js';
import { createKnowledgeReader } from '../../../src/knowledge/snapshot.js';
import {
  buildTestApp,
  fieldErrorsIn,
  get,
  login,
  postForm,
  slotFields,
  type Session,
} from '../../helpers/app.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

const MISSING = '00000000-0000-4000-8000-000000000000';

describe('recursos', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;
  let serviceA: string;
  const snapshot = () => createKnowledgeReader(t.db).getSnapshot();
  const resources = async () => {
    const s = await snapshot();
    return s.scheduling.mode === 'resources' ? s.scheduling.resources : [];
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db);
    session = await login(app);
  });
  beforeEach(async () => {
    await resetDb(t.db);
    serviceA = await createService(t.deps, {
      name: 'A',
      price_type: 'fixed',
      price: '20',
      duration: '30',
      bookable: 'on',
      active: 'on',
    });
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it('alta con servicios → 303 a su ficha', async () => {
    const res = await postForm(app, session, '/admin/resources', {
      name: 'Profesional 1',
      service_ids: [serviceA],
      active: true,
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/^\/admin\/resources\/[0-9a-f-]{36}$/);
    expect(await resources()).toMatchObject([{ name: 'Profesional 1', serviceIds: [serviceA] }]);
    const page = await get(app, session, String(res.headers.location));
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Horario de Profesional 1');
  });

  it('service_ids inexistente → 422 en service_ids y nada guardado', async () => {
    const res = await postForm(app, session, '/admin/resources', {
      name: 'Profesional 1',
      service_ids: [MISSING],
      active: true,
    });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['service_ids']);
    expect((await snapshot()).scheduling).toEqual({ mode: 'single_agenda' });
  });

  it('nombre duplicado → 422 en name', async () => {
    await createResource(t.deps, { name: 'Sala 1', active: 'on' });
    const res = await postForm(app, session, '/admin/resources', { name: 'SALA 1', active: true });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['name']);
  });

  it('edición reemplaza servicios y estado', async () => {
    const id = await createResource(t.deps, { name: 'R', service_ids: [serviceA], active: 'on' });
    const res = await postForm(app, session, `/admin/resources/${id}`, { name: 'R2' });
    expect(res.statusCode).toBe(303);
    const s = await snapshot();
    expect(s.scheduling).toEqual({ mode: 'resources', resources: [] });
    expect(s.services[0]?.bookable).toBe(false);
  });

  it('horario del recurso: válido → 303; franja inválida → 422', async () => {
    const id = await createResource(t.deps, { name: 'R', active: 'on' });
    let res = await postForm(
      app,
      session,
      `/admin/resources/${id}/hours`,
      slotFields([[1, '09:00', '14:00']]),
    );
    expect(res.statusCode).toBe(303);
    expect((await resources())[0]?.hours).toEqual([{ weekday: 1, start: '09:00', end: '14:00' }]);

    res = await postForm(
      app,
      session,
      `/admin/resources/${id}/hours`,
      slotFields([[2, '18:00', '10:00']]),
    );
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['slots[0].end']);
    expect((await resources())[0]?.hours).toHaveLength(1);
  });

  it('ausencias: alta, edición y borrado', async () => {
    const id = await createResource(t.deps, { name: 'R', active: 'on' });
    let res = await postForm(app, session, `/admin/resources/${id}/absences`, {
      start_date: '2026-08-01',
      end_date: '2026-08-07',
    });
    expect(res.statusCode).toBe(303);
    const page = await get(app, session, `/admin/resources/${id}`);
    const absenceId = new RegExp(`/admin/resources/${id}/absences/([0-9a-f-]{36})"`).exec(
      page.body,
    )?.[1];
    expect(absenceId).toBeDefined();

    res = await postForm(app, session, `/admin/resources/${id}/absences/${absenceId}`, {
      start_date: '2026-08-03',
      end_date: '2026-08-03',
      start_time: '09:00',
      end_time: '12:00',
    });
    expect(res.statusCode).toBe(303);
    expect((await resources())[0]?.absences).toEqual([
      {
        startDate: '2026-08-03',
        endDate: '2026-08-03',
        startTime: '09:00',
        endTime: '12:00',
        reason: null,
      },
    ]);

    res = await postForm(app, session, `/admin/resources/${id}/absences`, {
      start_date: '2026-08-07',
      end_date: '2026-08-01',
    });
    expect(res.statusCode).toBe(422);
    expect(fieldErrorsIn(res.body)).toEqual(['end_date']);

    res = await postForm(app, session, `/admin/resources/${id}/absences/${absenceId}/delete`);
    expect(res.statusCode).toBe(303);
    expect((await resources())[0]?.absences).toEqual([]);
  });

  it('POST /admin/resources/:id/delete borra el recurso', async () => {
    const id = await createResource(t.deps, { name: 'R', active: 'on' });
    const res = await postForm(app, session, `/admin/resources/${id}/delete`);
    expect(res.statusCode).toBe(303);
    expect((await snapshot()).scheduling).toEqual({ mode: 'single_agenda' });
  });

  it('recurso inexistente → 404', async () => {
    expect((await get(app, session, `/admin/resources/${MISSING}`)).statusCode).toBe(404);
    expect((await postForm(app, session, `/admin/resources/${MISSING}/delete`)).statusCode).toBe(
      404,
    );
    expect(
      (
        await postForm(
          app,
          session,
          `/admin/resources/${MISSING}/hours`,
          slotFields([[1, '09:00', '10:00']]),
        )
      ).statusCode,
    ).toBe(404);
  });

  it('la lista muestra estado y servicios asignados', async () => {
    await createResource(t.deps, { name: 'Profesional 1', service_ids: [serviceA], active: 'on' });
    const res = await get(app, session, '/admin/resources');
    expect(res.body).toMatch(/Profesional 1[\s\S]*<td>A<\/td>[\s\S]*Activo/);
  });
});
