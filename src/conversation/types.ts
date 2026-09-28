/** Tipos del dominio de conversación (contracts/chat-model.md y data-model.md). */
import { z } from 'zod';
import { HANDOFF_KINDS, type HandoffStep } from '../handoff/types.js';
import type { Interval } from '../knowledge/time/intervals.js';
import type {
  AddressForm,
  ISODate,
  KnowledgeSnapshot,
  LocalTime,
  Weekday,
} from '../knowledge/types.js';
import { CHANNELS, channelUserIdSchema } from './channels.js';
import { conversationSettings } from './settings.js';

export type MessageKind = 'text' | 'audio' | 'other';

/** Mensaje entrante ya normalizado por el adaptador del canal (004: cualquier canal). */
export const inboundEventSchema = z
  .object({
    channel: z.enum(CHANNELS),
    /** Cliente en el canal: E.164, hash de la sesión web o UUID del playground. */
    channelUserId: z.string().min(1),
    /** Id del mensaje en el canal; deduplica los reintentos (FR-023). */
    channelMessageId: z.string().min(1),
    /** Marca del canal (WhatsApp) o del servidor (web y playground). */
    sentAt: z.date(),
    kind: z.enum(['text', 'audio', 'other']),
    text: z.string().nullable(),
    caption: z.string().nullable(),
    mediaId: z.string().nullable(),
    /** Tipo de WhatsApp cuando `kind = other` (`image`, `sticker`, `audio`…). */
    otherType: z.string().nullable(),
    isGroup: z.boolean(),
    /** Nombre de perfil de WhatsApp (005); `null` en web y playground. */
    profileName: z.string().nullable(),
    /** Payload de un botón de respuesta rápida de una plantilla (005); `null` si no lo es. */
    buttonPayload: z.string().nullable(),
  })
  .superRefine((event, ctx) => {
    if (!channelUserIdSchema(event.channel).safeParse(event.channelUserId).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['channelUserId'],
        message: 'Identificador de cliente no válido para el canal',
      });
    }
  });
export type InboundEvent = z.infer<typeof inboundEventSchema>;

/**
 * Por qué una respuesta lleva el bloque de contacto (004, R7). 005: `handoff_unavailable`
 * (petición o queja sin vías o con el aviso no entregado) y `contact_refused` (el cliente no dio
 * sus datos).
 */
export const CONTACT_REASONS = [
  'handoff_requested',
  'offer_contact',
  'booking_requested',
  'price_on_request',
  'template',
  'handoff_unavailable',
  'contact_refused',
] as const;
export type ContactReason = (typeof CONTACT_REASONS)[number];

export const REPLY_TEMPLATES = [
  'R-SAFE',
  'R-ERR',
  'R-MEDIA',
  'R-AUDIO',
  'R-LIMIT',
  'R-UNAVAILABLE',
  'R-HANDOFF-ASK',
  'R-HANDOFF-PHONE',
  'R-HANDOFF-OK',
  'R-HANDOFF-COMPLAINT',
  'R-HANDOFF-LATE',
] as const;

/** Qué hizo la derivación en una respuesta (005); sin textos. */
export const HANDOFF_ACTIONS = [
  'offered',
  'asked',
  'asked_again',
  'started',
  'not_started',
  'late_notice',
] as const;
export type HandoffAction = (typeof HANDOFF_ACTIONS)[number];

const routeResult = z.enum(['sent', 'failed']);

/**
 * Cómo se compuso una respuesta (FR-009, R7). Se guarda en cada saliente; sin textos ni
 * valores rechazados por el verificador.
 */
export const replyTraceSchema = z
  .object({
    template: z.enum(REPLY_TEMPLATES).nullable(),
    greeting: z.boolean(),
    contact: z.object({
      added: z.boolean(),
      reason: z.enum(CONTACT_REASONS).nullable(),
    }),
    groundingRejections: z.number().int().min(0).max(2),
    modelMs: z.number().int().min(0).nullable(),
    latencyMs: z.number().int().min(0),
    /** Derivación en esta respuesta (005): acción, tipo y resultado por vía, sin textos. */
    handoff: z
      .object({
        action: z.enum(HANDOFF_ACTIONS),
        kind: z.enum(HANDOFF_KINDS).nullable(),
        routes: z.object({
          whatsapp: routeResult.optional(),
          email: routeResult.optional(),
          simulated: routeResult.optional(),
        }),
      })
      .optional(),
  })
  .refine((t) => t.contact.added || t.contact.reason === null, {
    path: ['contact', 'reason'],
    message: 'Sin contacto no hay motivo',
  });
export type ReplyTrace = z.infer<typeof replyTraceSchema>;

/** Hechos calculados por código a partir del snapshot (R8): el modelo no calcula nada. */
export interface DerivedFacts {
  now: { date: ISODate; time: LocalTime; weekday: Weekday; timezone: string };
  openNow: boolean;
  next14Days: Array<{
    date: ISODate;
    weekday: Weekday;
    intervals: Interval[];
    closureReason: string | null;
  }>;
  prices: Array<{ serviceId: string; text: string }>;
  /** Plazos de las políticas ya convertidos a días u horas ("60 días"); null si no hay. */
  policies: {
    cancellationNotice: string | null;
    minAdvance: string | null;
    maxAdvance: string | null;
  };
  handoffHoursText: string | null;
}

export interface HistoryTurn {
  direction: 'inbound' | 'outbound';
  text: string;
}

export interface PendingItem {
  kind: MessageKind;
  text: string | null;
  audioUnderstood?: boolean;
}

export interface ReplyContext {
  snapshot: KnowledgeSnapshot;
  derived: DerivedFacts;
  history: HistoryTurn[];
  pending: PendingItem[];
  greetingPrepended: boolean;
  addressForm: AddressForm | null;
  /** Paso previo a la derivación (005): el prompt lo convierte en indicaciones. */
  handoffStep: HandoffStep | null;
  /** Hubo una derivación terminada en esta conversación (005, FR-018). */
  handoffEnded: boolean;
}

/** Salida estructurada del modelo. */
export const modelReplySchema = z.object({
  body: z.string().max(conversationSettings.modelBodyMaxChars),
  handoffRequested: z.boolean(),
  offerContact: z.boolean(),
  bookingRequested: z.boolean(),
  needsRephrase: z.boolean(),
  mentionedServiceIds: z.array(z.string()),
  /** Queja o reclamación (005, FR-003). */
  complaint: z.boolean().default(false),
  /** Acepta la derivación ofrecida; solo se lee con `handoff_step = offered`. */
  acceptsHandoff: z.boolean().default(false),
  /** No quiere dar sus datos; solo se lee con `handoff_step = collecting`. */
  refusesContact: z.boolean().default(false),
  /** Copia literal del nombre que dio el cliente; solo con `collecting`. */
  contactName: z.string().nullable().default(null),
  /** Copia literal del teléfono que dio el cliente; solo con `collecting`. */
  contactPhone: z.string().nullable().default(null),
});
export type ModelReply = z.infer<typeof modelReplySchema>;

/**
 * Valores que el verificador de cifras acepta (R8), ya normalizados:
 * horas `HH:MM`, fechas `AAAA-MM-DD`, teléfonos E.164, correos y URLs en minúsculas,
 * importes en céntimos y números sueltos como texto canónico ("15", "35.5").
 */
export interface AllowedFacts {
  times: Set<string>;
  dates: Set<string>;
  phones: Set<string>;
  emails: Set<string>;
  urls: Set<string>;
  amountsCents: Set<number>;
  numbers: Set<string>;
}
