/**
 * Servicio de la derivación (005, contracts/handoff-flow.md): lo que el procesador usa para
 * decidir cada turno, iniciar una derivación (resumen → avisos → guardado, R12) y reenviar al
 * negocio lo que el cliente escribe mientras dura (R11). Sin HTTP: habla con WhatsApp, el email
 * y el modelo solo por sus puertos.
 */
import { randomUUID } from 'node:crypto';
import type { CountryCode } from 'libphonenumber-js';
import type { ActivityLog, EventContext, HandoffNoticeType } from '../conversation/activity-log.js';
import type { Channel } from '../conversation/channels.js';
import type { Clock } from '../conversation/ports.js';
import * as conversations from '../conversation/repositories/conversation.js';
import type { DbOrTx } from '../conversation/repositories/customer.js';
import * as messages from '../conversation/repositories/message.js';
import type { InboundRow } from '../conversation/repositories/message.js';
import type { Db } from '../db/client.js';
import type { KnowledgeSnapshot } from '../knowledge/types.js';
import { decide, type TurnDecision, type TurnInput } from './decision.js';
import { alertNotice, forwardNotice } from './notices.js';
import type { AlertRoute, AlertRoutesProvider, AlertSendResult, HandoffSummarizer } from './ports.js';
import * as handoffs from './repositories/handoff.js';
import type { HandoffWithCustomer } from './repositories/handoff.js';
import * as notices from './repositories/handoff-notice.js';
import { addOpenMinutes, nextOpening } from './schedule.js';
import { summarizeHandoff } from './summary.js';
import { hashToken, issueToken, type TokenCipher } from './tokens.js';
import type { BusinessNotice, HandoffKind, RouteName, RouteResults } from './types.js';

/** Plazo de cada vía (R5). */
export const ROUTE_TIMEOUT_MS = 15_000;
/** Mensajes del cliente que recibe el resumen (R4). */
const SUMMARY_TEXTS = 30;
/** Minutos de horario sin confirmar antes del recordatorio (FR-019, R13). */
const REMINDER_OPEN_MINUTES = 120;

export interface HandoffServiceDeps {
  db: Db;
  clock: Clock;
  activityLog: ActivityLog;
  routes: AlertRoutesProvider;
  summarizer: HandoffSummarizer;
  cipher: TokenCipher;
  phoneRegion: CountryCode;
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
      afterHours: boolean;
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

export interface HandoffService {
  active(tx: DbOrTx, conversationId: string): Promise<HandoffWithCustomer | null>;
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
        route.send(notice, { signal: controller.signal }).catch(
          (): AlertSendResult => ({ ok: false, failure: 'error' }),
        ),
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

  return {
    active: (tx, conversationId) => handoffs.findActiveByConversation(tx, conversationId),

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

      const afterHours = nextOpening(snapshot, startedAt) !== null;
      return {
        started: true,
        handoffId,
        routes: results,
        afterHours,
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
