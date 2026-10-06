/** Recursos contra PostgreSQL real: SC-006, cascadas, activar/desactivar y updated_at. */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resourceAbsence, resourceHours, resourceService } from '../../src/db/schema.js';
import { createService, deleteService } from '../../src/knowledge/services/catalog.js';
import {
  createAbsence,
  createResource,
  deleteAbsence,
  deleteResource,
  saveResourceHours,
  updateAbsence,
  updateResource,
} from '../../src/knowledge/services/resources.js';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import type { KnowledgeSnapshot } from '../../src/knowledge/types.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../helpers/db.js';

const svc = (name: string) => ({
  name,
  price_type: 'fixed',
  price: '20',
  duration: '30',
  bookable: 'on',
  active: 'on',
});
const resourcesOf = (s: KnowledgeSnapshot) =>
  s.scheduling.mode === 'resources' ? s.scheduling.resources : [];

describe('US3: recursos', () => {
  let t: TestDatabase;
  const snapshot = () => createKnowledgeReader(t.db).getSnapshot();

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  beforeEach(async () => {
    await resetDb(t.db);
  });
  afterAll(async () => {
    await t.close();
  });

  it('SC-006: un recurso con A y B no figura para C', async () => {
    const a = await createService(t.deps, svc('A'));
    const b = await createService(t.deps, svc('B'));
    const c = await createService(t.deps, svc('C'));
    const r = await createResource(t.deps, {
      name: 'Profesional 1',
      service_ids: [a, b],
      active: 'on',
    });
    await createResource(t.deps, { name: 'Profesional 2', active: 'on' });

    const s = await snapshot();
    expect(s.scheduling.mode).toBe('resources');
    expect(resourcesOf(s).find((x) => x.id === r)?.serviceIds).toEqual([a, b]);
    expect(s.services.find((x) => x.id === c)).toMatchObject({ resourceIds: [], bookable: false });
    expect(s.services.find((x) => x.id === a)).toMatchObject({ resourceIds: [r], bookable: true });
  });

  it('borrar un servicio borra sus asociaciones', async () => {
    const a = await createService(t.deps, svc('A'));
    const r = await createResource(t.deps, { name: 'R', service_ids: [a], active: 'on' });
    await deleteService(t.deps, a);
    expect(
      await t.db.select().from(resourceService).where(eq(resourceService.resourceId, r)),
    ).toEqual([]);
    expect(resourcesOf(await snapshot())[0]?.serviceIds).toEqual([]);
  });

  it('borrar un recurso borra asociaciones, horario y ausencias', async () => {
    const a = await createService(t.deps, svc('A'));
    const r = await createResource(t.deps, { name: 'R', service_ids: [a], active: 'on' });
    await saveResourceHours(t.deps, r, { slots: [{ weekday: '1', start: '09:00', end: '14:00' }] });
    await createAbsence(t.deps, r, { start_date: '2026-08-01', end_date: '2026-08-07' });
    await deleteResource(t.deps, r);
    expect(await t.db.select().from(resourceService)).toEqual([]);
    expect(await t.db.select().from(resourceHours)).toEqual([]);
    expect(await t.db.select().from(resourceAbsence)).toEqual([]);
    expect((await snapshot()).scheduling).toEqual({ mode: 'single_agenda' });
  });

  it('desactivar y reactivar conserva servicios, horario y ausencias', async () => {
    const a = await createService(t.deps, svc('A'));
    const r = await createResource(t.deps, { name: 'R', service_ids: [a], active: 'on' });
    await saveResourceHours(t.deps, r, { slots: [{ weekday: '3', start: '09:00', end: '14:00' }] });
    await createAbsence(t.deps, r, { start_date: '2026-08-01', end_date: '2026-08-07' });

    await updateResource(t.deps, r, { name: 'R', service_ids: [a] });
    let s = await snapshot();
    expect(s.scheduling).toEqual({ mode: 'resources', resources: [] });
    expect(s.services[0]?.bookable).toBe(false);

    await updateResource(t.deps, r, { name: 'R', service_ids: [a], active: 'on' });
    s = await snapshot();
    expect(resourcesOf(s)).toEqual([
      {
        id: r,
        name: 'R',
        serviceIds: [a],
        hours: [{ weekday: 3, start: '09:00', end: '14:00' }],
        absences: [
          {
            startDate: '2026-08-01',
            endDate: '2026-08-07',
            startTime: null,
            endTime: null,
            reason: null,
          },
        ],
      },
    ]);
    expect(s.services[0]?.bookable).toBe(true);
  });

  it('cada escritura de recursos hace avanzar snapshot.updatedAt', async () => {
    let last = (await snapshot()).updatedAt;
    const advances = async (write: () => Promise<unknown>) => {
      await write();
      const now = (await snapshot()).updatedAt;
      expect(now > last).toBe(true);
      last = now;
    };
    const a = await createService(t.deps, svc('A'));
    last = (await snapshot()).updatedAt;
    let r = '';
    let absence = '';
    await advances(async () => {
      r = await createResource(t.deps, { name: 'R', active: 'on' });
    });
    await advances(() => updateResource(t.deps, r, { name: 'R', service_ids: [a], active: 'on' }));
    await advances(() => updateResource(t.deps, r, { name: 'R', service_ids: [], active: 'on' }));
    await advances(() =>
      saveResourceHours(t.deps, r, { slots: [{ weekday: '1', start: '09:00', end: '10:00' }] }),
    );
    await advances(() => saveResourceHours(t.deps, r, { slots: [] }));
    await advances(async () => {
      absence = await createAbsence(t.deps, r, {
        start_date: '2026-08-01',
        end_date: '2026-08-01',
      });
    });
    await advances(() =>
      updateAbsence(t.deps, r, absence, { start_date: '2026-08-02', end_date: '2026-08-02' }),
    );
    await advances(() => deleteAbsence(t.deps, r, absence));
    await advances(() => deleteResource(t.deps, r));
  });
});
