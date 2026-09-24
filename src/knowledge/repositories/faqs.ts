import { asc, eq } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { faq } from '../../db/schema.js';
import { touch, touchBusiness } from '../../db/timestamps.js';
import type { FaqInput } from '../schemas/faq.js';
import { applyOrder, nextSortOrder } from './ordering.js';

export function listFaqs(tx: Tx) {
  return tx.select().from(faq).orderBy(asc(faq.sortOrder), asc(faq.question));
}

export async function getFaq(tx: Tx, id: string) {
  const [row] = await tx.select().from(faq).where(eq(faq.id, id));
  return row;
}

export async function createFaq(tx: Tx, data: FaqInput): Promise<string> {
  const sortOrder = await nextSortOrder(tx, faq);
  const [row] = await tx
    .insert(faq)
    .values({ ...data, sortOrder, ...touch() })
    .returning({ id: faq.id });
  if (!row) throw new Error('No se pudo crear la pregunta');
  return row.id;
}

export async function updateFaq(tx: Tx, id: string, data: FaqInput): Promise<boolean> {
  const rows = await tx
    .update(faq)
    .set({ ...data, ...touch() })
    .where(eq(faq.id, id))
    .returning({ id: faq.id });
  return rows.length > 0;
}

export async function deleteFaq(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx.delete(faq).where(eq(faq.id, id)).returning({ id: faq.id });
  if (rows.length > 0) await touchBusiness(tx);
  return rows.length > 0;
}

export function reorderFaqs(tx: Tx, ids: string[]): Promise<boolean> {
  return applyOrder(tx, faq, ids);
}
