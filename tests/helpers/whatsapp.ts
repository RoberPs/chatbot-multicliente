/** Payloads de la WhatsApp Cloud API y firma del webhook para tests. */
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export const TEST_PHONE_NUMBER_ID = '109876543210';
export const TEST_APP_SECRET = 'secreto-de-prueba-de-la-app';
export const TEST_VERIFY_TOKEN = 'token-de-verificacion';
export const testWhatsApp = {
  phoneNumberId: TEST_PHONE_NUMBER_ID,
  accessToken: 'token-de-prueba',
  appSecret: TEST_APP_SECRET,
  verifyToken: TEST_VERIFY_TOKEN,
  graphVersion: 'v23.0',
};
export const CUSTOMER_WA = '34600111222';
export const CUSTOMER_E164 = '+34600111222';

let counter = 0;
export const nextWaId = () => {
  counter += 1;
  return `wamid.TEST${String(counter).padStart(8, '0')}`;
};

export interface MessageOptions {
  id?: string;
  from?: string;
  /** Segundos Unix o fecha. */
  timestamp?: number | Date;
  groupId?: string;
}

const ts = (t: number | Date | undefined) =>
  String(
    t === undefined
      ? Math.floor(Date.now() / 1000)
      : t instanceof Date
        ? Math.floor(t.getTime() / 1000)
        : t,
  );

function baseMessage(type: string, opts: MessageOptions) {
  return {
    from: opts.from ?? CUSTOMER_WA,
    id: opts.id ?? nextWaId(),
    timestamp: ts(opts.timestamp),
    type,
    ...(opts.groupId ? { group_id: opts.groupId } : {}),
  };
}

export const textMessage = (body: string, opts: MessageOptions = {}) => ({
  ...baseMessage('text', opts),
  text: { body },
});

export const audioMessage = (opts: MessageOptions & { mediaId?: string } = {}) => ({
  ...baseMessage('audio', opts),
  audio: { id: opts.mediaId ?? 'media-audio-1', mime_type: 'audio/ogg; codecs=opus', voice: true },
});

export const imageMessage = (opts: MessageOptions & { caption?: string } = {}) => ({
  ...baseMessage('image', opts),
  image: {
    id: 'media-image-1',
    mime_type: 'image/jpeg',
    ...(opts.caption === undefined ? {} : { caption: opts.caption }),
  },
});

export const stickerMessage = (opts: MessageOptions = {}) => ({
  ...baseMessage('sticker', opts),
  sticker: { id: 'media-sticker-1', mime_type: 'image/webp', animated: false },
});

export const statusUpdate = (
  status: 'sent' | 'delivered' | 'read' | 'failed',
  id = nextWaId(),
) => ({
  id,
  status,
  timestamp: ts(undefined),
  recipient_id: CUSTOMER_WA,
  ...(status === 'failed' ? { errors: [{ code: 131047, title: 'Re-engagement message' }] } : {}),
});

export interface PayloadOptions {
  phoneNumberId?: string;
  messages?: object[];
  statuses?: object[];
  profileName?: string | null;
}

/** Evento `whatsapp_business_account` con un único cambio. */
export function webhookPayload(opts: PayloadOptions = {}) {
  const value: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    metadata: {
      display_phone_number: '34900000000',
      phone_number_id: opts.phoneNumberId ?? TEST_PHONE_NUMBER_ID,
    },
  };
  if (opts.messages) {
    // `profileName: null` simula un remitente sin nombre de perfil (005).
    value.contacts =
      opts.profileName === null
        ? [{ wa_id: CUSTOMER_WA }]
        : [{ profile: { name: opts.profileName ?? 'Cliente' }, wa_id: CUSTOMER_WA }];
    value.messages = opts.messages;
  }
  if (opts.statuses) value.statuses = opts.statuses;
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA-1', changes: [{ field: 'messages', value }] }],
  };
}

export const sign = (body: string, secret = TEST_APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/** POST al webhook con firma válida (o la indicada; `null` = sin firma). */
export function postWebhook(
  app: FastifyInstance,
  payload: unknown,
  opts: { signature?: string | null; raw?: string } = {},
) {
  const body = opts.raw ?? JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const signature = opts.signature === undefined ? sign(body) : opts.signature;
  if (signature !== null) headers['x-hub-signature-256'] = signature;
  return app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers, payload: body });
}
