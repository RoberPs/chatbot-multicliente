/**
 * Canales de atención y su política (004, research R1, contracts/conversation-channels.md).
 *
 * Lo que cambia entre canales está solo en esta tabla: la recepción y el procesador la
 * consultan en vez de preguntar por el canal. El responder no sabe nada de canales (FR-002).
 */
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';
import { storedDelivery, type ChannelSender } from './ports.js';
import { conversationSettings } from './settings.js';

export const CHANNELS = ['whatsapp', 'web', 'playground'] as const;
export type Channel = (typeof CHANNELS)[number];

/** E.164 que libphonenumber-js reconoce como número (sin exigir que esté asignado). */
const e164 = z
  .string()
  .regex(/^\+\d{6,15}$/, 'Teléfono en formato E.164')
  .refine((v) => parsePhoneNumberFromString(v)?.number === v, 'Teléfono en formato E.164');

const CHANNEL_USER_ID: Record<Channel, z.ZodType<string>> = {
  whatsapp: e164,
  // hex(SHA-256(id de sesión)): el token nunca llega aquí (R4).
  web: z.string().regex(/^[0-9a-f]{64}$/, 'Identificador de sesión web'),
  playground: z.uuid('Identificador de conversación de prueba'),
};

/** Esquema del identificador del cliente en cada canal (data-model.md). */
export const channelUserIdSchema = (channel: Channel): z.ZodType<string> =>
  CHANNEL_USER_ID[channel];

export interface ChannelPolicy {
  /** Graph API en WhatsApp; entrega guardada en web y playground (R5). */
  sender: ChannelSender;
  /** Ventana para poder responder desde el último mensaje del cliente; `null` si no hay. */
  replyWindowMs: number | null;
  /** Solo se atiende con el negocio activo (FR-022; el playground no, FR-011). */
  requiresActiveBusiness: boolean;
  /** Solo se atiende con el chat web activado en el panel. */
  requiresWebChatEnabled: boolean;
  /** Cuenta para los topes diario y mensual del chat web (FR-026). */
  usageCap: boolean;
  /**
   * Se corta con el tope mensual de gasto (010, FR-016 – FR-019): los canales de clientes
   * finales; "Probar el bot" no.
   */
  spendCap: boolean;
  /**
   * El canal da los datos de contacto (005, R15): en WhatsApp el teléfono es el
   * `channel_user_id` y el nombre, el de perfil; en web y playground se piden al cliente.
   */
  contactFromChannel: boolean;
  /** Los avisos al negocio se simulan y no salen de la instancia (005, FR-021). */
  simulateAlerts: boolean;
}

/** Sin WhatsApp configurado su política no existe (y el webhook no se registra). */
export type ChannelPolicies = { whatsapp?: ChannelPolicy } & Record<
  Exclude<Channel, 'whatsapp'>,
  ChannelPolicy
>;

/** Tabla de R1: WhatsApp solo si hay sender de la Graph API. */
export function buildChannelPolicies(opts: {
  whatsappSender?: ChannelSender | null;
  /** Entrega guardada (web y playground); por defecto `storedDelivery`. */
  stored?: ChannelSender;
}): ChannelPolicies {
  const stored = opts.stored ?? storedDelivery;
  return {
    ...(opts.whatsappSender
      ? {
          whatsapp: {
            sender: opts.whatsappSender,
            replyWindowMs: conversationSettings.conversationWindowMs,
            requiresActiveBusiness: true,
            requiresWebChatEnabled: false,
            usageCap: false,
            spendCap: true,
            contactFromChannel: true,
            simulateAlerts: false,
          },
        }
      : {}),
    web: {
      sender: stored,
      replyWindowMs: null,
      requiresActiveBusiness: true,
      requiresWebChatEnabled: true,
      usageCap: true,
      spendCap: true,
      contactFromChannel: false,
      simulateAlerts: false,
    },
    playground: {
      sender: stored,
      replyWindowMs: null,
      requiresActiveBusiness: false,
      requiresWebChatEnabled: false,
      usageCap: false,
      spendCap: false,
      contactFromChannel: false,
      simulateAlerts: true,
    },
  };
}
