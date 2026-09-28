import { describe, expect, it } from 'vitest';
import { buildChannelPolicies, channelUserIdSchema } from '../../../src/conversation/channels.js';
import { storedDelivery, type ChannelSender } from '../../../src/conversation/ports.js';
import { conversationSettings } from '../../../src/conversation/settings.js';

const graph: ChannelSender = { sendText: async () => ({ channelMessageId: 'wamid.1' }) };
const WEB_ID = 'a'.repeat(64);
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('channel_user_id por canal', () => {
  it.each([
    ['whatsapp', '+34600111222', true],
    ['whatsapp', '34600111222', false],
    ['whatsapp', WEB_ID, false],
    ['web', WEB_ID, true],
    ['web', 'A'.repeat(64), false],
    ['web', 'a'.repeat(63), false],
    ['web', UUID, false],
    ['playground', UUID, true],
    ['playground', '+34600111222', false],
  ] as const)('%s acepta %s → %s', (channel, value, ok) => {
    expect(channelUserIdSchema(channel).safeParse(value).success).toBe(ok);
  });
});

describe('políticas de canal (R1)', () => {
  it('tabla exacta con WhatsApp configurado', () => {
    const policies = buildChannelPolicies({ whatsappSender: graph });
    expect(policies.whatsapp).toEqual({
      sender: graph,
      replyWindowMs: conversationSettings.conversationWindowMs,
      requiresActiveBusiness: true,
      requiresWebChatEnabled: false,
      usageCap: false,
      contactFromChannel: true,
      simulateAlerts: false,
    });
    expect(policies.web).toEqual({
      sender: storedDelivery,
      replyWindowMs: null,
      requiresActiveBusiness: true,
      requiresWebChatEnabled: true,
      usageCap: true,
      contactFromChannel: false,
      simulateAlerts: false,
    });
    expect(policies.playground).toEqual({
      sender: storedDelivery,
      replyWindowMs: null,
      requiresActiveBusiness: false,
      requiresWebChatEnabled: false,
      usageCap: false,
      contactFromChannel: false,
      simulateAlerts: true,
    });
  });

  it('sin WhatsApp no hay política de WhatsApp', () => {
    const policies = buildChannelPolicies({ whatsappSender: null });
    expect(policies.whatsapp).toBeUndefined();
    expect(Object.keys(policies).sort()).toEqual(['playground', 'web']);
  });

  it('storedDelivery no llama a nada y da ids out: distintos', async () => {
    const a = await storedDelivery.sendText(WEB_ID, 'hola');
    const b = await storedDelivery.sendText(WEB_ID, 'hola');
    expect(a.channelMessageId).toMatch(/^out:[0-9a-f-]{36}$/);
    expect(a.channelMessageId).not.toBe(b.channelMessageId);
  });
});
