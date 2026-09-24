/**
 * Procesador de respuestas (research R5): espera de agrupado, lectura del snapshot sin caché,
 * generación, guardado y envío. El estado vive en la BD, así que se puede reanudar.
 */
import type { Db } from '../db/client.js';
import type { KnowledgeReader, KnowledgeSnapshot } from '../knowledge/types.js';
import type { ActivityLog } from './activity-log.js';
import { ChannelSendError, type ChannelSender, type ChatModel, type Clock } from './ports.js';
import * as conversations from './repositories/conversation.js';
import * as messages from './repositories/message.js';
import { createResponder } from './responder.js';
import { conversationSettings, type ConversationSettings } from './settings.js';
import type { HistoryTurn, MessageKind, PendingItem } from './types.js';

export interface ProcessorDeps {
  db: Db;
  reader: KnowledgeReader;
  chatModel: ChatModel;
  sender: ChannelSender;
  clock: Clock;
  activityLog: ActivityLog;
  /** Contacto de la instancia para cuando no se puede leer el snapshot (FR-029). */
  emergencyContactPhone: string | null;
  settings?: ConversationSettings;
}

export interface Processor {
  /** Una conversación tiene mensajes nuevos: programa su revisión tras la espera. */
  wake(conversationId: string): void;
  /** Arranca los temporizadores y retoma los pendientes. */
  start(): void;
  /** Para los temporizadores y espera a las respuestas en curso. */
  stop(): Promise<void>;
  /** Atiende ahora todas las conversaciones listas (tests y herramientas). */
  runOnce(): Promise<void>;
}

const historyText = (row: { body: string | null; kind: MessageKind; otherType: string | null }) =>
  row.body ?? `[${row.otherType ?? row.kind}]`;

export function createProcessor(deps: ProcessorDeps): Processor {
  const { db, reader, sender, clock, activityLog } = deps;
  const settings = deps.settings ?? conversationSettings;
  const responder = createResponder({
    chatModel: deps.chatModel,
    clock,
    activityLog,
    settings,
  });

  const inFlight = new Map<string, Promise<void>>();
  const timers = new Map<string, NodeJS.Timeout>();
  let sweep: NodeJS.Timeout | null = null;
  let running = false;

  async function claim(limit: number, alsoExclude: Iterable<string> = []): Promise<string[]> {
    if (limit <= 0) return [];
    return db.transaction((tx) =>
      conversations.claimReady(tx, clock.now(), {
        quietMs: settings.batchQuietMs,
        maxWaitMs: settings.batchMaxWaitMs,
        limit,
        excludeIds: [...inFlight.keys(), ...alsoExclude],
      }),
    );
  }

  async function processConversation(conversationId: string): Promise<void> {
    const conversation = await conversations.findWithPhone(db, conversationId);
    if (!conversation) return;
    const logContext = { phone: conversation.phone, conversationId };

    let snapshot: KnowledgeSnapshot;
    try {
      snapshot = await reader.getSnapshot();
    } catch (error) {
      // Se deja pendiente: se reintenta en el siguiente barrido.
      activityLog.log(
        { event: 'knowledge_read_failed', errorClass: (error as Error).name, stage: 'processor' },
        logContext,
      );
      return;
    }

    if (snapshot.status !== 'active') {
      // FR-002: nada puede quedar guardado para contestarse después.
      const removed = await messages.deletePending(db, conversationId);
      for (let i = 0; i < removed; i++) {
        activityLog.log({ event: 'message_discarded', reason: 'deactivated' }, logContext);
      }
      return;
    }

    const pending = await messages.pendingFor(db, conversationId);
    if (pending.length === 0) return;
    const history = await messages.history(db, conversationId, settings.historyLimit);
    const startedAt = clock.now();
    const lastReceived = Math.max(...pending.map((m) => m.receivedAt.getTime()));

    const response = await responder.respond({
      snapshot,
      history: history.map((h): HistoryTurn => ({ direction: h.direction, text: historyText(h) })),
      pending: pending.map((m): PendingItem => ({ kind: m.kind, text: m.body })),
      now: startedAt,
      phone: conversation.phone,
      conversationId,
    });

    const outboundId = await db.transaction(async (tx) => {
      const at = clock.now();
      const id = await messages.createOutboundCovering(
        tx,
        conversationId,
        response.text,
        pending.map((m) => m.id),
        at,
      );
      await conversations.touchMessage(tx, conversationId, at);
      return id;
    });

    try {
      const { channelMessageId } = await sender.sendText(conversation.phone, response.text);
      const sentAt = clock.now();
      await messages.markSent(db, outboundId, channelMessageId, sentAt);
      await conversations.touchMessage(db, conversationId, sentAt);
      activityLog.log(
        {
          event: 'reply_sent',
          messagesCovered: pending.length,
          kinds: [...new Set(pending.map((m) => m.kind))],
          latencyMs: sentAt.getTime() - lastReceived,
          waitMs: startedAt.getTime() - lastReceived,
          ...(response.modelMs === undefined ? {} : { modelMs: response.modelMs }),
          greeting: response.greeting,
          contactBlock: response.contactBlock,
          ...(response.template ? { template: response.template } : {}),
        },
        logContext,
      );
    } catch (error) {
      // Los entrantes quedan contestados: no se genera otra respuesta.
      await messages.markFailed(db, outboundId);
      activityLog.log(
        {
          event: 'send_failed',
          attempts: error instanceof ChannelSendError ? error.attempts : 1,
          ...(error instanceof ChannelSendError && error.status !== undefined
            ? { status: error.status }
            : {}),
          finalFailure: true,
        },
        logContext,
      );
    }
  }

  function track(conversationId: string): Promise<void> {
    const job = processConversation(conversationId)
      .catch(() => {
        // Error inesperado (BD): los pendientes siguen ahí y se reintentan en el barrido.
      })
      .finally(() => inFlight.delete(conversationId));
    inFlight.set(conversationId, job);
    return job;
  }

  /** Reclama lo que quepa sin esperar a que termine (modo servidor). */
  async function tick(): Promise<void> {
    try {
      const ids = await claim(settings.processorConcurrency - inFlight.size);
      for (const id of ids) void track(id);
    } catch {
      // BD no disponible: se reintenta en el siguiente barrido.
    }
  }

  return {
    wake(conversationId) {
      if (!running) return;
      clearTimeout(timers.get(conversationId));
      timers.set(
        conversationId,
        setTimeout(() => {
          timers.delete(conversationId);
          void tick();
        }, settings.batchQuietMs + 50),
      );
    },

    start() {
      if (running) return;
      running = true;
      sweep = setInterval(() => void tick(), settings.processorSweepMs);
      // Los pendientes que quedaron sin procesar se retoman en el primer barrido.
      void tick();
    },

    async stop() {
      running = false;
      if (sweep) clearInterval(sweep);
      sweep = null;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      await Promise.all(inFlight.values());
    },

    async runOnce() {
      // Cada conversación, una vez por pasada: si queda pendiente, espera al siguiente barrido.
      const done = new Set<string>();
      for (;;) {
        const ids = await claim(settings.processorConcurrency, done);
        if (ids.length === 0) return;
        for (const id of ids) done.add(id);
        await Promise.all(ids.map(track));
      }
    },
  };
}
