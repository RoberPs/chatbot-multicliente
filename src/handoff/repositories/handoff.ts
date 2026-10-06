/**
 * Derivaciones (005, data-model.md § handoff). Las transiciones son `UPDATE … WHERE status =
 * 'active'`: si dos acciones llegan a la vez, solo cuenta la primera (FR-016). Desde la 012
 * guardan también cuándo salieron los avisos de inicio, cuándo se confirmó al cliente y el último
 * aviso al negocio (para agrupar los reenvíos).
 */
import { and, asc, count, desc, eq, isNull, lte, max, ne, sql } from 'drizzle-orm';
import { conversation, customer, handoff, message } from '../../db/schema.js';
import type { Channel } from '../../conversation/channels.js';
import type { DbOrTx } from '../../conversation/repositories/customer.js';
import type { HandoffActionVia, HandoffEndCause, HandoffKind } from '../types.js';

export interface HandoffRow {
  id: string;
  conversationId: string;
  kind: HandoffKind;
  status: 'active' | 'ended';
  summary: string;
  summarySource: 'model' | 'fallback';
  tokenEnc: Buffer;
  startedAt: Date;
  confirmedAt: Date | null;
  confirmedVia: HandoffActionVia | null;
  reminderDueAt: Date | null;
  reminderSentAt: Date | null;
  endedAt: Date | null;
  endCause: HandoffEndCause | null;
  /** Alguna vía entregó los avisos de inicio (012, R10.4). */
  alertsSentAt: Date | null;
  /** La confirmación al cliente quedó guardada (012, R10.4). */
  customerNotifiedAt: Date | null;
  /** Último aviso al negocio: alerta, reenvío o recordatorio (012, R7.2). */
  lastNoticeAt: Date | null;
}

/** Derivación con los datos del cliente de su conversación. */
export interface HandoffWithCustomer extends HandoffRow {
  customerName: string | null;
  customerPhone: string | null;
  channel: Channel;
  channelUserId: string;
}

const handoffColumns = {
  id: handoff.id,
  conversationId: handoff.conversationId,
  kind: handoff.kind,
  status: handoff.status,
  summary: handoff.summary,
  summarySource: handoff.summarySource,
  tokenEnc: handoff.tokenEnc,
  startedAt: handoff.startedAt,
  confirmedAt: handoff.confirmedAt,
  confirmedVia: handoff.confirmedVia,
  reminderDueAt: handoff.reminderDueAt,
  reminderSentAt: handoff.reminderSentAt,
  endedAt: handoff.endedAt,
  endCause: handoff.endCause,
  alertsSentAt: handoff.alertsSentAt,
  customerNotifiedAt: handoff.customerNotifiedAt,
  lastNoticeAt: handoff.lastNoticeAt,
};

const withCustomerColumns = {
  ...handoffColumns,
  customerName: conversation.contactName,
  customerPhone: conversation.contactPhone,
  channel: customer.channel,
  channelUserId: customer.channelUserId,
};

export interface NewHandoff {
  id: string;
  conversationId: string;
  kind: HandoffKind;
  summary: string;
  summarySource: 'model' | 'fallback';
  tokenHash: Buffer;
  tokenEnc: Buffer;
  startedAt: Date;
  reminderDueAt: Date | null;
  /** 012 (R10.4): nulos mientras no consta el aviso o la confirmación. */
  alertsSentAt?: Date | null;
  customerNotifiedAt?: Date | null;
  lastNoticeAt?: Date | null;
}

/** Inserta la derivación activa; falla si la conversación ya tiene una (índice único). */
export async function insertActive(tx: DbOrTx, values: NewHandoff): Promise<void> {
  await tx.insert(handoff).values({ ...values, status: 'active' });
}

export async function findActiveByConversation(
  tx: DbOrTx,
  conversationId: string,
): Promise<HandoffWithCustomer | null> {
  const [row] = await tx
    .select(withCustomerColumns)
    .from(handoff)
    .innerJoin(conversation, eq(conversation.id, handoff.conversationId))
    .innerJoin(customer, eq(customer.id, conversation.customerId))
    .where(and(eq(handoff.conversationId, conversationId), eq(handoff.status, 'active')));
  return row ?? null;
}

export async function findById(tx: DbOrTx, id: string): Promise<HandoffWithCustomer | null> {
  const [row] = await tx
    .select(withCustomerColumns)
    .from(handoff)
    .innerJoin(conversation, eq(conversation.id, handoff.conversationId))
    .innerJoin(customer, eq(customer.id, conversation.customerId))
    .where(eq(handoff.id, id));
  return row ?? null;
}

export async function findByTokenHash(
  tx: DbOrTx,
  tokenHash: Buffer,
): Promise<HandoffWithCustomer | null> {
  const [row] = await tx
    .select(withCustomerColumns)
    .from(handoff)
    .innerJoin(conversation, eq(conversation.id, handoff.conversationId))
    .innerJoin(customer, eq(customer.id, conversation.customerId))
    .where(eq(handoff.tokenHash, tokenHash));
  return row ?? null;
}

/** Alguna vía entregó la alerta de inicio (012, R10.4). */
export async function markAlertsSent(tx: DbOrTx, id: string, at: Date): Promise<void> {
  await tx.update(handoff).set({ alertsSentAt: at }).where(eq(handoff.id, id));
}

/** La confirmación al cliente quedó guardada (012, R10.4); va en la transacción del saliente. */
export async function markCustomerNotified(tx: DbOrTx, id: string, at: Date): Promise<void> {
  await tx.update(handoff).set({ customerNotifiedAt: at }).where(eq(handoff.id, id));
}

/** Ninguna vía entregó la alerta: la derivación guardada antes de avisar no llegó a existir. */
export async function deleteHandoff(tx: DbOrTx, id: string): Promise<void> {
  await tx.delete(handoff).where(eq(handoff.id, id));
}

/** Último aviso al negocio de la derivación (012): reinicia el intervalo del agrupado. */
export async function setLastNoticeAt(tx: DbOrTx, id: string, at: Date): Promise<void> {
  await tx.update(handoff).set({ lastNoticeAt: at }).where(eq(handoff.id, id));
}

/** Hubo alguna derivación terminada en la conversación (005, FR-018). */
export async function hasEnded(tx: DbOrTx, conversationId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: handoff.id })
    .from(handoff)
    .where(and(eq(handoff.conversationId, conversationId), eq(handoff.status, 'ended')))
    .limit(1);
  return row !== undefined;
}

/** "Le atiendo": confirma si seguía activa y sin confirmar. Devuelve si cambió. */
export async function confirm(
  tx: DbOrTx,
  id: string,
  via: HandoffActionVia,
  at: Date,
): Promise<boolean> {
  const rows = await tx
    .update(handoff)
    .set({ confirmedAt: at, confirmedVia: via })
    .where(and(eq(handoff.id, id), eq(handoff.status, 'active'), isNull(handoff.confirmedAt)))
    .returning({ id: handoff.id });
  return rows.length > 0;
}

/**
 * Termina una derivación activa. Con `confirmVia` ("Terminado" del negocio) la confirma a la
 * vez si no lo estaba (FR-016). Devuelve si cambió.
 */
export async function end(
  tx: DbOrTx,
  id: string,
  cause: HandoffEndCause,
  at: Date,
  confirmVia?: HandoffActionVia,
): Promise<boolean> {
  const rows = await tx
    .update(handoff)
    .set({
      status: 'ended',
      endedAt: at,
      endCause: cause,
      ...(confirmVia
        ? {
            confirmedAt: sql`coalesce(${handoff.confirmedAt}, ${at})`,
            confirmedVia: sql`coalesce(${handoff.confirmedVia}, ${confirmVia}::handoff_action_via)`,
          }
        : {}),
    })
    .where(and(eq(handoff.id, id), eq(handoff.status, 'active')))
    .returning({ id: handoff.id });
  return rows.length > 0;
}

export interface ActiveHandoffListItem {
  id: string;
  kind: HandoffKind;
  customerName: string | null;
  customerPhone: string | null;
  channel: Channel;
  startedAt: Date;
  confirmedAt: Date | null;
  reminderSentAt: Date | null;
  /** Entrantes esperando el reenvío agrupado (012) y cuándo se reclamarán. */
  pending: number;
  processAfter: Date | null;
}

/** Derivaciones activas para el panel (FR-016a): sin el motivo y sin las del playground. */
export async function listActive(tx: DbOrTx): Promise<ActiveHandoffListItem[]> {
  return tx
    .select({
      id: handoff.id,
      kind: handoff.kind,
      customerName: conversation.contactName,
      customerPhone: conversation.contactPhone,
      channel: customer.channel,
      startedAt: handoff.startedAt,
      confirmedAt: handoff.confirmedAt,
      reminderSentAt: handoff.reminderSentAt,
      pending: sql<number>`(
        select count(*)::int from message m
        where m.conversation_id = ${handoff.conversationId}
          and m.direction = 'inbound' and m.status = 'pending'
      )`,
      processAfter: conversation.processAfter,
    })
    .from(handoff)
    .innerJoin(conversation, eq(conversation.id, handoff.conversationId))
    .innerJoin(customer, eq(customer.id, conversation.customerId))
    .where(and(eq(handoff.status, 'active'), ne(customer.channel, 'playground')))
    .orderBy(asc(handoff.startedAt));
}

export interface HeldListItem {
  conversationId: string;
  customerName: string | null;
  customerPhone: string | null;
  channel: Channel;
  held: number;
  /** Llegada del último retenido. */
  lastAt: Date;
}

/**
 * Conversaciones con mensajes retenidos al terminar su derivación (012, R7.4), las más recientes
 * primero y sin las del playground: el número, nunca los textos (FR-016a).
 */
export async function listHeld(tx: DbOrTx, limit = 50): Promise<HeldListItem[]> {
  const lastAt = max(message.receivedAt);
  const rows = await tx
    .select({
      conversationId: conversation.id,
      customerName: conversation.contactName,
      customerPhone: conversation.contactPhone,
      channel: customer.channel,
      held: count(),
      lastAt,
    })
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .innerJoin(customer, eq(customer.id, conversation.customerId))
    .where(
      and(
        eq(message.direction, 'inbound'),
        eq(message.status, 'held'),
        ne(customer.channel, 'playground'),
      ),
    )
    .groupBy(conversation.id, customer.channel)
    .orderBy(desc(lastAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, lastAt: r.lastAt ?? new Date(0) }));
}

/** Número de derivaciones activas fuera del playground (portada del panel). */
export async function countActive(tx: DbOrTx): Promise<number> {
  const rows = await listActive(tx);
  return rows.length;
}

export interface EndedByInactivity {
  id: string;
  conversationId: string;
  startedAt: Date;
  confirmed: boolean;
  /** Se cerró sin confirmar y sin recordatorio: toca el aviso `reminder` (FR-019). */
  reminderDue: boolean;
}

/**
 * Termina por inactividad las activas cuya conversación no tiene entrantes desde `before`
 * (R14). Las que se cierran sin confirmar y sin recordatorio quedan con `reminder_sent_at` en
 * la misma sentencia, para que el recordatorio salga una sola vez.
 */
export async function endInactive(
  tx: DbOrTx,
  before: Date,
  now: Date,
): Promise<EndedByInactivity[]> {
  const result = await tx.execute<{
    id: string;
    conversation_id: string;
    started_at: Date | string;
    confirmed: boolean;
    reminder_due: boolean;
  }>(sql`
    update handoff h
    set status = 'ended',
        ended_at = ${now},
        end_cause = 'inactivity',
        reminder_sent_at = case
          when h.confirmed_at is null and h.reminder_sent_at is null then ${now}
          else h.reminder_sent_at
        end
    from conversation c,
      (select id, confirmed_at is null and reminder_sent_at is null as reminder_due
       from handoff where status = 'active') prev
    where h.conversation_id = c.id
      and prev.id = h.id
      and h.status = 'active'
      and c.last_inbound_at <= ${before}
    returning h.id, h.conversation_id, h.started_at,
      h.confirmed_at is not null as confirmed, prev.reminder_due
  `);
  return result.rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    startedAt: new Date(r.started_at),
    confirmed: r.confirmed,
    reminderDue: r.reminder_due,
  }));
}

/**
 * Reclama los recordatorios vencidos (FR-019): activas, sin confirmar, sin recordatorio y con
 * `reminder_due_at ≤ now`. Marca `reminder_sent_at` en la misma transacción con `SKIP LOCKED`,
 * así que dos barridos a la vez no devuelven la misma fila.
 */
export async function claimDueReminders(tx: DbOrTx, now: Date): Promise<string[]> {
  const result = await tx.execute<{ id: string }>(sql`
    update handoff set reminder_sent_at = ${now}
    where id in (
      select id from handoff
      where status = 'active' and confirmed_at is null and reminder_sent_at is null
        and reminder_due_at <= ${now}
      for update skip locked
    )
    returning id
  `);
  return result.rows.map((r) => r.id);
}

/** Derivaciones activas con recordatorio vencido (solo lectura, para tests y diagnósticos). */
export async function dueReminders(tx: DbOrTx, now: Date): Promise<string[]> {
  const rows = await tx
    .select({ id: handoff.id })
    .from(handoff)
    .where(
      and(
        eq(handoff.status, 'active'),
        isNull(handoff.confirmedAt),
        isNull(handoff.reminderSentAt),
        lte(handoff.reminderDueAt, now),
      ),
    );
  return rows.map((r) => r.id);
}
