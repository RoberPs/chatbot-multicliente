/**
 * Procesador de respuestas (research R5): espera de agrupado, lectura del snapshot sin caché,
 * generación, guardado y envío. El estado vive en la BD, así que se puede reanudar.
 *
 * Desde la 004 atiende todos los canales con la misma cadena; lo propio de cada uno (entrega,
 * ventana de 24 h, negocio activo, chat activado, tope) sale de su `ChannelPolicy`.
 */
import type { Db } from '../db/client.js';
import type { KnowledgeReader, KnowledgeSnapshot } from '../knowledge/types.js';
import { readWebChatSettings } from '../webchat/settings.js';
import { capReached, incrementWebUsage, readWebUsage, type QuotaWatch } from '../webchat/usage.js';
import type { ActivityLog, EventContext } from './activity-log.js';
import type { ChannelPolicies, ChannelPolicy } from './channels.js';
import { ChannelSendError, type ChatModel, type Clock } from './ports.js';
import * as conversations from './repositories/conversation.js';
import type { ConversationWithCustomer } from './repositories/conversation.js';
import * as messages from './repositories/message.js';
import type { InboundRow } from './repositories/message.js';
import {
  createResponder,
  rateLimitResponse,
  unavailableResponse,
  unreadableSnapshotReply,
  type Response,
} from './responder.js';
import { conversationSettings, type ConversationSettings } from './settings.js';
import type { HistoryTurn, MessageKind, PendingItem, ReplyTrace } from './types.js';

export interface ProcessorDeps {
  db: Db;
  reader: KnowledgeReader;
  chatModel: ChatModel;
  /** Qué hace cada canal: entrega, ventana, negocio activo, chat activado y tope (R1). */
  policies: ChannelPolicies;
  clock: Clock;
  activityLog: ActivityLog;
  /** Contacto de la instancia para cuando no se puede leer el snapshot (FR-029). */
  emergencyContactPhone: string | null;
  /** AUDIO_TRANSCRIPTION (por defecto apagado). */
  audioTranscription?: boolean;
  /** Registra `web_quota_reached` una vez por periodo (compartido con la recepción). */
  quotaWatch?: QuotaWatch;
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

/** Información técnica de la respuesta (R7): sin textos ni valores rechazados. */
const traceOf = (response: Response, latencyMs: number): ReplyTrace => ({
  template: response.template ?? null,
  greeting: response.greeting,
  contact: { added: response.contactBlock, reason: response.contactReason },
  groundingRejections: response.groundingRejections,
  modelMs: response.modelMs === undefined ? null : Math.max(0, Math.round(response.modelMs)),
  latencyMs: Math.max(0, Math.round(latencyMs)),
});

export function createProcessor(deps: ProcessorDeps): Processor {
  const { db, reader, clock, activityLog, policies } = deps;
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

  type LogContext = Required<EventContext>;

  const contextOf = (conversation: ConversationWithCustomer): LogContext => ({
    channel: conversation.channel,
    customerKey: conversation.channelUserId,
    conversationId: conversation.id,
  });

  /** Dentro de la ventana del canal para responder (FR-002a); sin ventana, siempre. */
  const insideWindow = (policy: ChannelPolicy, lastInboundAt: Date) =>
    policy.replyWindowMs === null ||
    clock.now().getTime() - lastInboundAt.getTime() <= policy.replyWindowMs;

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

  /** Marca los pendientes como descartados y lo registra, uno por mensaje. */
  async function discardPending(
    pending: InboundRow[],
    reason: 'outside_window' | 'disabled',
    logContext: LogContext,
  ): Promise<void> {
    await messages.markDiscarded(
      db,
      pending.map((m) => m.id),
    );
    for (let i = 0; i < pending.length; i++) {
      activityLog.log({ event: 'message_discarded', reason }, logContext);
    }
  }

  /** Tope del chat web alcanzado ahora (R9); `false` si el canal no tiene tope. */
  async function webCapReached(
    policy: ChannelPolicy,
    snapshot: KnowledgeSnapshot | null,
  ): Promise<boolean> {
    if (!policy.usageCap || !snapshot) return false;
    const now = clock.now();
    const timezone = snapshot.business.timezone;
    const current = await readWebChatSettings(db);
    const period = capReached(await readWebUsage(db, now, timezone), current);
    if (period) deps.quotaWatch?.reached(period, current, now, timezone);
    return period !== null;
  }

  /**
   * Guarda el saliente (cubriendo los entrantes en la misma transacción, con su `reply_trace` y
   * sumando al uso del chat web si toca), lo entrega y registra el resultado. Si el envío
   * falla, los entrantes siguen contestados: no se repite.
   */
  async function deliver(args: {
    conversation: ConversationWithCustomer;
    policy: ChannelPolicy;
    snapshot: KnowledgeSnapshot | null;
    response: Response;
    covered: InboundRow[];
    startedAt: Date;
    lastReceived: number;
  }): Promise<void> {
    const { conversation, policy, snapshot, response, covered, startedAt, lastReceived } = args;
    const conversationId = conversation.id;
    const logContext = contextOf(conversation);
    const outboundId = await db.transaction(async (tx) => {
      const at = clock.now();
      const id = await messages.createOutboundCovering(
        tx,
        conversationId,
        response.text,
        covered.map((m) => m.id),
        at,
        traceOf(response, at.getTime() - lastReceived),
      );
      await conversations.touchMessage(tx, conversationId, at);
      if (response.greeting) await conversations.markGreeted(tx, conversationId);
      // R9: cada respuesta web cuenta, salvo R-UNAVAILABLE (que es la del tope).
      if (policy.usageCap && snapshot && response.template !== 'R-UNAVAILABLE') {
        await incrementWebUsage(tx, at, snapshot.business.timezone);
      }
      return id;
    });

    try {
      const { channelMessageId } = await policy.sender.sendText(
        conversation.channelUserId,
        response.text,
        // No se reintenta si la ventana se ha cerrado mientras tanto.
        { canRetry: () => insideWindow(policy, conversation.lastInboundAt) },
      );
      const sentAt = clock.now();
      const latencyMs = sentAt.getTime() - lastReceived;
      await messages.markSent(db, outboundId, channelMessageId, sentAt, traceOf(response, latencyMs));
      await conversations.touchMessage(db, conversationId, sentAt);
      activityLog.log(
        {
          event: 'reply_sent',
          messagesCovered: covered.length,
          kinds: [...new Set(covered.map((m) => m.kind))],
          latencyMs,
          waitMs: startedAt.getTime() - lastReceived,
          ...(response.modelMs === undefined ? {} : { modelMs: response.modelMs }),
          greeting: response.greeting,
          contactBlock: response.contactBlock,
          ...(response.template ? { template: response.template } : {}),
          groundingRejections: response.groundingRejections,
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
    const conversation = await conversations.findWithCustomer(db, conversationId);
    if (!conversation) return;
    const logContext = contextOf(conversation);
    const policy = policies[conversation.channel];
    if (!policy) {
      // Canal que ya no está configurado (p. ej. WhatsApp retirado): no se puede contestar.
      await discardPending(await messages.pendingFor(db, conversationId), 'disabled', logContext);
      return;
    }

    // FR-029: si no se puede leer, se contesta igualmente con el contacto de emergencia.
    const snapshot = await readSnapshot(logContext);
    if (policy.requiresActiveBusiness && snapshot && snapshot.status !== 'active') {
      // FR-002: nada puede quedar guardado para contestarse después.
      const removed = await messages.deletePending(db, conversationId);
      for (let i = 0; i < removed; i++) {
        activityLog.log({ event: 'message_discarded', reason: 'deactivated' }, logContext);
      }
      return;
    }

    const pending = await messages.pendingFor(db, conversationId);
    if (pending.length === 0) return;
    if (policy.requiresWebChatEnabled && !(await readWebChatSettings(db)).enabled) {
      // US2-5: desactivado entre la recepción y la respuesta → sin respuesta.
      await discardPending(pending, 'disabled', logContext);
      return;
    }
    if (!insideWindow(policy, conversation.lastInboundAt)) {
      // FR-002a: fuera de la ventana de 24 h WhatsApp no deja contestar.
      await discardPending(pending, 'outside_window', logContext);
      return;
    }
    const startedAt = clock.now();
    const lastReceived = Math.max(...pending.map((m) => m.receivedAt.getTime()));

    let response: Response;
    if (!snapshot) {
      response = unreadableSnapshotReply(deps.emergencyContactPhone);
    } else if (await webCapReached(policy, snapshot)) {
      // SC-006: con el tope alcanzado no se llama al modelo.
      response = unavailableResponse(snapshot, deps.emergencyContactPhone);
    } else {
      response = await responder.respond({
        snapshot,
        history: (await messages.history(db, conversationId, settings.historyLimit)).map(
          (h): HistoryTurn => ({ direction: h.direction, text: historyText(h) }),
        ),
        pending: pending.map(pendingItem),
        greeted: conversation.greeted,
        now: startedAt,
        channel: conversation.channel,
        customerKey: conversation.channelUserId,
        conversationId,
      });
    }

    await deliver({
      conversation,
      policy,
      snapshot,
      response,
      covered: pending,
      startedAt,
      lastReceived,
    });
  }

  /** R-LIMIT con CONTACTO, sin modelo ni espera (FR-004a, R6). Igual en todos los canales. */
  async function rateLimitNotice(conversationId: string): Promise<void> {
    const conversation = await conversations.findWithCustomer(db, conversationId);
    if (!conversation) return;
    const policy = policies[conversation.channel];
    if (!policy) return;
    const snapshot = await readSnapshot(contextOf(conversation));
    if (policy.requiresActiveBusiness && snapshot && snapshot.status !== 'active') return;
    if (policy.requiresWebChatEnabled && !(await readWebChatSettings(db)).enabled) return;
    const startedAt = clock.now();
    await deliver({
      conversation,
      policy,
      snapshot,
      response: rateLimitResponse(snapshot, deps.emergencyContactPhone),
      covered: [],
      startedAt,
      lastReceived: startedAt.getTime(),
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
