/**
 * Servicio de la derivación (005, contracts/handoff-flow.md): lo que el procesador usa para
 * decidir cada turno, iniciar una derivación (resumen → avisos → guardado, R12) y reenviar al
 * negocio lo que el cliente escribe mientras dura (R11); las acciones del negocio (botones y
 * enlaces, R9), el fin desde el panel y el barrido de inactividad y recordatorios (R14). Sin
 * HTTP: habla con WhatsApp, el email y el modelo solo por sus puertos, y con el cliente por la
 * entrega de su canal (`ChannelPolicy`).
 */
import { randomUUID } from 'node:crypto';
import type { CountryCode } from 'libphonenumber-js';
import type { ActivityLog, EventContext, HandoffNoticeType } from '../conversation/activity-log.js';
import type { Channel, ChannelPolicies } from '../conversation/channels.js';
import { ChannelSendError, type Clock } from '../conversation/ports.js';
import * as conversations from '../conversation/repositories/conversation.js';
import type { DbOrTx } from '../conversation/repositories/customer.js';
import * as messages from '../conversation/repositories/message.js';
import type { InboundRow } from '../conversation/repositories/message.js';
import type { Db } from '../db/client.js';
import type { KnowledgeReader, KnowledgeSnapshot } from '../knowledge/types.js';
import type { ActCustomer, ActResult } from './business-replies.js';
import { decide, type TurnDecision, type TurnInput } from './decision.js';
import { alertNotice, forwardNotice, reminderNotice } from './notices.js';
import type {
  AlertRoute,
  AlertRoutesProvider,
  AlertSendResult,
  HandoffSummarizer,
} from './ports.js';
import * as handoffs from './repositories/handoff.js';
import type { HandoffWithCustomer } from './repositories/handoff.js';
import * as notices from './repositories/handoff-notice.js';
import { addOpenMinutes, attentionAt, type Attention } from './schedule.js';
import { summarizeHandoff } from './summary.js';
import { lateReplyWithContact } from './templates.js';
import {
  hashToken,
  isTokenFormat,
  issueToken,
  type HandoffButtonAction,
  type TokenCipher,
} from './tokens.js';
import type {
  BusinessNotice,
  HandoffActionVia,
  HandoffKind,
  NoticeHandoff,
  RouteName,
  RouteResults,
} from './types.js';

/** Plazo de cada vía (R5). */
export const ROUTE_TIMEOUT_MS = 15_000;
/** Mensajes del cliente que recibe el resumen (R4). */
const SUMMARY_TEXTS = 30;
/** Minutos de horario sin confirmar antes del recordatorio (FR-019, R13). */
const REMINDER_OPEN_MINUTES = 120;
/** Sin mensajes del cliente durante este tiempo, la conversación vuelve al bot (R14). */
export const INACTIVITY_MS = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;
/** Zona si no se puede leer el snapshot (solo para escribir horas en los avisos). */
const FALLBACK_TIMEZONE = 'Europe/Madrid';

export interface HandoffServiceDeps {
  db: Db;
  clock: Clock;
  /** Zona horaria del negocio para las horas de los avisos fuera de la cadena. */
  reader: KnowledgeReader;
  activityLog: ActivityLog;
  routes: AlertRoutesProvider;
  summarizer: HandoffSummarizer;
  cipher: TokenCipher;
  phoneRegion: CountryCode;
  /** Entrega de cada canal, para el R-HANDOFF-LATE al cliente (FR-019). */
  policies: ChannelPolicies;
  /** Plazos más cortos en los tests. */
  routeTimeoutMs?: number;
  summaryBudgetMs?: number;
}

export interface StartInput {
  conversationId: string;
  channel: Channel;
  kind: HandoffKind;
  customerName: string;
  /** E.164. */
  customerPhone: string;
  snapshot: KnowledgeSnapshot;
  /** Playground: solo la vía simulada (FR-021). */
  simulate: boolean;
  logContext: EventContext;
}

export type StartResult =
  | {
      started: true;
      handoffId: string;
      routes: RouteResults;
      /** Abierto, o cerrado con la próxima franja: elige la variante de R-HANDOFF-OK. */
      attention: Attention;
      /** Guarda la derivación y sus avisos en la transacción del saliente de confirmación. */
      persist(tx: DbOrTx): Promise<void>;
    }
  | { started: false; routes: RouteResults };

export interface ForwardInput {
  handoff: HandoffWithCustomer;
  pending: InboundRow[];
  snapshot: KnowledgeSnapshot | null;
  simulate: boolean;
  logContext: EventContext;
}

/** Lo que ve la página de un enlace del email, sin cambiar nada (R8). */
export interface HandoffLookup {
  status: 'active' | 'ended';
  confirmed: boolean;
  kind: HandoffKind;
  customer: ActCustomer;
  startedAt: Date;
  timezone: string;
}

export interface ActOutcome {
  result: ActResult;
  /** Datos del cliente para el acuse; `null` si el token no es válido. */
  customer: ActCustomer | null;
}

export interface HandoffService {
  active(tx: DbOrTx, conversationId: string): Promise<HandoffWithCustomer | null>;
  /** Hubo una derivación terminada en la conversación (FR-018): el prompt no vuelve a saludar. */
  hasEnded(conversationId: string): Promise<boolean>;
  /** Derivación de un token, sin cambiar nada (páginas de los enlaces). */
  lookup(token: string): Promise<HandoffLookup | null>;
  /** «Le atiendo» o «Terminado» desde un botón o un enlace (R9). Solo cuenta la primera. */
  act(token: string, action: HandoffButtonAction, via: HandoffActionVia): Promise<ActOutcome>;
  /** Terminar desde el panel o desde "Probar el bot" (FR-016a); sin mensaje al cliente. */
  endByOperator(
    handoffId: string,
    cause: 'operator' | 'playground',
  ): Promise<{ result: 'done' | 'already_ended' | 'not_found'; customer: ActCustomer | null }>;
  /** Barrido de inactividad y de recordatorios a las 2 h de horario (R14, FR-019). */
  sweep(): Promise<void>;
  /** Hay alguna vía de aviso disponible ahora (lee los destinos sin caché). */
  hasRoutes(simulate: boolean): Promise<boolean>;
  decide(input: Omit<TurnInput, 'region' | 'now'>): TurnDecision;
  start(input: StartInput): Promise<StartResult>;
  forward(input: ForwardInput): Promise<void>;
}

interface Sent {
  route: RouteName;
  result: AlertSendResult;
}

export function createHandoffService(deps: HandoffServiceDeps): HandoffService {
  const { db, clock, activityLog } = deps;
  const routeTimeoutMs = deps.routeTimeoutMs ?? ROUTE_TIMEOUT_MS;

  /** Una vía con su plazo: si no contesta a tiempo, cuenta como fallo (R5). */
  async function sendOne(route: AlertRoute, notice: BusinessNotice): Promise<Sent> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<AlertSendResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, failure: 'timeout' });
      }, routeTimeoutMs);
    });
    try {
      const result = await Promise.race([
        route
          .send(notice, { signal: controller.signal })
          .catch((): AlertSendResult => ({ ok: false, failure: 'error' })),
        timeout,
      ]);
      return { route: route.name, result };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Todas las vías en paralelo; registra cada fallo. */
  async function sendAll(
    routes: AlertRoute[],
    notice: BusinessNotice,
    noticeType: HandoffNoticeType,
    logContext: EventContext,
    handoffId?: string,
  ): Promise<Sent[]> {
    const sent = await Promise.all(routes.map((r) => sendOne(r, notice)));
    for (const { route, result } of sent) {
      if (!result.ok) {
        activityLog.log(
          {
            event: 'handoff_alert_failed',
            ...(handoffId ? { handoffId } : {}),
            route,
            noticeType,
            failure: result.failure,
          },
          logContext,
        );
      }
    }
    return sent;
  }

  const resultsOf = (sent: Sent[]): RouteResults =>
    Object.fromEntries(sent.map((s) => [s.route, s.result.ok ? 'sent' : 'failed']));

  const noticeRows = (
    handoffId: string,
    type: HandoffNoticeType,
    sent: Sent[],
    at: Date,
    messagesCovered?: number,
  ): notices.NewNotice[] =>
    sent.map(({ route, result }) => ({
      handoffId,
      type,
      route,
      status: result.ok ? 'sent' : 'failed',
      failure: result.ok ? null : result.failure,
      providerRef: result.ok ? result.ref : null,
      body: result.ok ? (result.body ?? null) : null,
      messagesCovered: messagesCovered ?? null,
      createdAt: at,
    }));

  const customerOf = (row: HandoffWithCustomer): ActCustomer => ({
    name: row.customerName ?? '—',
    phone: row.customerPhone ?? row.channelUserId,
  });

  const minutesBetween = (from: Date, to: Date) =>
    Math.max(0, Math.round((to.getTime() - from.getTime()) / MINUTE));

  const contextOf = (row: HandoffWithCustomer): EventContext => ({
    channel: row.channel,
    customerKey: row.channelUserId,
    conversationId: row.conversationId,
  });

  async function timezone(): Promise<string> {
    try {
      return (await deps.reader.getSnapshot()).business.timezone;
    } catch {
      return FALLBACK_TIMEZONE;
    }
  }

  /** Datos de los mensajes al negocio de una derivación guardada; `null` sin token legible. */
  async function noticeHandoff(row: HandoffWithCustomer): Promise<NoticeHandoff | null> {
    const token = deps.cipher.decrypt(row.tokenEnc);
    if (token === null) return null;
    const customer = customerOf(row);
    return {
      id: row.id,
      kind: row.kind,
      customerName: customer.name,
      customerPhone: customer.phone,
      channel: row.channel,
      summary: row.summary,
      startedAt: row.startedAt,
      timezone: await timezone(),
      token,
      threadRef: await notices.emailThreadRef(db, row.id),
    };
  }

  /**
   * R-HANDOFF-LATE al cliente por la entrega de su canal (FR-019), una sola vez y sin
   * reintentos: en WhatsApp solo dentro de la ventana de 24 h. Devuelve si se entregó.
   */
  async function notifyLate(row: HandoffWithCustomer, routes: RouteResults): Promise<boolean> {
    const policy = deps.policies[row.channel];
    const conversation = await conversations.findWithCustomer(db, row.conversationId);
    if (!policy || !conversation) return false;
    const now = clock.now();
    if (
      policy.replyWindowMs !== null &&
      now.getTime() - conversation.lastInboundAt.getTime() > policy.replyWindowMs
    ) {
      return false;
    }
    let snapshot: KnowledgeSnapshot;
    try {
      snapshot = await deps.reader.getSnapshot();
    } catch {
      // Sin snapshot no hay CONTACTO que dar.
      return false;
    }
    if (policy.requiresActiveBusiness && snapshot.status !== 'active') return false;
    const text = lateReplyWithContact(snapshot);
    const trace = {
      template: 'R-HANDOFF-LATE' as const,
      greeting: false,
      contact: { added: true, reason: 'template' as const },
      groundingRejections: 0,
      modelMs: null,
      latencyMs: 0,
      handoff: { action: 'late_notice' as const, kind: row.kind, handoffId: row.id, routes },
    };
    const outboundId = await db.transaction(async (tx) => {
      const id = await messages.createOutboundCovering(
        tx,
        row.conversationId,
        text,
        [],
        now,
        trace,
      );
      await conversations.touchMessage(tx, row.conversationId, now);
      return id;
    });
    const logContext = contextOf(row);
    try {
      const { channelMessageId } = await policy.sender.sendText(row.channelUserId, text, {
        canRetry: () =>
          policy.replyWindowMs === null ||
          clock.now().getTime() - conversation.lastInboundAt.getTime() <= policy.replyWindowMs,
      });
      const sentAt = clock.now();
      await messages.markSent(db, outboundId, channelMessageId, sentAt);
      await conversations.touchMessage(db, row.conversationId, sentAt);
      return true;
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
      return false;
    }
  }

  /**
   * Recordatorio al negocio por las vías disponibles ahora (FR-019). A las 2 h de horario
   * (`schedule`) va con R-HANDOFF-LATE al cliente; al cerrarse por inactividad sin confirmar
   * (`inactivity`), sin ningún mensaje al cliente. Ya está marcado: no se repite.
   */
  async function sendReminder(
    handoffId: string,
    trigger: 'schedule' | 'inactivity',
  ): Promise<void> {
    const row = await handoffs.findById(db, handoffId);
    if (!row) return;
    const handoff = await noticeHandoff(row);
    const routes = await deps.routes.available(db, { simulate: row.channel === 'playground' });
    const logContext = contextOf(row);
    const sent =
      handoff && routes.length > 0
        ? await sendAll(routes, reminderNotice(handoff, trigger), 'reminder', logContext, row.id)
        : [];
    await notices.insertMany(db, noticeRows(row.id, 'reminder', sent, clock.now()));
    const results = resultsOf(sent);
    const customerNotified = trigger === 'schedule' ? await notifyLate(row, results) : false;
    activityLog.log(
      {
        event: 'handoff_reminder_sent',
        handoffId: row.id,
        routes: results,
        trigger,
        customerNotified,
      },
      logContext,
    );
  }

  return {
    active: (tx, conversationId) => handoffs.findActiveByConversation(tx, conversationId),

    hasEnded: (conversationId) => handoffs.hasEnded(db, conversationId),

    async lookup(token) {
      if (!isTokenFormat(token)) return null;
      const row = await handoffs.findByTokenHash(db, hashToken(token));
      if (!row) return null;
      return {
        status: row.status,
        confirmed: row.confirmedAt !== null,
        kind: row.kind,
        customer: customerOf(row),
        startedAt: row.startedAt,
        timezone: await timezone(),
      };
    },

    async act(token, action, via) {
      // Eventos del negocio: sin seudónimo ni contexto de cliente (contracts/activity-log.md).
      const ignored = (reason: 'invalid' | 'already_ended' | 'already_confirmed') => {
        activityLog.log({ event: 'handoff_action_ignored', reason, via });
      };
      const row = isTokenFormat(token)
        ? await handoffs.findByTokenHash(db, hashToken(token))
        : null;
      if (!row) {
        ignored('invalid');
        return { result: 'invalid', customer: null };
      }
      const customer = customerOf(row);
      const now = clock.now();
      const confirmed = () => {
        activityLog.log({
          event: 'handoff_confirmed',
          handoffId: row.id,
          via,
          minutesToConfirm: minutesBetween(row.startedAt, now),
        });
      };
      if (action === 'attend') {
        if (await handoffs.confirm(db, row.id, via, now)) {
          confirmed();
          return { result: 'done', customer };
        }
        // No cambió: ya estaba confirmada o ya había terminado (quizá a la vez por la otra vía).
        const current = await handoffs.findById(db, row.id);
        const result = current?.status === 'ended' ? 'already_ended' : 'already_confirmed';
        ignored(result);
        return { result, customer };
      }
      if (await handoffs.end(db, row.id, 'business', now, via)) {
        // Solo si la confirmó este «Terminado» (otra vía pudo confirmarla a la vez).
        const after = await handoffs.findById(db, row.id);
        if (after?.confirmedVia === via && after.confirmedAt?.getTime() === now.getTime()) {
          if (row.confirmedAt === null) confirmed();
        }
        activityLog.log({
          event: 'handoff_ended',
          handoffId: row.id,
          cause: 'business',
          durationMinutes: minutesBetween(row.startedAt, now),
          confirmed: true,
        });
        return { result: 'done', customer };
      }
      ignored('already_ended');
      return { result: 'already_ended', customer };
    },

    async endByOperator(handoffId, cause) {
      const row = await handoffs.findById(db, handoffId);
      if (!row) return { result: 'not_found', customer: null };
      const customer = customerOf(row);
      const now = clock.now();
      if (!(await handoffs.end(db, row.id, cause, now))) {
        return { result: 'already_ended', customer };
      }
      activityLog.log(
        {
          event: 'handoff_ended',
          handoffId: row.id,
          cause,
          durationMinutes: minutesBetween(row.startedAt, now),
          confirmed: row.confirmedAt !== null,
        },
        contextOf(row),
      );
      return { result: 'done', customer };
    },

    async sweep() {
      const now = clock.now();
      const ended = await db.transaction((tx) =>
        handoffs.endInactive(tx, new Date(now.getTime() - INACTIVITY_MS), now),
      );
      for (const h of ended) {
        activityLog.log(
          {
            event: 'handoff_ended',
            handoffId: h.id,
            cause: 'inactivity',
            durationMinutes: minutesBetween(h.startedAt, now),
            confirmed: h.confirmed,
          },
          { conversationId: h.conversationId },
        );
      }
      // Fuera de la transacción: el recordatorio ya quedó marcado y no se repite.
      for (const h of ended.filter((e) => e.reminderDue)) {
        await sendReminder(h.id, 'inactivity');
      }
      // Recordatorios a las 2 h de horario de las que siguen activas sin confirmar.
      const due = await db.transaction((tx) => handoffs.claimDueReminders(tx, now));
      for (const id of due) {
        await sendReminder(id, 'schedule');
      }
    },

    async hasRoutes(simulate) {
      return (await deps.routes.available(db, { simulate })).length > 0;
    },

    decide(input) {
      return decide({ ...input, region: deps.phoneRegion, now: clock.now() });
    },

    async start(input) {
      const { kind, logContext, snapshot } = input;
      const routes = await deps.routes.available(db, { simulate: input.simulate });
      if (routes.length === 0) {
        activityLog.log({ event: 'handoff_not_started', kind, reason: 'no_routes' }, logContext);
        return { started: false, routes: {} };
      }

      const customerTexts = await messages.customerTexts(db, input.conversationId, SUMMARY_TEXTS);
      const summary = await summarizeHandoff({
        summarizer: deps.summarizer,
        kind,
        customerTexts,
        activityLog,
        logContext,
        ...(deps.summaryBudgetMs === undefined ? {} : { budgetMs: deps.summaryBudgetMs }),
      });

      const handoffId = randomUUID();
      const token = issueToken();
      const startedAt = clock.now();
      const notice = alertNotice({
        id: handoffId,
        kind,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        channel: input.channel,
        summary: summary.summary,
        startedAt,
        timezone: snapshot.business.timezone,
        token,
      });
      const sent = await sendAll(routes, notice, 'alert', logContext, handoffId);
      const results = resultsOf(sent);
      if (!sent.some((s) => s.result.ok)) {
        activityLog.log(
          { event: 'handoff_not_started', kind, reason: 'delivery_failed' },
          logContext,
        );
        return { started: false, routes: results };
      }

      const attention = attentionAt(snapshot, startedAt);
      const afterHours = !attention.open;
      return {
        started: true,
        handoffId,
        routes: results,
        attention,
        async persist(tx) {
          await handoffs.insertActive(tx, {
            id: handoffId,
            conversationId: input.conversationId,
            kind,
            summary: summary.summary,
            summarySource: summary.source,
            tokenHash: hashToken(token),
            tokenEnc: deps.cipher.encrypt(token),
            startedAt,
            reminderDueAt: addOpenMinutes(snapshot, startedAt, REMINDER_OPEN_MINUTES),
          });
          await notices.insertMany(tx, noticeRows(handoffId, 'alert', sent, startedAt));
          await conversations.setHandoffStep(tx, input.conversationId, null);
          activityLog.log(
            {
              event: 'handoff_started',
              handoffId,
              kind,
              routes: results,
              summarySource: summary.source,
              afterHours,
            },
            logContext,
          );
        },
      };
    },

    async forward(input) {
      const { handoff, pending, logContext } = input;
      if (pending.length === 0) return;
      const routes = await deps.routes.available(db, { simulate: input.simulate });
      const token = deps.cipher.decrypt(handoff.tokenEnc);
      const now = clock.now();
      let sent: Sent[] = [];
      if (token !== null && routes.length > 0) {
        const threadRef = await notices.emailThreadRef(db, handoff.id);
        const notice = forwardNotice(
          {
            id: handoff.id,
            kind: handoff.kind,
            customerName: handoff.customerName ?? '—',
            customerPhone: handoff.customerPhone ?? handoff.channelUserId,
            channel: handoff.channel,
            summary: handoff.summary,
            startedAt: handoff.startedAt,
            timezone: input.snapshot?.business.timezone ?? 'Europe/Madrid',
            token,
            threadRef,
          },
          pending.map((m) => ({
            text: m.body,
            kind: m.kind,
            otherType: m.otherType,
            sentAt: m.sentAt,
          })),
          routes.some((r) => r.name === 'email'),
        );
        sent = await sendAll(routes, notice, 'forward', logContext, handoff.id);
      }
      // Los entrantes quedan reenviados aunque fallen todas las vías: no se reintenta (R11).
      await db.transaction(async (tx) => {
        await messages.markForwarded(
          tx,
          pending.map((m) => m.id),
        );
        await notices.insertMany(tx, noticeRows(handoff.id, 'forward', sent, now, pending.length));
      });
      if (sent.some((s) => s.result.ok)) {
        activityLog.log(
          {
            event: 'handoff_forwarded',
            handoffId: handoff.id,
            messagesCovered: pending.length,
            routes: resultsOf(sent),
          },
          logContext,
        );
      } else {
        activityLog.log(
          {
            event: 'handoff_forward_failed',
            handoffId: handoff.id,
            messagesCovered: pending.length,
          },
          logContext,
        );
      }
    },
  };
}
