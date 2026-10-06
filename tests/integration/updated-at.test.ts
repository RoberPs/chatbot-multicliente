/** Cada escritura actualiza `updated_at` y hace avanzar `snapshot.updatedAt` (supuesto de la spec). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createClosure,
  deleteClosure,
  saveBusiness,
  saveBusinessHours,
  updateClosure,
} from '../../src/knowledge/services/business-info.js';
import {
  createService,
  deleteService,
  reorderServices,
  updateService,
} from '../../src/knowledge/services/catalog.js';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import { withReadSnapshot } from '../../src/db/client.js';
import { loadKnowledgeState } from '../../src/knowledge/state.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const service = (name: string, price = '20') => ({
  name,
  price_type: 'fixed',
  price,
  duration: '30',
  bookable: 'on',
  active: 'on',
});

describe('updated_at en negocio, horario, cierres y servicios', () => {
  let t: TestDatabase;
  let last = '';

  const advances = async (write: () => Promise<unknown>) => {
    await write();
    const { updatedAt } = await createKnowledgeReader(t.db).getSnapshot();
    expect(updatedAt > last, `${updatedAt} debería ser posterior a ${last}`).toBe(true);
    expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    last = updatedAt;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    last = (await createKnowledgeReader(t.db).getSnapshot()).updatedAt;
  });
  afterAll(async () => {
    await t.close();
  });

  it('cada guardado hace avanzar snapshot.updatedAt', async () => {
    const deps = t.deps;
    await advances(() =>
      saveBusiness(deps, { name: 'N', timezone: 'Europe/Madrid', currency: 'EUR' }),
    );
    await advances(() =>
      saveBusinessHours(deps, { slots: [{ weekday: '1', start: '09:00', end: '14:00' }] }),
    );
    await advances(() => saveBusinessHours(deps, { slots: [] }));
    let closureId = '';
    await advances(async () => {
      closureId = await createClosure(deps, { start_date: '2026-12-25', end_date: '2026-12-25' });
    });
    await advances(() =>
      updateClosure(deps, closureId, { start_date: '2026-12-26', end_date: '2026-12-26' }),
    );
    await advances(() => deleteClosure(deps, closureId));
    let a = '';
    let b = '';
    await advances(async () => {
      a = await createService(deps, service('A'));
    });
    await advances(async () => {
      b = await createService(deps, service('B'));
    });
    await advances(() => updateService(deps, a, service('A', '25')));
    await advances(() => reorderServices(deps, { ids: [b, a] }));
    await advances(() => deleteService(deps, b));
  });

  it('la fila modificada tiene su propio updated_at', async () => {
    const before = await withReadSnapshot(t.db, loadKnowledgeState);
    const [a] = before.services;
    await updateService(t.deps, a?.id ?? '', service('A', '30'));
    const after = await withReadSnapshot(t.db, loadKnowledgeState);
    expect((after.services[0]?.updatedAt ?? '') > (a?.updatedAt ?? '')).toBe(true);
    expect(after.business.updatedAt).toBe(before.business.updatedAt);
  });
});
