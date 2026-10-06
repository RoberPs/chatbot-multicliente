/**
 * Evento `whatsapp_business_account` de la Cloud API → `InboundEvent`
 * (contracts/whatsapp-webhook.md, mapeo de tipos). Desde la 005 se extrae el nombre de perfil
 * de cada remitente (`contacts[].profile.name`), que la derivación usa como nombre del cliente,
 * y el payload de los botones de respuesta rápida de las plantillas ("Le atiendo", "Terminado").
 */
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';
import type { InboundEvent } from '../../conversation/types.js';

const media = z.object({ id: z.string(), caption: z.string().optional() }).loose();

const messageSchema = z
  .object({
    from: z.string().regex(/^\+?\d{6,15}$/),
    id: z.string().min(1),
    timestamp: z.string().regex(/^\d+$/),
    type: z.string().min(1),
    group_id: z.string().optional(),
    text: z.object({ body: z.string() }).loose().optional(),
    audio: media.optional(),
    image: media.optional(),
    video: media.optional(),
    document: media.optional(),
    /** Respuesta rápida de una plantilla (005, R10). */
    button: z.object({ payload: z.string().optional() }).loose().optional(),
    interactive: z
      .object({ button_reply: z.object({ id: z.string().optional() }).loose().optional() })
      .loose()
      .optional(),
  })
  .loose();

const statusSchema = z
  .object({ id: z.string(), status: z.string(), recipient_id: z.string().optional() })
  .loose();

const contactSchema = z
  .object({
    wa_id: z.string().optional(),
    profile: z.object({ name: z.string().optional() }).loose().optional(),
  })
  .loose();

const valueSchema = z
  .object({
    messaging_product: z.literal('whatsapp').optional(),
    metadata: z.object({ phone_number_id: z.string() }).loose(),
    contacts: z.array(contactSchema).optional(),
    messages: z.array(messageSchema).optional(),
    statuses: z.array(statusSchema).optional(),
  })
  .loose();

export const webhookPayloadSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z
      .object({
        id: z.string().optional(),
        changes: z.array(z.object({ field: z.string(), value: z.unknown() }).loose()),
      })
      .loose(),
  ),
});

export interface ParsedWebhook {
  /** Mensajes del número de la instancia, incluidos los de grupo (`isGroup`). */
  events: InboundEvent[];
  /** Estados `failed` de salientes (se registran como `send_failed`). */
  failedStatuses: number;
  /** Cambios de otro `phone_number_id`, ignorados. */
  foreign: number;
}

export type ParseResult = { ok: true; data: ParsedWebhook } | { ok: false };

/** `34600111222` → `+34600111222`. */
function toE164(from: string): string {
  const digits = from.replace(/^\+/, '');
  const phone = parsePhoneNumberFromString(`+${digits}`);
  return phone?.number ?? `+${digits}`;
}

const WITH_CAPTION = new Set(['image', 'video', 'document']);

/** Nombre de perfil de cada remitente, por `wa_id` (sin `+`). */
function profileNames(contacts: Array<z.infer<typeof contactSchema>>): Map<string, string> {
  const names = new Map<string, string>();
  for (const c of contacts) {
    const name = c.profile?.name?.trim();
    if (c.wa_id && name) names.set(c.wa_id.replace(/^\+/, ''), name);
  }
  return names;
}

function toEvent(
  m: z.infer<typeof messageSchema>,
  audioTranscription: boolean,
  profileName: string | null,
): InboundEvent {
  const base = {
    channel: 'whatsapp' as const,
    channelUserId: toE164(m.from),
    channelMessageId: m.id,
    sentAt: new Date(Number(m.timestamp) * 1000),
    isGroup: m.group_id !== undefined,
    profileName,
    buttonPayload: null,
  };
  if (m.type === 'text' && m.text) {
    return {
      ...base,
      kind: 'text',
      text: m.text.body,
      caption: null,
      mediaId: null,
      otherType: null,
    };
  }
  if (m.type === 'audio' && audioTranscription && m.audio) {
    return {
      ...base,
      kind: 'audio',
      text: null,
      caption: null,
      mediaId: m.audio.id,
      otherType: null,
    };
  }
  // Botón de una plantilla (005): `button.payload` o `interactive.button_reply.id`.
  const payload =
    m.type === 'button'
      ? m.button?.payload
      : m.type === 'interactive'
        ? m.interactive?.button_reply?.id
        : undefined;
  if (payload !== undefined) {
    return {
      ...base,
      kind: 'other',
      text: null,
      caption: null,
      mediaId: null,
      otherType: 'button',
      buttonPayload: payload,
    };
  }
  const captioned = WITH_CAPTION.has(m.type)
    ? (m[m.type as 'image' | 'video' | 'document']?.caption ?? null)
    : null;
  return {
    ...base,
    kind: 'other',
    text: null,
    caption: captioned !== null && captioned.trim() !== '' ? captioned : null,
    mediaId: null,
    otherType: m.type,
  };
}

export function parseWebhookPayload(
  input: unknown,
  opts: { phoneNumberId: string; audioTranscription: boolean },
): ParseResult {
  const parsed = webhookPayloadSchema.safeParse(input);
  if (!parsed.success) return { ok: false };
  const data: ParsedWebhook = { events: [], failedStatuses: 0, foreign: 0 };
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const value = valueSchema.safeParse(change.value);
      if (!value.success) return { ok: false };
      if (value.data.metadata.phone_number_id !== opts.phoneNumberId) {
        data.foreign += 1;
        continue;
      }
      const names = profileNames(value.data.contacts ?? []);
      for (const m of value.data.messages ?? []) {
        const name = names.get(m.from.replace(/^\+/, '')) ?? null;
        data.events.push(toEvent(m, opts.audioTranscription, name));
      }
      data.failedStatuses += (value.data.statuses ?? []).filter(
        (s) => s.status === 'failed',
      ).length;
    }
  }
  return { ok: true, data };
}
