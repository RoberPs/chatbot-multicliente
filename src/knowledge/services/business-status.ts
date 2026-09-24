import { lockBusiness, type Db } from '../../db/client.js';
import { business } from '../../db/schema.js';
import { touch } from '../../db/timestamps.js';
import { ActivationBlockedError } from '../errors.js';
import { loadKnowledgeState } from '../state.js';
import { computeWarnings, criticalWarnings } from '../warnings.js';

/** `draft → active`. Se rechaza si hay avisos críticos (FR-031); los normales no bloquean. */
export async function activateBusiness(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await lockBusiness(tx);
    const critical = criticalWarnings(computeWarnings(await loadKnowledgeState(tx)));
    if (critical.length > 0) throw new ActivationBlockedError(critical);
    await tx.update(business).set({ status: 'active', ...touch() });
  });
}

/** `active → draft`. Siempre permitido. */
export async function deactivateBusiness(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await lockBusiness(tx);
    await tx.update(business).set({ status: 'draft', ...touch() });
  });
}
