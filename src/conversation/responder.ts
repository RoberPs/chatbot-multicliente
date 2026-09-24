/**
 * Lote de pendientes → ReplyContext → ChatModel → verificador → composición
 * (contracts/bot-replies.md, contracts/chat-model.md).
 *
 * El modelo solo aporta el cuerpo y unas banderas; el código decide el contacto y los
 * mensajes fijos para garantizar los Principios IV y V.
 */
import type { KnowledgeSnapshot } from '../knowledge/types.js';
import type { ActivityLog, ReplyTemplate } from './activity-log.js';
import { buildAllowedFacts, deriveFacts } from './facts.js';
import { groundingGuard, offendingCategories, type FactCategory } from './grounding.js';
import { ChatModelError, type ChatModel, type Clock } from './ports.js';
import { conversationSettings, type ConversationSettings } from './settings.js';
import { contactBlock, errorReply, formOf, joinParts, safeReply } from './templates.js';
import type { HistoryTurn, ModelReply, PendingItem, ReplyContext } from './types.js';

export interface ResponderDeps {
  chatModel: ChatModel;
  clock: Clock;
  activityLog: ActivityLog;
  settings?: ConversationSettings;
}

export interface RespondInput {
  snapshot: KnowledgeSnapshot;
  history: HistoryTurn[];
  pending: PendingItem[];
  now: Date;
  /** Para los registros. */
  phone: string;
  conversationId: string;
}

export interface Response {
  text: string;
  contactBlock: boolean;
  greeting: boolean;
  template?: ReplyTemplate;
  modelMs?: number;
  truncated: boolean;
}

const CATEGORY_NAMES: Record<FactCategory, string> = {
  url: 'enlace',
  email: 'correo',
  phone: 'teléfono',
  date: 'fecha',
  time: 'hora',
  amount: 'importe',
  number: 'número',
};

/** Explica al modelo qué tipo de dato sobraba, sin repetir los valores rechazados. */
export function groundingFeedback(categories: FactCategory[]): string {
  const kinds = categories.map((c) => CATEGORY_NAMES[c]).join(', ');
  return (
    `Tu respuesta anterior incluía valores (${kinds}) que no figuran en DATOS_DEL_NEGOCIO ni en ` +
    'HECHOS_CALCULADOS. Escríbela de nuevo usando solo esos datos; si no tienes el dato, dilo ' +
    'y marca offerContact.'
  );
}

export function createResponder(deps: ResponderDeps) {
  const { chatModel, clock, activityLog } = deps;
  const settings = deps.settings ?? conversationSettings;

  return {
    async respond(input: RespondInput): Promise<Response> {
      const { snapshot } = input;
      const form = formOf(snapshot.tone.addressForm);
      const derived = deriveFacts(snapshot, input.now);
      const allowed = buildAllowedFacts(snapshot, derived);
      const context: ReplyContext = {
        snapshot,
        derived,
        history: input.history.slice(-settings.historyLimit),
        pending: input.pending,
        greetingPrepended: false,
        addressForm: snapshot.tone.addressForm,
      };
      const logContext = { phone: input.phone, conversationId: input.conversationId };

      const compose = (body: string, withContact: boolean, template?: ReplyTemplate) => {
        const contact = withContact ? contactBlock(snapshot) : null;
        const { text, truncated } = joinParts({ body, contact });
        return { text, truncated, contactBlock: withContact, greeting: false, template };
      };

      // Un único plazo para toda la respuesta, compartido por los dos intentos (R7).
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, settings.modelBudgetMs);
      const start = clock.now().getTime();
      const elapsed = () => clock.now().getTime() - start;
      try {
        let reply: ModelReply;
        let feedback: string | undefined;
        for (let attempt = 1; ; attempt++) {
          reply = await chatModel.reply(context, { signal: controller.signal, feedback });
          const guard = groundingGuard(reply.body, allowed);
          if (guard.ok) break;
          activityLog.log(
            { event: 'grounding_rejected', attempt, offendingCount: guard.offending.length },
            logContext,
          );
          const remaining = settings.modelBudgetMs - elapsed();
          if (attempt >= 2 || remaining < settings.minRetryBudgetMs) {
            return { ...compose(safeReply(form), true, 'R-SAFE'), modelMs: elapsed() };
          }
          feedback = groundingFeedback(offendingCategories(reply.body, allowed));
        }
        const withContact = reply.handoffRequested || reply.offerContact || reply.bookingRequested;
        return { ...compose(reply.body, withContact), modelMs: elapsed() };
      } catch (error) {
        // FR-029: el modelo falla o se agota el plazo → disculpa con contacto.
        const failure = error instanceof ChatModelError ? error : new ChatModelError('api_error');
        activityLog.log(
          {
            event: 'generation_failed',
            reason: controller.signal.aborted ? 'timeout' : failure.reason,
            ...(failure.status === undefined ? {} : { status: failure.status }),
          },
          logContext,
        );
        return { ...compose(errorReply(form), true, 'R-ERR'), modelMs: elapsed() };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export type Responder = ReturnType<typeof createResponder>;
