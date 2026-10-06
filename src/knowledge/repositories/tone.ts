import type { Tx } from '../../db/client.js';
import { tone } from '../../db/schema.js';
import { touch } from '../../db/timestamps.js';
import type { ToneInput } from '../schemas/tone.js';

export async function getTone(tx: Tx) {
  const [row] = await tx.select().from(tone).limit(1);
  return row;
}

export async function upsertTone(tx: Tx, data: ToneInput): Promise<void> {
  await tx
    .insert(tone)
    .values({ id: 1, ...data, ...touch() })
    .onConflictDoUpdate({ target: tone.id, set: { ...data, ...touch() } });
}
