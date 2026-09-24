import type { Tx } from '../../db/client.js';
import { policies } from '../../db/schema.js';
import { touch } from '../../db/timestamps.js';
import type { PoliciesInput } from '../schemas/policies.js';

export async function getPolicies(tx: Tx) {
  const [row] = await tx.select().from(policies).limit(1);
  return row;
}

export async function upsertPolicies(tx: Tx, data: PoliciesInput): Promise<void> {
  await tx
    .insert(policies)
    .values({ id: 1, ...data, ...touch() })
    .onConflictDoUpdate({ target: policies.id, set: { ...data, ...touch() } });
}
