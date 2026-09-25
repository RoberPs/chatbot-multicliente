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
import type { InboundRow } from './repositories/message.js';
import {
  createResponder,
  rateLimitResponse,
  unreadableSnapshotReply,
  type Response,
} from './responder.js';
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
  /** AUDIO_TRANSCRIPTION (por defecto apagado). */
  audioTranscription?: boolean;
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
  /** Envía ya el aviso de límite a una conversación (lo pide la recepción). */
  sendRateLimitNotice(conversationId: string): Promise<void>;
}

const historyText = (row: { body: string | null; kind: MessageKind; otherType: string | null }) =>
  row.body ?? `[${row.otherType ?? row.kind}]`;

/** Un audio solo cuenta como entendido si su transcripción terminó bien. */
const pendingItem = (m: InboundRow): PendingItem =>
  m.kind === 'audio'
    ? { kind: 'audio', text: m.body, audioUnderstood: m.transcription === 'done' && !!m.body }
    : { kind: m.kind, text: m.body };

export function createProcessor(deps: ProcessorDeps): Processor {
  const { db, reader, sender, clock, activityLog } = deps;
  const settings = deps.settings ?? conversationSettings;
  const responder = createResponder({
    chatModel: deps.chatModel,
    clock,
    activityLog,
    audioTranscription: deps.audioTranscription ?? false,
    settings,
  });

  const inFlight = new Map<string, Promise<void>>();
  const notices = new Set<Promise<void>>();
  const timers = new Map<string, NodeJS.Timeout>();
  let sweep: NodeJS.Timeout | null = null;
  let running = false;

  async function claim(limit: number, alsoExclude: Iterable<string> = []): Promise<string[]> {
    if (limit <= 0) return [];
    return db.transaction((tx) =>
      conversations.claimReady(tx, clock.now(), {
        quietMs: settings.batchQuietMs,
        maxWaitMs: settings.batchMaxWaitMs,
        transcriptionWaitMs: settings.transcriptionTimeoutMs,
        limit,
        excludeIds: [...inFlight.keys(), ...alsoExclude],
      }),
    );
  }

  type LogContext = { phone: string; conversationId: string };

  const insideWindow = (lastInboundAt: Date) =>
    clock.now().getTime() - lastInboundAt.getTime() <= settings.conversationWindowMs;

  /** Snapshot sin caché; `null` si no se puede leer (FR-029). */
  async function readSnapshot(logContext: LogContext): Promise<KnowledgeSnapshot | null> {
    try {
      return await reader.getSnapshot();
    } catch (error) {
      activityLog.log(
        { event: 'knowledge_read_failed', errorClass: (error as Error).name, stage: 'processor' },
        logContext,
      );
      return null;
    }
  }

  /**
   * Guarda el saliente (cubriendo los entrantes en la misma transacción), lo envía y registra
   * el resultado. Si el envío falla, los entrantes siguen contestados: no se repite.
   */
  async function deliver(args: {
    conversationId: string;
    phone: string;
    response: Response;
    covered: InboundRow[];
    startedAt: Date;
    lastReceived: number;
    /** Último mensaje del cliente: marca la ventana de 24 h de WhatsApp (FR-002a). */
    lastInboundAt: Date;
  }): Promise<void> {
    const { conversationId, phone, response, covered, startedAt, lastReceived } = args;
    const logContext = { phone, conversationId };
    const outboundId = await db.transaction(async (tx) => {
      const at = clock.now();
      const id = await messages.createOutboundCovering(
        tx,
        conversationId,
        response.text,
        covered.map((m) => m.id),
        at,
      );
      await conversations.touchMessage(tx, conversationId, at);
      if (response.greeting) await conversations.markGreeted(tx, conversationId);
      return id;
    });

    try {
      const { channelMessageId } = await sender.sendText(phone, response.text, {
        // No se reintenta si la ventana se ha cerrado mientras tanto.
        canRetry: () => insideWindow(args.lastInboundAt),
      });
      const sentAt = clock.now();
      await messages.markSent(db, outboundId, channelMessageId, sentAt);
      await conversations.touchMessage(db, conversationId, sentAt);
      activityLog.log(
        {
          event: 'reply_sent',
          messagesCovered: covered.length,
          kinds: [...new Set(covered.map((m) => m.kind))],
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

  async function processConversation(conversationId: string): Promise<void> {
    const conversation = await conversations.findWithPhone(db, conversationId);
    if (!conversation) return;
    const logContext = { phone: conversation.phone, conversationId };

    // FR-029: si no se puede leer, se contesta igualmente con el contacto de emergencia.
    const snapshot = await readSnapshot(logContext);
    if (snapshot && snapshot.status !== 'active') {
      // FR-002: nada puede quedar guardado para contestarse después.
      const removed = await messages.deletePending(db, conversationId);
      for (let i = 0; i < removed; i++) {
        activityLog.log({ event: 'message_discarded', reason: 'deactivated' }, logContext);
      }
      return;
    }

    const pending = await messages.pendingFor(db, conversationId);
    if (pending.length === 0) return;
    if (!insideWindow(conversation.lastInboundAt)) {
      // FR-002a: fuera de la ventana de 24 h WhatsApp no deja contestar.
      await messages.markDiscarded(
        db,
        pending.map((m) => m.id),
      );
      for (let i = 0; i < pending.length; i++) {
        activityLog.log({ event: 'message_discarded', reason: 'outside_window' }, logContext);
      }
      return;
    }
    const startedAt = clock.now();
    const lastReceived = Math.max(...pending.map((m) => m.receivedAt.getTime()));

    const response = snapshot
      ? await responder.respond({
          snapshot,
          history: (await messages.history(db, conversationId, settings.historyLimit)).map(
            (h): HistoryTurn => ({ direction: h.direction, text: historyText(h) }),
          ),
          pending: pending.map(pendingItem),
          greeted: conversation.greeted,
          now: startedAt,
          phone: conversation.phone,
          conversationId,
        })
      : unreadableSnapshotReply(deps.emergencyContactPhone);

    await deliver({
      conversationId,
      phone: conversation.phone,
      response,
      covered: pending,
      startedAt,
      lastReceived,
      lastInboundAt: conversation.lastInboundAt,
    });
  }

  /** R-LIMIT con CONTACTO, sin modelo ni espera (FR-004a, R6). */
  async function rateLimitNotice(conversationId: string): Promise<void> {
    const conversation = await conversations.findWithPhone(db, conversationId);
    if (!conversation) return;
    const snapshot = await readSnapshot({ phone: conversation.phone, conversationId });
    if (snapshot && snapshot.status !== 'active') return;
    const startedAt = clock.now();
    await deliver({
      conversationId,
      phone: conversation.phone,
      response: rateLimitResponse(snapshot, deps.emergencyContactPhone),
      covered: [],
      startedAt,
      lastReceived: startedAt.getTime(),
      lastInboundAt: conversation.lastInboundAt,
    });
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
      await Promise.all([...inFlight.values(), ...notices]);
    },

    sendRateLimitNotice(conversationId) {
      const job: Promise<void> = rateLimitNotice(conversationId)
        .catch(() => {
          // BD no disponible: el aviso se pierde; los mensajes siguen sin contestarse (R6).
        })
        .finally(() => notices.delete(job));
      notices.add(job);
      return job;
    },

    async runOnce() {
      await Promise.all(notices);
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
