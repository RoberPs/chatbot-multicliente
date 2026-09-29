/** SC-005, FR-024, Principio I: negocios de tres sectores con el mismo modelo, sin campos extra. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activateBusiness } from '../../src/knowledge/services/business-status.js';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import { withReadSnapshot } from '../../src/db/client.js';
import { loadKnowledgeState } from '../../src/knowledge/state.js';
import { computeWarnings } from '../../src/knowledge/warnings.js';
import { allFixtures, loadFixture } from '../fixtures/load.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../helpers/db.js';

describe('neutralidad sectorial', () => {
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

  it.each(allFixtures.map((f) => [f.sector, f] as const))(
    '%s se carga con el modelo común y produce un snapshot válido',
    async (_sector, fixture) => {
      await loadFixture(t.deps, fixture);
      await activateBusiness(t.db);
      const snap = await createKnowledgeReader(t.db).getSnapshot();

      expect(snap.status).toBe('active');
      expect(snap.business.name).toBe(fixture.business.name);
      expect(snap.openingHours).toHaveLength(fixture.hours.length);
      expect(snap.services).toHaveLength(fixture.services.filter((s) => s.active === 'on').length);
      expect(snap.faqs).toHaveLength(fixture.faqs.length);
      expect(snap.handoff.source).not.toBe('none');
      if (fixture.resources.length === 0) {
        expect(snap.scheduling).toEqual({ mode: 'single_agenda' });
      } else {
        expect(snap.scheduling.mode).toBe('resources');
      }

      const warnings = computeWarnings(await withReadSnapshot(t.db, loadKnowledgeState));
      expect(warnings.filter((w) => w.severity === 'critical')).toEqual([]);
    },
  );

  it('el taller sin contacto propio deriva al teléfono del negocio y avisa del importe que falta', async () => {
    const workshop = allFixtures.find((f) => f.sector === 'taller mecánico');
    if (!workshop) throw new Error('falta fixture');
    await loadFixture(t.deps, workshop);
    const snap = await createKnowledgeReader(t.db).getSnapshot();
    expect(snap.handoff).toEqual({
      source: 'business_phone',
      channels: [{ type: 'phone', value: '+34976555010' }],
      hours: [],
    });
    expect(snap.services.find((s) => s.name === 'Diagnosis electrónica')?.price).toEqual({
      type: 'missing',
    });
    const codes = computeWarnings(await withReadSnapshot(t.db, loadKnowledgeState)).map(
      (w) => w.code,
    );
    // 005: sin destinos de avisos de derivación hay además HANDOFF_ALERTS_NONE.
    expect(codes.sort()).toEqual([
      'HANDOFF_ALERTS_NONE',
      'HANDOFF_CONTACT_MISSING',
      'SERVICE_PRICE_MISSING',
    ]);
  });
});
