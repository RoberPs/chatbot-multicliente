import { describe, expect, it } from 'vitest';
import { parseWebhookPayload } from '../../../src/channels/whatsapp/payload.js';
import {
  audioMessage,
  CUSTOMER_E164,
  imageMessage,
  statusUpdate,
  stickerMessage,
  TEST_PHONE_NUMBER_ID,
  textMessage,
  webhookPayload,
} from '../../helpers/whatsapp.js';

const off = { phoneNumberId: TEST_PHONE_NUMBER_ID, audioTranscription: false };
const on = { phoneNumberId: TEST_PHONE_NUMBER_ID, audioTranscription: true };

function events(messages: object[], opts = off) {
  const result = parseWebhookPayload(webhookPayload({ messages }), opts);
  if (!result.ok) throw new Error('payload no válido');
  return result.data.events;
}

describe('parser del webhook de WhatsApp', () => {
  it('texto → kind text, E.164 y marca de WhatsApp', () => {
    const [e] = events([textMessage('hola', { id: 'wamid.1', timestamp: 1790000000 })]);
    expect(e).toEqual({
      channel: 'whatsapp',
      channelUserId: CUSTOMER_E164,
      channelMessageId: 'wamid.1',
      sentAt: new Date(1790000000 * 1000),
      kind: 'text',
      text: 'hola',
      caption: null,
      mediaId: null,
      otherType: null,
      isGroup: false,
      profileName: 'Cliente',
      buttonPayload: null,
    });
  });

  it('nombre de perfil por wa_id; sin perfil → null (005)', () => {
    const named = parseWebhookPayload(
      webhookPayload({ messages: [textMessage('hola')], profileName: '  Lucía Pérez ' }),
      off,
    );
    if (!named.ok) throw new Error('payload no válido');
    expect(named.data.events[0]?.profileName).toBe('Lucía Pérez');

    const anonymous = parseWebhookPayload(
      webhookPayload({ messages: [textMessage('hola')], profileName: null }),
      off,
    );
    if (!anonymous.ok) throw new Error('payload no válido');
    expect(anonymous.data.events[0]?.profileName).toBeNull();

    // El perfil de otro número no se asigna a este remitente.
    const other = webhookPayload({ messages: [textMessage('hola')] });
    const value = other.entry[0]?.changes[0]?.value as { contacts: Array<{ wa_id: string }> };
    value.contacts[0] = { ...value.contacts[0], wa_id: '34999999999' };
    const parsed = parseWebhookPayload(other, off);
    if (!parsed.ok) throw new Error('payload no válido');
    expect(parsed.data.events[0]?.profileName).toBeNull();
  });

  it('audio con los audios apagados → other/audio sin media', () => {
    const [e] = events([audioMessage()], off);
    expect(e).toMatchObject({ kind: 'other', otherType: 'audio', mediaId: null, text: null });
  });

  it('audio con los audios encendidos → audio con su media', () => {
    const [e] = events([audioMessage({ mediaId: 'm-7' })], on);
    expect(e).toMatchObject({ kind: 'audio', mediaId: 'm-7', otherType: null });
  });

  it('imagen con pie → other con caption; sin pie → caption null', () => {
    const [withCaption, without] = events([
      imageMessage({ caption: '¿cuánto cuesta esto?' }),
      imageMessage(),
    ]);
    expect(withCaption).toMatchObject({
      kind: 'other',
      otherType: 'image',
      caption: '¿cuánto cuesta esto?',
    });
    expect(without).toMatchObject({ kind: 'other', otherType: 'image', caption: null });
  });

  it.each(['sticker', 'location', 'contacts', 'reaction', 'interactive', 'button', 'unsupported'])(
    '%s → other sin texto',
    (type) => {
      const message =
        type === 'sticker' ? stickerMessage() : { ...textMessage('x'), type, text: undefined };
      const [e] = events([message]);
      expect(e).toMatchObject({ kind: 'other', otherType: type, text: null, caption: null });
    },
  );

  it('mensaje de grupo → isGroup', () => {
    const [e] = events([textMessage('hola', { groupId: 'grupo-1' })]);
    expect(e?.isGroup).toBe(true);
  });

  it('solo estados → sin eventos; cuenta los failed', () => {
    const result = parseWebhookPayload(
      webhookPayload({ statuses: [statusUpdate('delivered'), statusUpdate('failed')] }),
      off,
    );
    expect(result).toEqual({ ok: true, data: { events: [], failedStatuses: 1, foreign: 0 } });
  });

  it('otro phone_number_id → ignorado', () => {
    const result = parseWebhookPayload(
      webhookPayload({ phoneNumberId: '999', messages: [textMessage('hola')] }),
      off,
    );
    expect(result).toEqual({ ok: true, data: { events: [], failedStatuses: 0, foreign: 1 } });
  });

  it.each([
    ['objeto distinto', { object: 'page', entry: [] }],
    ['sin entry', { object: 'whatsapp_business_account' }],
    ['texto', 'hola'],
    [
      'mensaje sin id',
      webhookPayload({ messages: [{ from: '34600111222', timestamp: '1', type: 'text' }] }),
    ],
    [
      'sin metadata',
      {
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: {} }] }],
      },
    ],
  ])('payload inválido: %s', (_name, payload) => {
    expect(parseWebhookPayload(payload, off)).toEqual({ ok: false });
  });
});
