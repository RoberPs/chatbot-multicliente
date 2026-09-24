import { eq, notExists, sql } from 'drizzle-orm';
import type { Db, Tx } from '../../db/client.js';
import { conversation, customer } from '../../db/schema.js';

export type DbOrTx = Db | Tx;

export interface CustomerRow {
  id: string;
  phone: string;
  rateLimitNotifiedAt: Date | null;
}

/** Crea el cliente si no existe y lo devuelve. */
export async function upsertByPhone(tx: DbOrTx, phone: string): Promise<CustomerRow> {
  const [row] = await tx
    .insert(customer)
    .values({ phone })
    .onConflictDoUpdate({ target: customer.phone, set: { phone: sql`excluded.phone` } })
    .returning({
      id: customer.id,
      phone: customer.phone,
      rateLimitNotifiedAt: customer.rateLimitNotifiedAt,
    });
  if (!row) throw new Error('No se pudo guardar el cliente');
  return row;
}

export async function markRateLimitNotified(tx: DbOrTx, id: string, at: Date): Promise<void> {
  await tx.update(customer).set({ rateLimitNotifiedAt: at }).where(eq(customer.id, id));
}

/** Borra los clientes sin conversaciones (FR-030). Devuelve cuántos. */
export async function deleteOrphans(tx: DbOrTx): Promise<number> {
  const rows = await tx
    .delete(customer)
    .where(
      notExists(
        tx
          .select({ one: sql`1` })
          .from(conversation)
          .where(eq(conversation.customerId, customer.id)),
      ),
    )
    .returning({ id: customer.id });
  return rows.length;
}
