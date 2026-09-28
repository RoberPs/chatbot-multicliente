import { desc, eq, lt, sql } from 'drizzle-orm';
import { conversation, customer } from '../../db/schema.js';
import { handoffStepSchema, type HandoffStep } from '../../handoff/types.js';
import type { Channel } from '../channels.js';
import type { DbOrTx } from './customer.js';

export interface ConversationRow {
  id: string;
  customerId: string;
  startedAt: Date;
  lastInboundAt: Date;
  lastMessageAt: Date;
  greeted: boolean;
  /** Datos de contacto para la derivación (005). */
  contactName: string | null;
  contactPhone: string | null;
  /** Paso previo a la derivación (005, R2); un valor que no valida se trata como `null`. */
  handoffStep: HandoffStep | null;
}

const NAME_MAX = 80;

/** Nombre de una línea, sin saltos ni espacios repetidos, ≤ 80 caracteres; `null` si queda vacío. */
export function cleanContactName(value: string): string | null {
  const name = value.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  return name === '' ? null : name;
}

const parseStep = (value: unknown): HandoffStep | null => {
  if (value === null || value === undefined) return null;
  const parsed = handoffStepSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const conversationColumns = {
  id: conversation.id,
  customerId: conversation.customerId,
  startedAt: conversation.startedAt,
  lastInboundAt: conversation.lastInboundAt,
  lastMessageAt: conversation.lastMessageAt,
  greeted: conversation.greeted,
  contactName: conversation.contactName,
  contactPhone: conversation.contactPhone,
  handoffStep: conversation.handoffStep,
};

function toRow<T extends { handoffStep: unknown }>(
  row: T,
): Omit<T, 'handoffStep'> & { handoffStep: HandoffStep | null } {
  return { ...row, handoffStep: parseStep(row.handoffStep) };
}

/** Conversación con el cliente que la identifica en su canal. */
export interface ConversationWithCustomer extends ConversationRow {
  channel: Channel;
  channelUserId: string;
}

export async function findLatestForCustomer(
  tx: DbOrTx,
  customerId: string,
): Promise<ConversationRow | null> {
  const [row] = await tx
    .select(conversationColumns)
    .from(conversation)
    .where(eq(conversation.customerId, customerId))
    .orderBy(desc(conversation.lastInboundAt))
    .limit(1);
  return row ? toRow(row) : null;
}

export async function findWithCustomer(
  tx: DbOrTx,
  id: string,
): Promise<ConversationWithCustomer | null> {
  const [row] = await tx
    .select({
      ...conversationColumns,
      channel: customer.channel,
      channelUserId: customer.channelUserId,
    })
    .from(conversation)
    .innerJoin(customer, eq(customer.id, conversation.customerId))
    .where(eq(conversation.id, id));
  return row ? toRow(row) : null;
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
    .returning(conversationColumns);
  if (!row) throw new Error('No se pudo crear la conversación');
  return toRow(row);
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

/** Guarda (o limpia con `null`) el paso previo a la derivación (005, R2). */
export async function setHandoffStep(
  tx: DbOrTx,
  id: string,
  step: HandoffStep | null,
): Promise<void> {
  await tx
    .update(conversation)
    .set({ handoffStep: step === null ? null : handoffStepSchema.parse(step) })
    .where(eq(conversation.id, id));
}

/**
 * Guarda los datos de contacto que dio el cliente (005, FR-004). Solo cambia los que se pasan;
 * un dato dado se guarda aunque falte el otro. El teléfono llega ya en E.164.
 */
export async function setContact(
  tx: DbOrTx,
  id: string,
  data: { name?: string | null; phone?: string | null },
): Promise<void> {
  const values: { contactName?: string | null; contactPhone?: string | null } = {};
  if (data.name !== undefined)
    values.contactName = data.name === null ? null : cleanContactName(data.name);
  if (data.phone !== undefined) values.contactPhone = data.phone;
  if (Object.keys(values).length === 0) return;
  await tx.update(conversation).set(values).where(eq(conversation.id, id));
}

/**
 * Nombre de perfil de WhatsApp en cada entrante que lo trae (005, R10): una línea, ≤ 80
 * caracteres. Un perfil vacío no borra el nombre guardado.
 */
export async function setProfileName(tx: DbOrTx, id: string, name: string): Promise<void> {
  const clean = cleanContactName(name);
  if (clean === null) return;
  await tx.update(conversation).set({ contactName: clean }).where(eq(conversation.id, id));
}

export interface ClaimLimits {
  quietMs: number;
  maxWaitMs: number;
  limit: number;
  /** Tiempo máximo que se espera a un audio en transcripción (R10). */
  transcriptionWaitMs: number;
  /** Conversaciones que el proceso ya está atendiendo. */
  excludeIds: string[];
}

/**
 * Conversaciones listas para responder (data-model.md, R5): con entrantes pendientes y
 * `now − último ≥ espera` o `now − primero ≥ tope`, y sin audios transcribiéndose desde hace
 * menos de 10 s. Bloquea las filas con SKIP LOCKED para
 * que dos procesadores no reclamen la misma.
 */
export async function claimReady(tx: DbOrTx, now: Date, limits: ClaimLimits): Promise<string[]> {
  const quietBefore = new Date(now.getTime() - limits.quietMs);
  const maxWaitBefore = new Date(now.getTime() - limits.maxWaitMs);
  const transcribingSince = new Date(now.getTime() - limits.transcriptionWaitMs);
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
    and not exists (
      select 1 from message a
      where a.conversation_id = c.id and a.direction = 'inbound' and a.status = 'pending'
        and a.transcription = 'pending' and a.received_at > ${transcribingSince}
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
