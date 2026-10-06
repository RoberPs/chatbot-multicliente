import { and, eq, notExists, sql } from 'drizzle-orm';
import type { Db, Tx } from '../../db/client.js';
import { conversation, customer } from '../../db/schema.js';
import type { Channel } from '../channels.js';

export type DbOrTx = Db | Tx;

export interface CustomerRow {
  id: string;
  channel: Channel;
  channelUserId: string;
  rateLimitNotifiedAt: Date | null;
}

const customerColumns = {
  id: customer.id,
  channel: customer.channel,
  channelUserId: customer.channelUserId,
  rateLimitNotifiedAt: customer.rateLimitNotifiedAt,
};

/** Crea el cliente `(canal, id en el canal)` si no existe y lo devuelve (FR-001). */
export async function upsertByChannel(
  tx: DbOrTx,
  channel: Channel,
  channelUserId: string,
): Promise<CustomerRow> {
  const [row] = await tx
    .insert(customer)
    .values({ channel, channelUserId })
    .onConflictDoUpdate({
      target: [customer.channel, customer.channelUserId],
      set: { channelUserId: sql`excluded.channel_user_id` },
    })
    .returning(customerColumns);
  if (!row) throw new Error('No se pudo guardar el cliente');
  return row;
}

/** Cliente existente, sin crearlo (lecturas del chat web). */
export async function findByChannel(
  tx: DbOrTx,
  channel: Channel,
  channelUserId: string,
): Promise<CustomerRow | null> {
  const [row] = await tx
    .select(customerColumns)
    .from(customer)
    .where(and(eq(customer.channel, channel), eq(customer.channelUserId, channelUserId)));
  return row ?? null;
}

export async function markRateLimitNotified(tx: DbOrTx, id: string, at: Date): Promise<void> {
  await tx.update(customer).set({ rateLimitNotifiedAt: at }).where(eq(customer.id, id));
}

/** Borra los clientes sin conversaciones, de cualquier canal (FR-030). Devuelve cuántos. */
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
