import { asc, eq } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { closure } from '../../db/schema.js';
import { touch, touchBusiness } from '../../db/timestamps.js';
import type { ClosureInput } from '../schemas/closure.js';

export function listClosures(tx: Tx) {
  return tx.select().from(closure).orderBy(asc(closure.startDate), asc(closure.startTime));
}

export async function getClosure(tx: Tx, id: string) {
  const [row] = await tx.select().from(closure).where(eq(closure.id, id));
  return row;
}

export async function createClosure(tx: Tx, data: ClosureInput): Promise<string> {
  const [row] = await tx
    .insert(closure)
    .values({ ...data, ...touch() })
    .returning({ id: closure.id });
  if (!row) throw new Error('No se pudo crear el cierre');
  return row.id;
}

export async function updateClosure(tx: Tx, id: string, data: ClosureInput): Promise<boolean> {
  const rows = await tx
    .update(closure)
    .set({ ...data, ...touch() })
    .where(eq(closure.id, id))
    .returning({ id: closure.id });
  return rows.length > 0;
}

export async function deleteClosure(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx.delete(closure).where(eq(closure.id, id)).returning({ id: closure.id });
  if (rows.length > 0) await touchBusiness(tx);
  return rows.length > 0;
}
