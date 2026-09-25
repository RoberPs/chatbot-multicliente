/**
 * Lote de pendientes → ReplyContext → ChatModel → verificador → composición
 * (contracts/bot-replies.md, contracts/chat-model.md).
 *
 * El modelo solo aporta el cuerpo y unas banderas; el código decide el contacto y los
 * mensajes fijos para garantizar los Principios IV y V.
 */
import type { KnowledgeSnapshot } from '../knowledge/types.js';
import type { ActivityLog, ReplyTemplate } from './activity-log.js';
import type { Channel } from './channels.js';
import { buildAllowedFacts, deriveFacts } from './facts.js';
import { groundingGuard, offendingCategories, type FactCategory } from './grounding.js';
import { detectsHandoffRequest } from './handoff-detector.js';
import { ChatModelError, type ChatModel, type Clock } from './ports.js';
import { conversationSettings, type ConversationSettings } from './settings.js';
import {
  audioReply,
  contactBlock,
  emergencyContact,
  errorReply,
  fileNotice,
  formOf,
  greeting,
  joinParts,
  mediaReply,
  rateLimitReply,
  safeReply,
  unavailableReply,
} from './templates.js';
import type {
  ContactReason,
  HistoryTurn,
  ModelReply,
  PendingItem,
  ReplyContext,
} from './types.js';

export interface ResponderDeps {
  chatModel: ChatModel;
  clock: Clock;
  activityLog: ActivityLog;
  /** AUDIO_TRANSCRIPTION: cambia R-MEDIA y el aviso de archivo (FR-028a). */
  audioTranscription?: boolean;
  settings?: ConversationSettings;
}

export interface RespondInput {
  snapshot: KnowledgeSnapshot;
  history: HistoryTurn[];
  pending: PendingItem[];
  /** La conversación ya recibió el saludo (FR-020, FR-021). */
  greeted: boolean;
  now: Date;
  /** Solo para los registros (`via` y seudónimo); ninguna regla depende del canal (FR-002). */
  channel: Channel;
  customerKey: string;
  conversationId: string;
}

export interface Response {
  text: string;
  contactBlock: boolean;
  /** Por qué lleva contacto (`null` si no lo lleva); lo muestra "Probar el bot" (R7). */
  contactReason: ContactReason | null;
  greeting: boolean;
  template?: ReplyTemplate;
  modelMs?: number;
  /** Borradores rechazados por el verificador (0 – 2), sin sus valores. */
  groundingRejections: number;
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

/** El servicio tiene precio "a consultar" o sin importe: el cliente necesita el contacto. */
function priceNeedsContact(snapshot: KnowledgeSnapshot, serviceId: string): boolean {
  const price = snapshot.services.find((s) => s.id === serviceId)?.price;
  return price?.type === 'on_request' || price?.type === 'missing';
}

/**
 * Reglas de CONTACTO sobre la respuesta del modelo (contracts/bot-replies.md): devuelve el
 * motivo o `null`. La petición de persona (bandera del modelo o detector) siempre lo añade; si
 * el modelo pide reformular, nada más lo añade. Precedencia (004): `handoff_requested` >
 * `offer_contact` > `booking_requested` > `price_on_request`.
 */
export function needsContact(
  snapshot: KnowledgeSnapshot,
  reply: ModelReply,
  handoffDetected: boolean,
): ContactReason | null {
  if (reply.handoffRequested || handoffDetected) return 'handoff_requested';
  if (reply.needsRephrase) return null;
  if (reply.offerContact) return 'offer_contact';
  if (reply.bookingRequested) return 'booking_requested';
  if (reply.mentionedServiceIds.some((id) => priceNeedsContact(snapshot, id))) {
    return 'price_on_request';
  }
  return null;
}

/** Respuesta con plantilla fija: el contacto, si va, lo pone la plantilla. */
function templateResponse(
  text: string,
  truncated: boolean,
  withContact: boolean,
  template: ReplyTemplate,
): Response {
  return {
    text,
    truncated,
    contactBlock: withContact,
    contactReason: withContact ? 'template' : null,
    greeting: false,
    template,
    groundingRejections: 0,
  };
}

/** Explica al modelo qué tipo de dato sobraba, sin repetir los valores rechazados. */
export function groundingFeedback(categories: FactCategory[]): string {
  const kinds = categories.map((c) => CATEGORY_NAMES[c]).join(', ');
  return (
    `Tu respuesta anterior incluía valores (${kinds}) que no figuran en DATOS_DEL_NEGOCIO ni en ` +
    'HECHOS_CALCULADOS. Escríbela de nuevo usando solo esos datos; si no tienes el dato, dilo ' +
    'y marca offerContact.'
  );
}

/**
 * R-ERR cuando no se ha podido leer el snapshot (FR-029): sin nombre del negocio ni forma de
 * trato, porque no se conocen; con el contacto de emergencia de la instancia si lo hay.
 */
export function unreadableSnapshotReply(emergencyPhone: string | null): Response {
  const contact = emergencyPhone ? emergencyContact(emergencyPhone) : null;
  const { text, truncated } = joinParts({ body: errorReply('tu'), contact });
  return templateResponse(text, truncated, contact !== null, 'R-ERR');
}

/** R-LIMIT con el contacto del negocio, o con el de emergencia si no se pudo leer (FR-004a). */
export function rateLimitResponse(
  snapshot: KnowledgeSnapshot | null,
  emergencyPhone: string | null,
): Response {
  const contact = snapshot
    ? contactBlock(snapshot)
    : emergencyPhone
      ? emergencyContact(emergencyPhone)
      : null;
  const body = rateLimitReply(formOf(snapshot?.tone.addressForm ?? null));
  const { text, truncated } = joinParts({ body, contact });
  return templateResponse(text, truncated, contact !== null, 'R-LIMIT');
}

/**
 * R-UNAVAILABLE (004, R9): el chat no puede atender (tope alcanzado con mensajes ya aceptados).
 * Sin modelo ni saludo, siempre con contacto (o el de emergencia si no se pudo leer).
 */
export function unavailableResponse(
  snapshot: KnowledgeSnapshot | null,
  emergencyPhone: string | null,
): Response {
  const contact = snapshot
    ? contactBlock(snapshot)
    : emergencyPhone
      ? emergencyContact(emergencyPhone)
      : null;
  const body = unavailableReply(formOf(snapshot?.tone.addressForm ?? null));
  const { text, truncated } = joinParts({ body, contact });
  return templateResponse(text, truncated, contact !== null, 'R-UNAVAILABLE');
}

export function createResponder(deps: ResponderDeps) {
  const { chatModel, clock, activityLog } = deps;
  const settings = deps.settings ?? conversationSettings;
  const audioTranscription = deps.audioTranscription ?? false;

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
        greetingPrepended: !input.greeted,
        addressForm: snapshot.tone.addressForm,
      };
      const logContext = {
        channel: input.channel,
        customerKey: input.customerKey,
        conversationId: input.conversationId,
      };

      const { pending } = input;
      const notice = pending.some((p) => p.kind === 'other')
        ? fileNotice(audioTranscription)
        : null;
      let groundingRejections = 0;
      const compose = (
        body: string,
        reason: ContactReason | null,
        template?: ReplyTemplate,
        withNotice = true,
      ): Response => {
        const contact = reason ? contactBlock(snapshot) : null;
        const hello = input.greeted ? null : greeting(snapshot.business.name, form);
        const { text, truncated } = joinParts({
          greeting: hello,
          body,
          fileNotice: withNotice ? notice : null,
          contact,
        });
        return {
          text,
          truncated,
          contactBlock: reason !== null,
          contactReason: reason,
          greeting: hello !== null,
          template,
          groundingRejections,
        };
      };

      // Árbol de decisión (contracts/bot-replies.md): lotes que no necesitan al modelo.
      if (pending.every((p) => p.kind === 'other' && !p.text)) {
        return compose(mediaReply(form, audioTranscription), null, 'R-MEDIA', false);
      }
      if (audioTranscription && pending.every((p) => p.kind === 'audio' && !p.audioUnderstood)) {
        return compose(audioReply(form), null, 'R-AUDIO');
      }

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
          groundingRejections += 1;
          activityLog.log(
            { event: 'grounding_rejected', attempt, offendingCount: guard.offending.length },
            logContext,
          );
          const remaining = settings.modelBudgetMs - elapsed();
          if (attempt >= 2 || remaining < settings.minRetryBudgetMs) {
            return { ...compose(safeReply(form), 'template', 'R-SAFE'), modelMs: elapsed() };
          }
          feedback = groundingFeedback(offendingCategories(reply.body, allowed));
        }
        const handoffDetected = input.pending.some(
          (p) => p.text !== null && detectsHandoffRequest(p.text),
        );
        return {
          ...compose(reply.body, needsContact(snapshot, reply, handoffDetected)),
          modelMs: elapsed(),
        };
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
        return { ...compose(errorReply(form), 'template', 'R-ERR'), modelMs: elapsed() };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export type Responder = ReturnType<typeof createResponder>;
