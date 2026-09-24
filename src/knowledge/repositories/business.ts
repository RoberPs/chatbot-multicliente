import type { Tx } from '../../db/client.js';
import { business } from '../../db/schema.js';
import { touch } from '../../db/timestamps.js';
import type { BusinessInput } from '../schemas/business.js';

export async function getBusiness(tx: Tx) {
  const [row] = await tx.select().from(business).limit(1);
  return row;
}

export async function updateBusiness(tx: Tx, data: BusinessInput): Promise<void> {
  await tx.update(business).set({ ...data, ...touch() });
}
