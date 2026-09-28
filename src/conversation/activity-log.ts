/**
 * Registros técnicos del bot (contracts/activity-log.md, FR-030a).
 *
 * Catálogo cerrado: ningún evento tiene campos de texto libre, así que no pueden llevar el
 * texto de mensajes, respuestas ni prompts. El cliente aparece solo como seudónimo HMAC.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import type { Channel } from './channels.js';
import type { MessageKind, REPLY_TEMPLATES } from './types.js';

/** `disabled`: chat web desactivado; `quota`: tope del chat web alcanzado (004). */
export type DiscardReason =
  'not_active' | 'group' | 'outside_window' | 'deactivated' | 'disabled' | 'quota';
export type TranscriptionFailure =
  'too_large' | 'too_long' | 'language' | 'empty' | 'timeout' | 'provider_error';
export type ReplyTemplate = (typeof REPLY_TEMPLATES)[number];
/** Motivos de rechazo del chat web antes de la recepción (FR-025, FR-027). */
export type WebRejection = 'origin' | 'session' | 'session_limit' | 'ip_limit' | 'invalid';

export type BotEvent =
  | { event: 'message_received'; kind: MessageKind; otherType?: string }
  | { event: 'message_discarded'; reason: DiscardReason }
  | { event: 'duplicate_ignored' }
  | { event: 'rate_limit_exceeded'; count: number; windowMinutes: number; noticeSent: boolean }
  | {
      event: 'reply_sent';
      messagesCovered: number;
      kinds: MessageKind[];
      latencyMs: number;
      waitMs: number;
      modelMs?: number;
      greeting: boolean;
      contactBlock: boolean;
      template?: ReplyTemplate;
      /** Borradores rechazados por el verificador (0 – 2), sin sus valores. */
      groundingRejections: number;
    }
  | { event: 'transcription_failed'; reason: TranscriptionFailure }
  | { event: 'knowledge_read_failed'; errorClass: string; stage: 'intake' | 'processor' }
  | {
      event: 'generation_failed';
      reason: 'timeout' | 'refusal' | 'invalid_output' | 'api_error';
      status?: number;
    }
  | { event: 'grounding_rejected'; attempt: number; offendingCount: number }
  | { event: 'send_failed'; attempts: number; status?: number; finalFailure: boolean }
  | { event: 'webhook_rejected'; reason: 'signature' | 'payload' }
  | { event: 'retention_purged'; conversations: number; customers: number }
  | { event: 'web_session_created' }
  | { event: 'web_rejected'; reason: WebRejection }
  | { event: 'web_quota_reached'; period: 'day' | 'month'; cap: number };

export type BotEventName = BotEvent['event'];
type Level = 'debug' | 'info' | 'warn' | 'error';

export const eventLevels: Record<BotEventName, Level> = {
  message_received: 'info',
  message_discarded: 'info',
  duplicate_ignored: 'debug',
  rate_limit_exceeded: 'warn',
  reply_sent: 'info',
  transcription_failed: 'warn',
  knowledge_read_failed: 'error',
  generation_failed: 'error',
  grounding_rejected: 'warn',
  send_failed: 'error',
  webhook_rejected: 'warn',
  retention_purged: 'info',
  web_session_created: 'debug',
  web_rejected: 'warn',
  web_quota_reached: 'warn',
};

/** Lo mínimo que se necesita de un logger (pino lo cumple). */
export interface LoggerLike {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  child?(bindings: Record<string, unknown>): LoggerLike;
}

export interface EventContext {
  /** Canal del cliente; se registra como `via` (004, R12). */
  channel?: Channel;
  /** `channel_user_id` del cliente; se registra solo su seudónimo. */
  customerKey?: string;
  conversationId?: string;
}

export interface ActivityLog {
  log(event: BotEvent, context?: EventContext): void;
  /** Seudónimo del cliente: el mismo id en dos canales da seudónimos distintos. */
  pseudonym(channel: Channel, customerKey: string): string;
}

/** Clave del seudónimo derivada de SESSION_SECRET (sin secreto nuevo, research R11). */
function pseudonymKey(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(sessionSecret, 'hex'), '', 'bot-log', 32));
}

export function createActivityLog(logger: LoggerLike, sessionSecret: string): ActivityLog {
  const key = pseudonymKey(sessionSecret);
  const out = logger.child ? logger.child({ channel: 'bot' }) : logger;
  const pseudonym = (channel: Channel, customerKey: string) =>
    createHmac('sha256', key).update(`${channel}:${customerKey}`).digest('hex').slice(0, 12);

  return {
    pseudonym,
    log(event, context = {}) {
      const record: Record<string, unknown> = { ...event };
      if (context.channel !== undefined) {
        record.via = context.channel;
        if (context.customerKey !== undefined) {
          record.customer = pseudonym(context.channel, context.customerKey);
        }
      }
      if (context.conversationId !== undefined) record.conversationId = context.conversationId;
      if (!logger.child) record.channel = 'bot';
      out[eventLevels[event.event]](record, event.event);
    },
  };
}

/** Registro que no escribe nada (tests y herramientas). */
export const silentActivityLog: ActivityLog = {
  log: () => undefined,
  pseudonym: () => '000000000000',
};
