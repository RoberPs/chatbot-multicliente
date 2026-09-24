import { desc, eq, lt, sql } from 'drizzle-orm';
import { conversation, customer } from '../../db/schema.js';
import type { DbOrTx } from './customer.js';

export interface ConversationRow {
  id: string;
  customerId: string;
  startedAt: Date;
  lastInboundAt: Date;
  lastMessageAt: Date;
  greeted: boolean;
}

export interface ConversationWithPhone extends ConversationRow {
  phone: string;
}

export async function findLatestForCustomer(
  tx: DbOrTx,
  customerId: string,
): Promise<ConversationRow | null> {
  const [row] = await tx
    .select()
    .from(conversation)
    .where(eq(conversation.customerId, customerId))
    .orderBy(desc(conversation.lastInboundAt))
    .limit(1);
  return row ?? null;
}

export async function findWithPhone(tx: DbOrTx, id: string): Promise<ConversationWithPhone | null> {
  const [row] = await tx
    .select({
      id: conversation.id,
      customerId: conversation.customerId,
      startedAt: conversation.startedAt,
      lastInboundAt: conversation.lastInboundAt,
      lastMessageAt: conversation.lastMessageAt,
      greeted: conversation.greeted,
      phone: customer.phone,
    })
    .from(conversation)
    .innerJoin(customer, eq(customer.id, conversation.customerId))
    .where(eq(conversation.id, id));
  return row ?? null;
}

export async function create(
  tx: DbOrTx,
  values: { customerId: string; sentAt: Date; receivedAt: Date },
): Promise<ConversationRow> {
  const [row] = await tx
    .insert(conversation)
    .values({
      customerId: values.customerId,
      startedAt: values.sentAt,
      lastInboundAt: values.sentAt,
      lastMessageAt: values.receivedAt,
    })
    .returning();
  if (!row) throw new Error('No se pudo crear la conversación');
  return row;
}

/** Registra un entrante: avanza `last_inbound_at` (marca de WhatsApp) y `last_message_at`. */
export async function touchInbound(
  tx: DbOrTx,
  id: string,
  sentAt: Date,
  receivedAt: Date,
): Promise<void> {
  await tx
    .update(conversation)
    .set({
      lastInboundAt: sql`greatest(${conversation.lastInboundAt}, ${sentAt})`,
      lastMessageAt: sql`greatest(${conversation.lastMessageAt}, ${receivedAt})`,
    })
    .where(eq(conversation.id, id));
}

export async function touchMessage(tx: DbOrTx, id: string, at: Date): Promise<void> {
  await tx
    .update(conversation)
    .set({ lastMessageAt: sql`greatest(${conversation.lastMessageAt}, ${at})` })
    .where(eq(conversation.id, id));
}

export async function markGreeted(tx: DbOrTx, id: string): Promise<void> {
  await tx.update(conversation).set({ greeted: true }).where(eq(conversation.id, id));
}

export interface ClaimLimits {
  quietMs: number;
  maxWaitMs: number;
  limit: number;
  /** Conversaciones que el proceso ya está atendiendo. */
  excludeIds: string[];
}

/**
 * Conversaciones listas para responder (data-model.md, R5): con entrantes pendientes y
 * `now − último ≥ espera` o `now − primero ≥ tope`. Bloquea las filas con SKIP LOCKED para
 * que dos procesadores no reclamen la misma.
 */
export async function claimReady(tx: DbOrTx, now: Date, limits: ClaimLimits): Promise<string[]> {
  const quietBefore = new Date(now.getTime() - limits.quietMs);
  const maxWaitBefore = new Date(now.getTime() - limits.maxWaitMs);
  const exclude =
    limits.excludeIds.length > 0
      ? sql`and c.id not in (${sql.join(
          limits.excludeIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql``;
  const result = await tx.execute<{ id: string }>(sql`
    select c.id
    from conversation c
    where c.id in (
      select m.conversation_id
      from message m
      where m.direction = 'inbound' and m.status = 'pending'
      group by m.conversation_id
      having max(m.received_at) <= ${quietBefore} or min(m.received_at) <= ${maxWaitBefore}
    )
    ${exclude}
    order by c.last_inbound_at
    limit ${limits.limit}
    for update of c skip locked
  `);
  return result.rows.map((r) => r.id);
}

/** Conversaciones con entrantes pendientes (reanudación al arrancar). */
export async function withPending(tx: DbOrTx): Promise<string[]> {
  const result = await tx.execute<{ id: string }>(sql`
    select distinct conversation_id as id from message
    where direction = 'inbound' and status = 'pending'
  `);
  return result.rows.map((r) => r.id);
}

/** Borra las conversaciones sin actividad desde `cutoff` (sus mensajes caen en cascada). */
export async function deleteOlderThan(tx: DbOrTx, cutoff: Date): Promise<number> {
  const rows = await tx
    .delete(conversation)
    .where(lt(conversation.lastMessageAt, cutoff))
    .returning({ id: conversation.id });
  return rows.length;
}
