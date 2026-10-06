/**
 * Procesador de respuestas (research R5): espera de agrupado, lectura del snapshot sin caché,
 * generación, guardado y envío. El estado vive en la BD, así que se puede reanudar.
 *
 * Desde la 004 atiende todos los canales con la misma cadena; lo propio de cada uno (entrega,
 * ventana de 24 h, negocio activo, chat activado, tope) sale de su `ChannelPolicy`.
 */
import type { Db } from '../db/client.js';
import { markCustomerNotified, type HandoffWithCustomer } from '../handoff/repositories/handoff.js';
import { attentionAt } from '../handoff/schedule.js';
import type { HandoffService } from '../handoff/service.js';
import type { HandoffKind } from '../handoff/types.js';
import {
  askContactReply,
  complaintContactReply,
  complaintReply,
  confirmedReply,
  failedReply,
  offerQuestion,
  phoneRetryReply,
} from '../handoff/templates.js';
import { localDay } from '../knowledge/time/local-date.js';
import type { KnowledgeReader, KnowledgeSnapshot } from '../knowledge/types.js';
import type { UsageRecording } from '../usage/meter.js';
import {
  canCallModel,
  canTranscribe,
  checkProtection,
  defaultProtectionConfig,
  type ProtectionConfig,
} from '../usage/protection.js';
import type { CapReason } from '../usage/types.js';
import { incrementWhatsappReplies } from '../usage/whatsapp-usage.js';
import { readWebChatSettings } from '../webchat/settings.js';
import { capReached, incrementWebUsage, readWebUsage, type QuotaWatch } from '../webchat/usage.js';
import type { ActivityLog, EventContext } from './activity-log.js';
import type { ChannelPolicies, ChannelPolicy } from './channels.js';
import { ChannelSendError, type ChatModel, type Clock } from './ports.js';
import * as conversations from './repositories/conversation.js';
import type { ConversationWithCustomer } from './repositories/conversation.js';
import * as messages from './repositories/message.js';
import type { InboundRow } from './repositories/message.js';
import type { DbOrTx } from './repositories/customer.js';
import {
  abandonedBatchReply,
  capResponse,
  composeReply,
  createResponder,
  rateLimitResponse,
  unavailableResponse,
  unreadableSnapshotReply,
  type Response,
} from './responder.js';
import { conversationSettings, type ConversationSettings } from './settings.js';
import { formOf } from './templates.js';
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
  /** Derivación al negocio (005); sin ella el bot responde como en la 004. */
  handoff?: HandoffService;
  /** Registro del consumo del modelo (010); sin él no se mide (bot:chat, eval). */
  usage?: UsageRecording;
  /**
   * Producción y modelos de la instancia (012, R1): deciden la protección. Sin ella, como fuera
   * de producción y sin audios.
   */
  protection?: ProtectionConfig;
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
  ...(response.capReason ? { capReason: response.capReason } : {}),
  ...(response.handoff ? { handoff: response.handoff } : {}),
});

/** Escrituras que van en la transacción del saliente (paso y datos de la derivación, 005). */
type TxWork = (tx: DbOrTx) => Promise<void>;

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
  let handoffSweep: NodeJS.Timeout | null = null;
  let handoffSweeping: Promise<void> | null = null;
  let running = false;

  async function claim(limit: number, alsoExclude: Iterable<string> = []): Promise<string[]> {
    if (limit <= 0) return [];
    return db.transaction((tx) =>
      conversations.claimReady(tx, clock.now(), {
        quietMs: settings.batchQuietMs,
        maxWaitMs: settings.batchMaxWaitMs,
        transcriptionWaitMs: settings.transcriptionTimeoutMs,
        limit,
        excludeIds: [...inFlight.keys(), ...alsoExclude, ...waiting()],
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
    inTx?: TxWork;
    /** La respuesta llamó al modelo: cuenta para el tope diario de WhatsApp (012, R5). */
    modelCalled?: boolean;
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
      await args.inTx?.(tx);
      // R9: cada respuesta web cuenta, salvo R-UNAVAILABLE (que es la del tope).
      if (policy.usageCap && snapshot && response.template !== 'R-UNAVAILABLE') {
        await incrementWebUsage(tx, at, snapshot.business.timezone);
      }
      // 012 (R5): cada respuesta de WhatsApp con modelo cuenta, haya o no consumo registrado.
      if (conversation.channel === 'whatsapp' && args.modelCalled && snapshot) {
        await incrementWhatsappReplies(tx, localDay(at, snapshot.business.timezone));
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
      await messages.markSent(
        db,
        outboundId,
        channelMessageId,
        sentAt,
        traceOf(response, latencyMs),
      );
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
          ...(response.handoff ? { handoffAction: response.handoff.action } : {}),
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

  const protectionConfig = deps.protection ?? defaultProtectionConfig(deps.usage?.model ?? '');

  /**
   * Motivo por el que este lote no puede llamar al modelo ahora (012, R1 – R6): tope de gasto
   * (010), tope diario de WhatsApp o un motivo de solo contacto; `null` si puede o si el canal no
   * se corta ("Probar el bot", 010 FR-019). Con audios en el lote, también si no se pueden
   * transcribir (el transcriptor ya no los descargó). Emite los eventos de cada periodo.
   */
  async function protectionBlock(
    policy: ChannelPolicy,
    conversation: ConversationWithCustomer,
    snapshot: KnowledgeSnapshot,
    pending: InboundRow[],
    logContext: LogContext,
  ): Promise<CapReason | null> {
    if (!policy.spendCap || conversation.channel === 'playground') return null;
    const state = await checkProtection(
      db,
      { ...protectionConfig, now: clock.now(), timezone: snapshot.business.timezone },
      activityLog,
      logContext,
    );
    const withAudio = (deps.audioTranscription ?? false) && pending.some((m) => m.kind === 'audio');
    const decision = withAudio
      ? canTranscribe(state, conversation.channel)
      : canCallModel(state, conversation.channel);
    return decision.ok ? null : decision.reason;
  }

  /**
   * Consumo de la respuesta (010, R3): tras el modelo y antes de entregar, fuera de la
   * transacción del saliente. Nunca impide responder (FR-005).
   */
  async function recordUsage(
    response: Response,
    channel: ConversationWithCustomer['channel'],
    timezone: string,
    logContext: LogContext,
  ): Promise<void> {
    if (!deps.usage || !response.usage) return;
    try {
      await deps.usage.meter.record(
        {
          channel,
          purpose: 'reply',
          model: deps.usage.model,
          usage: response.usage,
          at: clock.now(),
          timezone,
        },
        logContext,
      );
    } catch {
      // El medidor real no lanza (registra usage_record_failed); esto cubre cualquier otro.
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
    // 005, FR-013: con una derivación activa el bot calla y reenvía el lote al negocio.
    const active = deps.handoff ? await deps.handoff.active(db, conversationId) : null;
    if (
      deps.handoff &&
      active &&
      snapshot &&
      (active.alertsSentAt === null || active.customerNotifiedAt === null)
    ) {
      // 012 (R10.4): un reintento tras un fallo a mitad de iniciar la derivación.
      if (!insideWindow(policy, conversation.lastInboundAt)) {
        await discardPending(pending, 'outside_window', logContext);
        return;
      }
      await deliver({
        conversation,
        policy,
        snapshot,
        covered: pending,
        startedAt: clock.now(),
        lastReceived: Math.max(...pending.map((m) => m.receivedAt.getTime())),
        ...(await resumeHandoff(deps.handoff, active, conversation, policy, snapshot)),
      });
      return;
    }
    if (deps.handoff && active) {
      await deps.handoff.forward({
        handoff: active,
        pending,
        snapshot,
        simulate: policy.simulateAlerts,
        logContext,
      });
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
    let modelCalled = false;
    const webCap = await webCapReached(policy, snapshot);
    const blocked =
      snapshot && !webCap
        ? await protectionBlock(policy, conversation, snapshot, pending, logContext)
        : null;
    if (!snapshot) {
      response = unreadableSnapshotReply(deps.emergencyContactPhone);
    } else if (webCap) {
      // SC-006: con el tope alcanzado no se llama al modelo.
      response = unavailableResponse(snapshot, deps.emergencyContactPhone);
    } else if (blocked !== null) {
      // 010 (FR-016 – FR-018) y 012 (R4): sin modelo y siempre con contacto. En la web, "no
      // disponible"; en WhatsApp, R-CAP, que deja abrir la derivación con el detector determinista.
      response = {
        ...(policy.usageCap
          ? unavailableResponse(snapshot, deps.emergencyContactPhone)
          : capResponse(
              snapshot,
              deps.emergencyContactPhone,
              pending.map((m) => m.body).filter((t): t is string => t !== null),
            )),
        capReason: blocked,
      };
      if (blocked !== 'spend_cap') {
        activityLog.log({ event: 'contact_only_reply', reason: blocked }, logContext);
      }
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
        handoffStep: conversation.handoffStep,
        // FR-018: tras una derivación terminada el bot tiene en cuenta lo hablado y no saluda.
        handoffEnded: deps.handoff ? await deps.handoff.hasEnded(conversationId) : false,
      });
      modelCalled = true;
      await recordUsage(response, conversation.channel, snapshot.business.timezone, logContext);
    }

    const turn =
      snapshot && response.model
        ? await handoffTurn({ conversation, policy, snapshot, response, pending })
        : { response };

    await deliver({
      conversation,
      policy,
      snapshot,
      response: turn.response,
      covered: pending,
      startedAt,
      lastReceived,
      inTx: turn.inTx,
      modelCalled,
    });
  }

  /**
   * Decisión de la derivación sobre la salida del modelo (005, contracts/handoff-flow.md):
   * pedir los datos, iniciar (avisando al negocio antes de responder) o dejar la respuesta de
   * la 002. Devuelve la respuesta final y lo que se guarda con el saliente.
   */
  async function handoffTurn(args: {
    conversation: ConversationWithCustomer;
    policy: ChannelPolicy;
    snapshot: KnowledgeSnapshot;
    response: Response;
    pending: InboundRow[];
  }): Promise<{ response: Response; inTx?: TxWork }> {
    const { conversation, policy, snapshot, response, pending } = args;
    const service = deps.handoff;
    const model = response.model;
    if (!service || !model) return { response };
    const conversationId = conversation.id;
    const logContext = contextOf(conversation);
    const form = formOf(snapshot.tone.addressForm);
    const business = snapshot.business.name;
    const knownPhone = policy.contactFromChannel
      ? conversation.channelUserId
      : conversation.contactPhone;
    const decision = service.decide({
      step: conversation.handoffStep,
      reply: model.reply,
      detector: model.handoffDetected,
      hasRoutes: await service.hasRoutes(policy.simulateAlerts),
      contactFromChannel: policy.contactFromChannel,
      known: { name: conversation.contactName, phone: knownPhone },
      texts: pending.map((m) => m.body).filter((t): t is string => t !== null),
    });
    const clearStep: TxWork | undefined =
      conversation.handoffStep === null
        ? undefined
        : (tx) => conversations.setHandoffStep(tx, conversationId, null);
    /** Plantilla de la derivación: sustituye al cuerpo del modelo (R3). */
    const fixed = (
      body: string,
      template: 'R-HANDOFF-ASK' | 'R-HANDOFF-PHONE' | 'R-HANDOFF-OK' | 'R-HANDOFF-COMPLAINT',
    ) => ({
      ...composeReply({
        snapshot,
        greeted: conversation.greeted,
        body,
        reason: null,
        template,
        groundingRejections: response.groundingRejections,
      }),
      modelMs: response.modelMs,
    });
    /**
     * Salida a una persona sin derivación (FR-004, FR-012), siempre con CONTACTO: si es una
     * queja, la disculpa de R-HANDOFF-COMPLAINT (FR-003); si el aviso no se entregó, R-HANDOFF-FAIL,
     * porque el cuerpo del modelo puede haber prometido el contacto; si el cliente no dio sus
     * datos, el cuerpo del modelo.
     */
    const withContact = (reason: 'handoff_unavailable' | 'contact_refused', kind: HandoffKind) => ({
      ...composeReply({
        snapshot,
        greeted: conversation.greeted,
        reason,
        fileNotice: model.fileNotice,
        groundingRejections: response.groundingRejections,
        ...(kind === 'complaint'
          ? {
              body: complaintContactReply(business, form),
              template: 'R-HANDOFF-COMPLAINT' as const,
            }
          : reason === 'handoff_unavailable'
            ? { body: failedReply(business, form), template: 'R-HANDOFF-FAIL' as const }
            : { body: model.reply.body }),
      }),
      modelMs: response.modelMs,
    });

    switch (decision.type) {
      case 'normal': {
        const request = model.reply.handoffRequested || model.handoffDetected;
        if (!request) return { response, inTx: clearStep };
        // Fila 4: petición sin vías → el contacto de la 002.
        activityLog.log(
          { event: 'handoff_not_started', kind: 'person', reason: 'no_routes' },
          logContext,
        );
        return {
          response: { ...response, handoff: { action: 'not_started', kind: 'person', routes: {} } },
          inTx: clearStep,
        };
      }
      case 'complaint_contact': {
        // Fila 2: queja sin vías → disculpa + CONTACTO, sin el cuerpo del modelo.
        activityLog.log(
          { event: 'handoff_not_started', kind: 'complaint', reason: 'no_routes' },
          logContext,
        );
        return {
          response: {
            ...withContact('handoff_unavailable', 'complaint'),
            handoff: { action: 'not_started', kind: 'complaint', routes: {} },
          },
          inTx: clearStep,
        };
      }
      case 'offer': {
        // Fila 7: cuerpo del modelo + OFERTA, sin CONTACTO (FR-002).
        activityLog.log({ event: 'handoff_offered' }, logContext);
        return {
          response: {
            ...composeReply({
              snapshot,
              greeted: conversation.greeted,
              body: model.reply.body,
              reason: null,
              fileNotice: model.fileNotice,
              groundingRejections: response.groundingRejections,
              closing: offerQuestion(business, form),
            }),
            modelMs: response.modelMs,
            handoff: { action: 'offered', kind: 'unresolved', routes: {} },
          },
          inTx: (tx) => conversations.setHandoffStep(tx, conversationId, decision.step),
        };
      }
      case 'ask': {
        activityLog.log(
          { event: 'handoff_contact_requested', missing: decision.missing, retry: decision.retry },
          logContext,
        );
        const body = decision.retry
          ? phoneRetryReply(form)
          : askContactReply(decision.missing, business, form);
        return {
          response: {
            ...fixed(body, decision.retry ? 'R-HANDOFF-PHONE' : 'R-HANDOFF-ASK'),
            handoff: {
              action: decision.retry ? 'asked_again' : 'asked',
              kind: decision.kind,
              routes: {},
            },
          },
          inTx: async (tx) => {
            await conversations.setContact(tx, conversationId, decision.save);
            await conversations.setHandoffStep(tx, conversationId, decision.step);
          },
        };
      }
      case 'refused': {
        activityLog.log(
          { event: 'handoff_not_started', kind: decision.kind, reason: 'contact_refused' },
          logContext,
        );
        return {
          response: {
            ...withContact('contact_refused', decision.kind),
            handoff: { action: 'not_started', kind: decision.kind, routes: {} },
          },
          inTx: async (tx) => {
            await conversations.setContact(tx, conversationId, decision.save);
            await conversations.setHandoffStep(tx, conversationId, null);
          },
        };
      }
      case 'start': {
        const name = decision.save.name ?? conversation.contactName;
        const phone = decision.save.phone ?? knownPhone;
        const saveContact: TxWork = (tx) =>
          conversations.setContact(tx, conversationId, {
            ...decision.save,
            // En WhatsApp el teléfono de contacto es el del canal (data-model.md).
            ...(policy.contactFromChannel && phone !== null ? { phone } : {}),
          });
        const result =
          name !== null && phone !== null
            ? await service.start({
                conversationId,
                channel: conversation.channel,
                kind: decision.kind,
                customerName: name,
                customerPhone: phone,
                snapshot,
                simulate: policy.simulateAlerts,
                logContext,
                // 010 (R9): con el tope de gasto alcanzado, sin resumen del modelo.
                modelSummary: response.template !== 'R-CAP',
              })
            : ({ started: false, routes: {} } as const);
        if (!result.started || phone === null) {
          return {
            response: {
              ...withContact('handoff_unavailable', decision.kind),
              handoff: { action: 'not_started', kind: decision.kind, routes: result.routes },
            },
            inTx: async (tx) => {
              await saveContact(tx);
              await conversations.setHandoffStep(tx, conversationId, null);
            },
          };
        }
        return {
          response: {
            ...(decision.kind === 'complaint'
              ? fixed(
                  complaintReply(business, phone, form, result.attention),
                  'R-HANDOFF-COMPLAINT',
                )
              : fixed(confirmedReply(business, phone, form, result.attention), 'R-HANDOFF-OK')),
            handoff: {
              action: 'started',
              kind: decision.kind,
              handoffId: result.handoffId,
              routes: result.routes,
            },
          },
          inTx: async (tx) => {
            await saveContact(tx);
            await result.persist(tx);
          },
        };
      }
    }
  }

  /**
   * Reintento con una derivación a medio iniciar (012, contracts/outbound-and-retries.md § Como
   * mucho una vez): sin constancia de la alerta, se termina (`interrupted`) y el cliente recibe
   * R-HANDOFF-FAIL con el contacto; con la alerta enviada pero sin confirmar al cliente, solo la
   * confirmación (sin volver a avisar al negocio).
   */
  async function resumeHandoff(
    service: HandoffService,
    active: HandoffWithCustomer,
    conversation: ConversationWithCustomer,
    policy: ChannelPolicy,
    snapshot: KnowledgeSnapshot,
  ): Promise<{ response: Response; inTx?: TxWork }> {
    const business = snapshot.business.name;
    const form = formOf(snapshot.tone.addressForm);
    const clearStep: TxWork = (tx) => conversations.setHandoffStep(tx, conversation.id, null);
    if (active.alertsSentAt === null) {
      await service.interrupt(active, contextOf(conversation));
      const complaint = active.kind === 'complaint';
      return {
        response: {
          ...composeReply({
            snapshot,
            greeted: conversation.greeted,
            reason: 'handoff_unavailable',
            body: complaint ? complaintContactReply(business, form) : failedReply(business, form),
            template: complaint ? 'R-HANDOFF-COMPLAINT' : 'R-HANDOFF-FAIL',
          }),
          handoff: { action: 'not_started', kind: active.kind, routes: {} },
        },
        inTx: clearStep,
      };
    }
    const phone =
      (policy.contactFromChannel ? conversation.channelUserId : conversation.contactPhone) ?? '';
    const attention = attentionAt(snapshot, active.startedAt);
    const complaint = active.kind === 'complaint';
    return {
      response: {
        ...composeReply({
          snapshot,
          greeted: conversation.greeted,
          reason: null,
          body: complaint
            ? complaintReply(business, phone, form, attention)
            : confirmedReply(business, phone, form, attention),
          template: complaint ? 'R-HANDOFF-COMPLAINT' : 'R-HANDOFF-OK',
        }),
        handoff: { action: 'started', kind: active.kind, handoffId: active.id, routes: {} },
      },
      inTx: async (tx) => {
        await clearStep(tx);
        await markCustomerNotified(tx, active.id, clock.now());
      },
    };
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

  /**
   * Esperas en memoria por si ni siquiera se puede guardar el intento (BD caída, 012 R10): la
   * conversación no se reclama en bucle mientras tanto.
   */
  const backoff = new Map<string, number>();
  const waiting = (): string[] => {
    const now = clock.now().getTime();
    for (const [id, until] of backoff) if (until <= now) backoff.delete(id);
    return [...backoff.keys()];
  };

  /**
   * Quinto fallo seguido (012, R10): R-ERR una sola vez cubriendo los pendientes, con el contacto
   * del negocio o el de emergencia, y el contador a 0. Un entrante nuevo empieza otro lote.
   */
  async function abandon(conversationId: string, attempts: number): Promise<void> {
    let apologySent = false;
    const conversation = await conversations.findWithCustomer(db, conversationId).catch(() => null);
    const logContext = conversation ? contextOf(conversation) : { conversationId };
    try {
      const policy = conversation ? policies[conversation.channel] : undefined;
      const pending = await messages.pendingFor(db, conversationId);
      if (conversation && policy && pending.length > 0) {
        if (insideWindow(policy, conversation.lastInboundAt)) {
          const snapshot = await readSnapshot(contextOf(conversation));
          const startedAt = clock.now();
          await deliver({
            conversation,
            policy,
            snapshot,
            response: abandonedBatchReply(snapshot, deps.emergencyContactPhone),
            covered: pending,
            startedAt,
            lastReceived: Math.max(...pending.map((m) => m.receivedAt.getTime())),
          });
          apologySent = true;
        } else {
          await discardPending(pending, 'outside_window', contextOf(conversation));
        }
      }
    } catch {
      // Sin BD tampoco hay disculpa: los pendientes siguen ahí para un lote nuevo.
    } finally {
      await conversations.resetBatch(db, conversationId).catch(() => undefined);
      activityLog.log({ event: 'batch_abandoned', attempts, apologySent }, logContext);
    }
  }

  /** Un lote que lanza se reintenta con espera creciente; al quinto, se abandona (012, R10). */
  async function failed(conversationId: string, error: unknown): Promise<void> {
    const errorClass = error instanceof Error ? error.name : typeof error;
    const now = clock.now().getTime();
    let attempt: number | null;
    try {
      attempt = await conversations.addBatchAttempt(db, conversationId);
    } catch {
      backoff.set(conversationId, now + (settings.batchRetryDelaysMs[0] ?? 5000));
      return;
    }
    if (attempt === null) return;
    if (attempt >= settings.batchMaxAttempts) {
      await abandon(conversationId, attempt);
      return;
    }
    const delayMs =
      settings.batchRetryDelaysMs[attempt - 1] ?? settings.batchRetryDelaysMs.at(-1) ?? 0;
    try {
      await conversations.setProcessAfter(db, conversationId, new Date(now + delayMs));
    } catch {
      backoff.set(conversationId, now + delayMs);
    }
    activityLog.log(
      { event: 'batch_retry_scheduled', attempt, delayMs, errorClass },
      {
        conversationId,
      },
    );
  }

  function track(conversationId: string): Promise<void> {
    const job = processConversation(conversationId)
      // Saliente guardado, reenvío marcado o mensajes descartados: el contador vuelve a 0.
      .then(() => conversations.clearBatchAttempts(db, conversationId))
      .catch((error: unknown) => failed(conversationId, error))
      .catch(() => {
        // Ni el fallo se pudo registrar: el barrido lo reintentará.
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
      const handoff = deps.handoff;
      if (handoff) {
        handoffSweep = setInterval(() => {
          // Un barrido cada vez; si la BD falla, se reintenta en el siguiente.
          handoffSweeping ??= handoff
            .sweep()
            .catch(() => undefined)
            .finally(() => {
              handoffSweeping = null;
            });
        }, settings.handoffSweepMs);
      }
      // Los pendientes que quedaron sin procesar se retoman en el primer barrido.
      void tick();
    },

    async stop() {
      running = false;
      if (sweep) clearInterval(sweep);
      if (handoffSweep) clearInterval(handoffSweep);
      handoffSweep = null;
      await handoffSweeping;
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
