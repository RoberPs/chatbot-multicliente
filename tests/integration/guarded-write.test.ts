import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivationBlockedError, CriticalWarningError } from '../../src/knowledge/errors.js';
import { saveBusiness } from '../../src/knowledge/services/business-info.js';
import {
  activateBusiness,
  deactivateBusiness,
} from '../../src/knowledge/services/business-status.js';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../helpers/db.js';

const business = (phone: string) => ({
  name: 'Negocio',
  phone,
  timezone: 'Europe/Madrid',
  currency: 'EUR',
});

describe('guardado protegido y activación (FR-031, FR-032)', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  beforeEach(async () => {
    await resetDb(t.db);
  });
  afterAll(async () => {
    await t.close();
  });

  it('instancia nueva: activar → ActivationBlockedError con HANDOFF_UNREACHABLE y sigue en draft', async () => {
    const error = await activateBusiness(t.db).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActivationBlockedError);
    expect((error as ActivationBlockedError).warnings.map((w) => w.code)).toEqual([
      'HANDOFF_UNREACHABLE',
    ]);
    expect((await createKnowledgeReader(t.db).getSnapshot()).status).toBe('draft');
  });

  it('negocio activo sin derivación: vaciar el teléfono se revierte', async () => {
    await saveBusiness(t.deps, business('600123456'));
    await activateBusiness(t.db);

    const error = await saveBusiness(t.deps, business('')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CriticalWarningError);
    expect((error as CriticalWarningError).warnings[0]?.code).toBe('HANDOFF_UNREACHABLE');

    const snapshot = await createKnowledgeReader(t.db).getSnapshot();
    expect(snapshot.business.phone).toBe('+34600123456');
    expect(snapshot.status).toBe('active');
    expect(snapshot.handoff.source).toBe('business_phone');
  });

  it('negocio activo: los cambios que no provocan avisos críticos se guardan', async () => {
    await saveBusiness(t.deps, business('600123456'));
    await activateBusiness(t.db);
    await saveBusiness(t.deps, { ...business('600123456'), name: 'Otro nombre' });
    expect((await createKnowledgeReader(t.db).getSnapshot()).business.name).toBe('Otro nombre');
  });

  it('desactivar siempre funciona y después el cambio se guarda con el aviso crítico', async () => {
    await saveBusiness(t.deps, business('600123456'));
    await activateBusiness(t.db);
    await deactivateBusiness(t.db);
    await deactivateBusiness(t.db);
    await saveBusiness(t.deps, business(''));
    const snapshot = await createKnowledgeReader(t.db).getSnapshot();
    expect(snapshot.status).toBe('draft');
    expect(snapshot.business.phone).toBeNull();
    expect(snapshot.handoff.source).toBe('none');
  });

  it('las escrituras concurrentes se serializan y el estado final es coherente', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        saveBusiness(t.deps, { ...business('600123456'), name: `N${i}` }),
      ),
    );
    expect((await createKnowledgeReader(t.db).getSnapshot()).business.name).toMatch(/^N[0-4]$/);
  });
});
