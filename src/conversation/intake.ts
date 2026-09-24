/**
 * Recepción de mensajes (research R2, R3; contracts/whatsapp-webhook.md).
 *
 * Guarda cada entrante en una transacción antes de que el webhook responda. Si el negocio no
 * está activo no guarda nada (FR-002). Los errores se propagan: el webhook responde 503 y
 * Meta reintenta; la deduplicación hace inocuos los reintentos.
 */
import type { Db } from '../db/client.js';
import type { KnowledgeReader } from '../knowledge/types.js';
import type { ActivityLog } from './activity-log.js';
import type { Clock } from './ports.js';
import * as conversations from './repositories/conversation.js';
import { upsertByPhone } from './repositories/customer.js';
import { insertInbound } from './repositories/message.js';
import { conversationSettings, type ConversationSettings } from './settings.js';
import type { InboundEvent } from './types.js';

export interface IntakeDeps {
  db: Db;
  reader: KnowledgeReader;
  clock: Clock;
  activityLog: ActivityLog;
  /** Avisa al procesador de que una conversación tiene mensajes nuevos. */
  wake?: (conversationId: string) => void;
  settings?: ConversationSettings;
}

export interface Intake {
  handle(events: InboundEvent[]): Promise<void>;
}

/** Deshace la transacción de un duplicado (no deja una conversación vacía). */
class DuplicateMessage extends Error {}

export function createIntake(deps: IntakeDeps): Intake {
  const { db, reader, clock, activityLog } = deps;
  const settings = deps.settings ?? conversationSettings;

  async function store(event: InboundEvent): Promise<string | null> {
    const receivedAt = clock.now();
    try {
      return await db.transaction(async (tx) => {
        const customer = await upsertByPhone(tx, event.from);
        const latest = await conversations.findLatestForCustomer(tx, customer.id);
        // FR-019: conversación nueva si no hay ninguna o han pasado más de 24 h.
        const conversation =
          latest &&
          event.sentAt.getTime() - latest.lastInboundAt.getTime() <= settings.conversationWindowMs
            ? latest
            : await conversations.create(tx, {
                customerId: customer.id,
                sentAt: event.sentAt,
                receivedAt,
              });
        const inserted = await insertInbound(tx, {
          conversationId: conversation.id,
          waMessageId: event.waMessageId,
          kind: event.kind,
          body: event.kind === 'other' ? event.caption : event.text,
          otherType: event.otherType,
          sentAt: event.sentAt,
          receivedAt,
          status: 'pending',
        });
        if (!inserted.inserted) throw new DuplicateMessage();
        await conversations.touchInbound(tx, conversation.id, event.sentAt, receivedAt);
        return conversation.id;
      });
    } catch (error) {
      if (error instanceof DuplicateMessage) return null;
      throw error;
    }
  }

  return {
    async handle(events) {
      let snapshot;
      try {
        snapshot = await reader.getSnapshot();
      } catch (error) {
        activityLog.log({
          event: 'knowledge_read_failed',
          errorClass: (error as Error).name,
          stage: 'intake',
        });
        throw error;
      }
      if (snapshot.status !== 'active') {
        for (const event of events) {
          activityLog.log(
            { event: 'message_discarded', reason: 'not_active' },
            { phone: event.from },
          );
        }
        return;
      }

      const woken = new Set<string>();
      for (const event of events) {
        const conversationId = await store(event);
        if (conversationId === null) {
          activityLog.log({ event: 'duplicate_ignored' }, { phone: event.from });
          continue;
        }
        activityLog.log(
          {
            event: 'message_received',
            kind: event.kind,
            ...(event.otherType ? { otherType: event.otherType } : {}),
          },
          { phone: event.from, conversationId },
        );
        woken.add(conversationId);
      }
      for (const id of woken) deps.wake?.(id);
    },
  };
}
