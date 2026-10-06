import { and, asc, count, desc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import { conversation, message } from '../../db/schema.js';
import type { MessageKind, ReplyTrace } from '../types.js';
import type { DbOrTx } from './customer.js';

export type InboundStatus = 'pending' | 'rate_limited';
export type TranscriptionState = 'pending' | 'done' | 'failed';

export interface InboundRow {
  id: string;
  kind: MessageKind;
  body: string | null;
  otherType: string | null;
  sentAt: Date;
  receivedAt: Date;
  transcription: TranscriptionState | null;
}

export interface HistoryRow {
  direction: 'inbound' | 'outbound';
  kind: MessageKind;
  body: string | null;
  otherType: string | null;
}

/** Guarda un entrante; `inserted = false` si el id del canal ya estaba (FR-004, FR-023). */
export async function insertInbound(
  tx: DbOrTx,
  values: {
    conversationId: string;
    channelMessageId: string;
    kind: MessageKind;
    body: string | null;
    otherType: string | null;
    sentAt: Date;
    receivedAt: Date;
    status: InboundStatus;
    transcription?: TranscriptionState | null;
  },
): Promise<{ inserted: boolean; id: string | null }> {
  const rows = await tx
    .insert(message)
    .values({ ...values, direction: 'inbound', transcription: values.transcription ?? null })
    .onConflictDoNothing({ target: message.channelMessageId })
    .returning({ id: message.id });
  const id = rows[0]?.id ?? null;
  return { inserted: id !== null, id };
}

const inboundColumns = {
  id: message.id,
  kind: message.kind,
  body: message.body,
  otherType: message.otherType,
  sentAt: message.sentAt,
  receivedAt: message.receivedAt,
  transcription: message.transcription,
};

/** Entrantes pendientes de una conversación, en orden de llegada. */
export async function pendingFor(tx: DbOrTx, conversationId: string): Promise<InboundRow[]> {
  return tx
    .select(inboundColumns)
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.direction, 'inbound'),
        eq(message.status, 'pending'),
      ),
    )
    .orderBy(asc(message.sentAt), asc(message.receivedAt));
}

/**
 * Últimos `limit` mensajes ya tratados de la conversación (entrantes contestados o reenviados
 * al negocio durante una derivación, y salientes enviados), en orden cronológico. Los
 * pendientes van aparte. Los reenviados entran para que el bot los tenga en cuenta cuando la
 * conversación vuelve (005, FR-018); los retenidos (`held`, 012) no, porque nadie los leyó.
 */
export async function history(
  tx: DbOrTx,
  conversationId: string,
  limit: number,
): Promise<HistoryRow[]> {
  const rows = await tx
    .select({
      direction: message.direction,
      kind: message.kind,
      body: message.body,
      otherType: message.otherType,
    })
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        or(
          and(eq(message.direction, 'inbound'), inArray(message.status, ['answered', 'forwarded'])),
          and(eq(message.direction, 'outbound'), eq(message.status, 'sent')),
        ),
      ),
    )
    .orderBy(desc(message.sentAt), desc(message.receivedAt))
    .limit(limit);
  return rows.reverse();
}

/**
 * Pasa entrantes pendientes a `forwarded` (005, R11): se reenvían al negocio en lugar de
 * contestarse. Es terminal: `claimReady` ya no los reclama. Devuelve cuántos cambiaron (012: se
 * marcan antes de enviar, así que un reintento no repite el reenvío).
 */
export async function markForwarded(tx: DbOrTx, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await tx
    .update(message)
    .set({ status: 'forwarded' })
    .where(and(inArray(message.id, ids), eq(message.status, 'pending')))
    .returning({ id: message.id });
  return rows.length;
}

/**
 * Al terminar una derivación (012, R7.4), los entrantes pendientes de la conversación anteriores
 * al fin pasan a `held`: no se reenvían ni los contesta el bot. Devuelve cuántos.
 */
export async function markHeld(tx: DbOrTx, conversationId: string, endedAt: Date): Promise<number> {
  const rows = await tx
    .update(message)
    .set({ status: 'held' })
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.direction, 'inbound'),
        eq(message.status, 'pending'),
        lte(message.receivedAt, endedAt),
      ),
    )
    .returning({ id: message.id });
  return rows.length;
}

/**
 * Últimos `limit` textos del cliente en la conversación, en orden (005, R4): la única entrada
 * del resumen de la derivación. Incluye pendientes, contestados y reenviados; nunca respuestas
 * del bot.
 */
export async function customerTexts(
  tx: DbOrTx,
  conversationId: string,
  limit: number,
): Promise<string[]> {
  const rows = await tx
    .select({ body: message.body })
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.direction, 'inbound'),
        inArray(message.status, ['pending', 'answered', 'forwarded']),
        sql`${message.body} is not null and btrim(${message.body}) <> ''`,
      ),
    )
    .orderBy(desc(message.sentAt), desc(message.receivedAt))
    .limit(limit);
  return rows.map((r) => r.body ?? '').reverse();
}

/**
 * Crea el saliente `sending` y pasa los entrantes a `answered` con su `reply_id`, en la misma
 * transacción. Si alguno ya no está pendiente, falla: ningún entrante se cubre dos veces.
 */
export async function createOutboundCovering(
  tx: DbOrTx,
  conversationId: string,
  body: string,
  inboundIds: string[],
  at: Date,
  replyTrace: ReplyTrace | null = null,
): Promise<string> {
  const [outbound] = await tx
    .insert(message)
    .values({
      conversationId,
      direction: 'outbound',
      kind: 'text',
      body,
      sentAt: at,
      receivedAt: at,
      status: 'sending',
      replyTrace,
    })
    .returning({ id: message.id });
  if (!outbound) throw new Error('No se pudo crear el saliente');
  if (inboundIds.length > 0) {
    const covered = await tx
      .update(message)
      .set({ status: 'answered', replyId: outbound.id })
      .where(and(inArray(message.id, inboundIds), eq(message.status, 'pending')))
      .returning({ id: message.id });
    if (covered.length !== inboundIds.length) {
      throw new Error('Algún entrante ya no estaba pendiente');
    }
  }
  return outbound.id;
}

/** Marca el saliente como enviado; `replyTrace` sustituye al guardado (latencia final). */
export async function markSent(
  tx: DbOrTx,
  id: string,
  channelMessageId: string,
  sentAt: Date,
  replyTrace?: ReplyTrace,
): Promise<void> {
  await tx
    .update(message)
    .set({
      status: 'sent',
      channelMessageId,
      sentAt,
      ...(replyTrace === undefined ? {} : { replyTrace }),
    })
    .where(eq(message.id, id));
}

export async function markFailed(tx: DbOrTx, id: string): Promise<void> {
  await tx.update(message).set({ status: 'failed' }).where(eq(message.id, id));
}

/** Borra los entrantes pendientes (negocio desactivado, FR-002). Devuelve cuántos. */
export async function deletePending(tx: DbOrTx, conversationId: string): Promise<number> {
  const rows = await tx
    .delete(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.direction, 'inbound'),
        eq(message.status, 'pending'),
      ),
    )
    .returning({ id: message.id });
  return rows.length;
}

/** Marca entrantes pendientes como descartados (fuera de la ventana, FR-002a). */
export async function markDiscarded(tx: DbOrTx, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(message)
    .set({ status: 'discarded' })
    .where(and(inArray(message.id, ids), eq(message.status, 'pending')));
}

/** Entrantes del cliente recibidos después de `since`, cualquiera que sea su estado (R6). */
export async function countInboundSince(
  tx: DbOrTx,
  customerId: string,
  since: Date,
): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .where(
      and(
        eq(conversation.customerId, customerId),
        eq(message.direction, 'inbound'),
        gt(message.receivedAt, since),
      ),
    );
  return row?.n ?? 0;
}

/** Guarda el resultado de una transcripción: solo el texto, nunca el audio. */
export async function setTranscription(
  tx: DbOrTx,
  id: string,
  status: 'done' | 'failed',
  body: string | null,
): Promise<void> {
  await tx.update(message).set({ transcription: status, body }).where(eq(message.id, id));
}

export interface ConversationMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string | null;
  sentAt: Date;
  replyTrace: ReplyTrace | null;
  /** Entrante retenido al terminar la derivación (012): el panel lo marca. */
  held: boolean;
}

/** Cursor opaco: posición (sent_at, id) del último mensaje entregado. */
export function encodeCursor(m: { sentAt: Date; id: string }): string {
  return Buffer.from(`${m.sentAt.toISOString()}|${m.id}`, 'utf8').toString('base64url');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `null` si el cursor no es uno emitido por `encodeCursor`. */
export function decodeCursor(cursor: string): { sentAt: Date; id: string } | null {
  const [iso, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (rest.length > 0 || iso === undefined || id === undefined || !UUID_RE.test(id)) return null;
  const sentAt = new Date(iso);
  return Number.isNaN(sentAt.getTime()) || sentAt.toISOString() !== iso ? null : { sentAt, id };
}

/**
 * Mensajes visibles de una conversación para el playground y la web (R5, R6): entrantes
 * `pending`, `answered`, `rate_limited`, `forwarded` (005) o `held` (012) y salientes `sent`, en
 * orden. Con
 * `after`, solo los posteriores a ese cursor.
 */
export async function listForConversation(
  tx: DbOrTx,
  conversationId: string,
  after?: { sentAt: Date; id: string } | null,
): Promise<ConversationMessage[]> {
  const rows = await tx
    .select({
      id: message.id,
      direction: message.direction,
      status: message.status,
      body: message.body,
      sentAt: message.sentAt,
      replyTrace: message.replyTrace,
    })
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        or(
          and(
            eq(message.direction, 'inbound'),
            inArray(message.status, ['pending', 'answered', 'rate_limited', 'forwarded', 'held']),
          ),
          and(eq(message.direction, 'outbound'), eq(message.status, 'sent')),
        ),
        after
          ? sql`(${message.sentAt}, ${message.id}) > (${after.sentAt}, ${after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(message.sentAt), asc(message.id));
  return rows.map(({ status, ...r }) => ({
    ...r,
    replyTrace: (r.replyTrace as ReplyTrace | null) ?? null,
    held: status === 'held',
  }));
}

/** Hay entrantes del cliente pendientes de respuesta (el cliente sigue esperando). */
export async function hasPending(tx: DbOrTx, conversationId: string): Promise<boolean> {
  const [row] = await tx
    .select({ n: count() })
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        eq(message.direction, 'inbound'),
        eq(message.status, 'pending'),
      ),
    );
  return (row?.n ?? 0) > 0;
}
