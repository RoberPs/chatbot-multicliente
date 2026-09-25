/** Tipos del dominio de conversación (contracts/chat-model.md y data-model.md). */
import { z } from 'zod';
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

/** Por qué una respuesta lleva el bloque de contacto (004, R7). */
export type ContactReason =
  | 'handoff_requested'
  | 'offer_contact'
  | 'booking_requested'
  | 'price_on_request'
  | 'template';

/**
 * Cómo se compuso una respuesta (FR-009, R7). Se guarda en cada saliente; sin textos ni
 * valores rechazados por el verificador.
 */
export const replyTraceSchema = z
  .object({
    template: z.enum(['R-SAFE', 'R-ERR', 'R-MEDIA', 'R-AUDIO', 'R-LIMIT', 'R-UNAVAILABLE']).nullable(),
    greeting: z.boolean(),
    contact: z.object({
      added: z.boolean(),
      reason: z
        .enum(['handoff_requested', 'offer_contact', 'booking_requested', 'price_on_request', 'template'])
        .nullable(),
    }),
    groundingRejections: z.number().int().min(0).max(2),
    modelMs: z.number().int().min(0).nullable(),
    latencyMs: z.number().int().min(0),
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
}

/** Salida estructurada del modelo. */
export const modelReplySchema = z.object({
  body: z.string().max(conversationSettings.modelBodyMaxChars),
  handoffRequested: z.boolean(),
  offerContact: z.boolean(),
  bookingRequested: z.boolean(),
  needsRephrase: z.boolean(),
  mentionedServiceIds: z.array(z.string()),
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
