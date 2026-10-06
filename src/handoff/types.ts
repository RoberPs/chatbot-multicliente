/**
 * Tipos del dominio de la derivación al negocio (005, data-model.md). Sin HTTP ni SDK: los
 * adaptadores (WhatsApp, email, modelo) viven fuera de `src/handoff`.
 */
import { z } from 'zod';
import type { Channel } from '../conversation/channels.js';
import type { MessageKind } from '../conversation/types.js';

export const HANDOFF_KINDS = ['person', 'unresolved', 'complaint'] as const;
/** Petición de persona, consulta sin resolver y queja o reclamación. */
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

export const CONTACT_FIELDS = ['name', 'phone'] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];

const isoInstant = z.iso.datetime({ offset: true });

/** Paso previo a la derivación guardado en `conversation.handoff_step` (R2). */
export const handoffStepSchema = z.discriminatedUnion('step', [
  z.object({
    step: z.literal('offered'),
    kind: z.literal('unresolved'),
    at: isoInstant,
  }),
  z.object({
    step: z.literal('collecting'),
    kind: z.enum(HANDOFF_KINDS),
    missing: z.array(z.enum(CONTACT_FIELDS)).min(1),
    /** Ya se pidió el teléfono una segunda vez (FR-005). */
    phoneRetried: z.boolean(),
    at: isoInstant,
  }),
]);
export type HandoffStep = z.infer<typeof handoffStepSchema>;

export const ROUTE_NAMES = ['whatsapp', 'email', 'simulated'] as const;
export type RouteName = (typeof ROUTE_NAMES)[number];

/** Resultado de un aviso por cada vía que se intentó. */
export type RouteResults = Partial<Record<RouteName, 'sent' | 'failed'>>;

export type HandoffActionVia = 'whatsapp' | 'email';
/** `interrupted` (012, R10.4): un reintento no sabe si la alerta de inicio llegó al negocio. */
export type HandoffEndCause = 'business' | 'inactivity' | 'operator' | 'playground' | 'interrupted';

/** Datos de la derivación que llevan todos los mensajes al negocio. */
export interface NoticeHandoff {
  id: string;
  kind: HandoffKind;
  customerName: string;
  /** E.164. */
  customerPhone: string;
  channel: Channel;
  summary: string;
  startedAt: Date;
  /** Zona IANA del negocio, para escribir horas locales. */
  timezone: string;
  /** En claro solo en memoria, para botones y enlaces (R9). */
  token: string;
  /** `Message-ID` del aviso por email (hilo del recordatorio y los reenvíos). */
  threadRef: string | null;
}

export interface ForwardItem {
  text: string | null;
  kind: MessageKind;
  otherType: string | null;
  /** Hora del mensaje, para el reenvío completo por email. */
  sentAt: Date;
}

/** Mensaje al negocio ya compuesto por el dominio; cada vía lo traduce a su formato. */
export type BusinessNotice =
  | { type: 'alert'; handoff: NoticeHandoff }
  | {
      type: 'reminder';
      handoff: NoticeHandoff;
      waitingSince: Date;
      /** A las 2 h de horario (`schedule`) o al cerrarse por inactividad (FR-019). */
      trigger: 'schedule' | 'inactivity';
    }
  | {
      type: 'forward';
      handoff: NoticeHandoff;
      items: ForwardItem[];
      /** Hay vía email ahora: el recorte de WhatsApp lo menciona (R6). */
      emailAvailable: boolean;
    };
