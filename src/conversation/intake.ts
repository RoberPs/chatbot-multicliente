/**
 * Recepción de mensajes (research R2, R3; contracts/whatsapp-webhook.md y, desde la 004,
 * contracts/conversation-channels.md).
 *
 * Único punto de entrada para todos los canales. Con la política del canal de cada evento
 * decide si se descarta sin guardar (negocio no activo, chat web desactivado, tope alcanzado) o
 * se guarda en una transacción antes de responder a quien lo envía. Los errores se propagan: el
 * webhook responde 503 y Meta reintenta; la deduplicación hace inocuos los reintentos.
 */
import type { Db } from '../db/client.js';
import type { KnowledgeReader, KnowledgeSnapshot } from '../knowledge/types.js';
import { readWebChatSettings, type WebChatSettings } from '../webchat/settings.js';
import { capReached, readWebUsage, type QuotaWatch } from '../webchat/usage.js';
import type { ActivityLog, DiscardReason } from './activity-log.js';
import type { ChannelPolicies, ChannelPolicy } from './channels.js';
import type { Clock } from './ports.js';
import * as conversations from './repositories/conversation.js';
import { markRateLimitNotified, upsertByChannel } from './repositories/customer.js';
import { countInboundSince, insertInbound } from './repositories/message.js';
import { conversationSettings, type ConversationSettings } from './settings.js';
import type { Transcriber } from './transcription.js';
import type { InboundEvent } from './types.js';

export interface IntakeDeps {
  db: Db;
  reader: KnowledgeReader;
  clock: Clock;
  activityLog: ActivityLog;
  /** Qué exige cada canal (R1). */
  policies: ChannelPolicies;
  /** Avisa al procesador de que una conversación tiene mensajes nuevos. */
  wake?: (conversationId: string) => void;
  /** Solo con los audios activados: los audios llegan como `kind = audio`. */
  transcriber?: Transcriber;
  /** Pide al procesador el aviso de límite (R-LIMIT) para una conversación (FR-004a). */
  notifyRateLimit?: (conversationId: string) => void;
  /** Registra `web_quota_reached` una vez por periodo (compartido con el procesador). */
  quotaWatch?: QuotaWatch;
  settings?: ConversationSettings;
}

/** Resultado por evento, para que la ruta del chat web pueda contestar. */
export type IntakeOutcome =
  | { status: 'stored'; conversationId: string }
  | { status: 'duplicate' }
  | { status: 'rate_limited'; conversationId: string }
  | { status: 'discarded'; reason: 'not_active' | 'disabled' | 'quota' | 'group' };

export interface Intake {
  handle(events: InboundEvent[]): Promise<IntakeOutcome[]>;
}

/** Deshace la transacción de un duplicado (no deja una conversación vacía). */
class DuplicateMessage extends Error {}

export function createIntake(deps: IntakeDeps): Intake {
  const { db, reader, clock, activityLog, policies } = deps;
  const settings = deps.settings ?? conversationSettings;

  interface Stored {
    conversationId: string;
    messageId: string;
    /** Solo si el mensaje supera el límite por cliente (R6). */
    rateLimit: { count: number; noticeSent: boolean } | null;
  }

  async function store(event: InboundEvent): Promise<Stored | null> {
    const receivedAt = clock.now();
    try {
      return await db.transaction(async (tx) => {
        const customer = await upsertByChannel(tx, event.channel, event.channelUserId);
        // R6: cuentan todos los entrantes de la ventana, también los ya limitados.
        const windowStart = new Date(receivedAt.getTime() - settings.rateLimitWindowMs);
        const count = (await countInboundSince(tx, customer.id, windowStart)) + 1;
        const limited = count > settings.rateLimitMessages;
        const noticeSent =
          limited &&
          (customer.rateLimitNotifiedAt === null || customer.rateLimitNotifiedAt <= windowStart);
        if (noticeSent) await markRateLimitNotified(tx, customer.id, receivedAt);
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
          channelMessageId: event.channelMessageId,
          kind: event.kind,
          body: event.kind === 'other' ? event.caption : event.text,
          otherType: event.otherType,
          sentAt: event.sentAt,
          receivedAt,
          status: limited ? 'rate_limited' : 'pending',
          transcription: event.kind === 'audio' && !limited ? 'pending' : null,
        });
        if (!inserted.id) throw new DuplicateMessage();
        await conversations.touchInbound(tx, conversation.id, event.sentAt, receivedAt);
        return {
          conversationId: conversation.id,
          messageId: inserted.id,
          rateLimit: limited ? { count, noticeSent } : null,
        };
      });
    } catch (error) {
      if (error instanceof DuplicateMessage) return null;
      throw error;
    }
  }

  /** Configuración y uso del chat web, leídos una vez por lote y sin caché. */
  function webChecks(snapshot: KnowledgeSnapshot) {
    let web: Promise<WebChatSettings> | null = null;
    let cap: Promise<'day' | 'month' | null> | null = null;
    const readSettings = () => (web ??= readWebChatSettings(db));
    return {
      readSettings,
      capReached: () =>
        (cap ??= (async () => {
          const now = clock.now();
          const current = await readSettings();
          const usage = await readWebUsage(db, now, snapshot.business.timezone);
          const period = capReached(usage, current);
          if (period) deps.quotaWatch?.reached(period, current, now, snapshot.business.timezone);
          return period;
        })()),
    };
  }

  /** Motivo para descartar sin guardar, en el orden del contrato; `null` si se guarda. */
  async function discardReason(
    policy: ChannelPolicy,
    snapshot: KnowledgeSnapshot,
    web: ReturnType<typeof webChecks>,
  ): Promise<Extract<DiscardReason, 'not_active' | 'disabled' | 'quota'> | null> {
    if (policy.requiresActiveBusiness && snapshot.status !== 'active') return 'not_active';
    if (policy.requiresWebChatEnabled && !(await web.readSettings()).enabled) return 'disabled';
    if (policy.usageCap && (await web.capReached()) !== null) return 'quota';
    return null;
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

      const web = webChecks(snapshot);
      const outcomes: IntakeOutcome[] = [];
      const woken = new Set<string>();
      for (const event of events) {
        const policy = policies[event.channel];
        if (!policy) throw new Error(`Canal sin configurar: ${event.channel}`);
        const logContext = { channel: event.channel, customerKey: event.channelUserId };

        const reason = await discardReason(policy, snapshot, web);
        if (reason) {
          activityLog.log({ event: 'message_discarded', reason }, logContext);
          outcomes.push({ status: 'discarded', reason });
          continue;
        }

        const stored = await store(event);
        if (stored === null) {
          activityLog.log({ event: 'duplicate_ignored' }, logContext);
          outcomes.push({ status: 'duplicate' });
          continue;
        }
        const { conversationId, messageId, rateLimit } = stored;
        const context = { ...logContext, conversationId };
        activityLog.log(
          {
            event: 'message_received',
            kind: event.kind,
            ...(event.otherType ? { otherType: event.otherType } : {}),
          },
          context,
        );
        if (rateLimit) {
          // No se contesta nunca; como mucho, un aviso por ventana.
          activityLog.log(
            {
              event: 'rate_limit_exceeded',
              count: rateLimit.count,
              windowMinutes: settings.rateLimitWindowMs / 60_000,
              noticeSent: rateLimit.noticeSent,
            },
            context,
          );
          if (rateLimit.noticeSent) deps.notifyRateLimit?.(conversationId);
          outcomes.push({ status: 'rate_limited', conversationId });
          continue;
        }
        outcomes.push({ status: 'stored', conversationId });
        woken.add(conversationId);
        if (event.kind === 'audio' && event.mediaId && deps.transcriber) {
          // En paralelo con la espera de agrupado (R10); el webhook no espera.
          void deps.transcriber.transcribe({
            messageId,
            mediaId: event.mediaId,
            conversationId,
            channel: event.channel,
            customerKey: event.channelUserId,
          });
        }
      }
      for (const id of woken) deps.wake?.(id);
      return outcomes;
    },
  };
}
