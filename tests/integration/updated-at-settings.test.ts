/** FAQ, políticas, tono y derivación hacen avanzar `snapshot.updatedAt` en cada guardado. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFaq, deleteFaq, reorderFaqs, updateFaq } from '../../src/knowledge/services/faqs.js';
import { saveHandoff, savePolicies, saveTone } from '../../src/knowledge/services/settings.js';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

describe('updated_at en FAQ y ajustes', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });

  it('cada guardado hace avanzar snapshot.updatedAt', async () => {
    const reader = createKnowledgeReader(t.db);
    let last = (await reader.getSnapshot()).updatedAt;
    const advances = async (write: () => Promise<unknown>) => {
      await write();
      const now = (await reader.getSnapshot()).updatedAt;
      expect(now > last, `${now} > ${last}`).toBe(true);
      last = now;
    };
    const deps = t.deps;
    let a = '';
    let b = '';
    await advances(async () => {
      a = await createFaq(deps, { question: 'P1', answer: 'R1' });
    });
    await advances(async () => {
      b = await createFaq(deps, { question: 'P2', answer: 'R2' });
    });
    await advances(() => updateFaq(deps, a, { question: 'P1', answer: 'R1 bis' }));
    await advances(() => reorderFaqs(deps, { ids: [b, a] }));
    await advances(() => deleteFaq(deps, b));
    await advances(() => savePolicies(deps, { min_advance: '2', min_advance_unit: 'hours' }));
    await advances(() => savePolicies(deps, { min_advance: '3', min_advance_unit: 'hours' }));
    await advances(() => saveTone(deps, { address_form: 'informal' }));
    await advances(() => saveTone(deps, { address_form: 'formal' }));
    await advances(() => saveHandoff(deps, { channels: [{ type: 'phone', value: '600123456' }] }));
    await advances(() => saveHandoff(deps, { channels: [] }));
  });
});
