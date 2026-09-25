/** Contrato del webhook de WhatsApp (contracts/whatsapp-webhook.md). */
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../src/conversation/ports.js';
import type { InboundEvent } from '../../src/conversation/types.js';
import { buildTestApp } from '../helpers/app.js';
import { createTestBot, type TestBot } from '../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { RecordingActivityLog } from '../helpers/fakes.js';
import {
  imageMessage,
  postWebhook,
  sign,
  statusUpdate,
  TEST_VERIFY_TOKEN,
  testWhatsApp,
  textMessage,
  webhookPayload,
} from '../helpers/whatsapp.js';

describe('webhook de WhatsApp: firma, alta y filtrado', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  const log = new RecordingActivityLog();
  const received: InboundEvent[][] = [];
  let failIntake = false;

  beforeAll(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db, undefined, {
      whatsapp: testWhatsApp,
      audioTranscription: false,
      activityLog: log,
      intake: {
        handle: async (events) => {
          if (failIntake) throw new Error('BD caída');
          received.push(events);
          return [];
        },
      },
      reader: {
        getSnapshot: () => Promise.reject(new Error('no se usa')),
      },
      emergencyContactPhone: null,
      clock: systemClock,
    });
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });
  beforeEach(() => {
    received.length = 0;
    log.events.length = 0;
    failIntake = false;
  });

  describe('GET: verificación del alta', () => {
    it('token correcto → 200 con el challenge', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${TEST_VERIFY_TOKEN}&hub.challenge=12345`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('12345');
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
    });

    it.each([
      ['token incorrecto', `hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1`],
      [
        'modo incorrecto',
        `hub.mode=unsubscribe&hub.verify_token=${TEST_VERIFY_TOKEN}&hub.challenge=1`,
      ],
      ['sin parámetros', ''],
    ])('%s → 403', async (_name, query) => {
      const res = await app.inject({ method: 'GET', url: `/webhooks/whatsapp?${query}` });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST: eventos', () => {
    it('mensaje válido → 200 y onInbound recibe el evento', async () => {
      const res = await postWebhook(app, webhookPayload({ messages: [textMessage('hola')] }));
      expect(res.statusCode).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]?.[0]).toMatchObject({ kind: 'text', text: 'hola', channelUserId: '+34600111222' });
    });

    it('sin firma → 401 y webhook_rejected{signature}', async () => {
      const res = await postWebhook(app, webhookPayload({ messages: [textMessage('hola')] }), {
        signature: null,
      });
      expect(res.statusCode).toBe(401);
      expect(received).toHaveLength(0);
      expect(log.named('webhook_rejected')).toEqual([
        { event: 'webhook_rejected', reason: 'signature' },
      ]);
    });

    it('firma con otro secreto → 401', async () => {
      const payload = webhookPayload({ messages: [textMessage('hola')] });
      const res = await postWebhook(app, payload, {
        signature: sign(JSON.stringify(payload), 'otro-secreto'),
      });
      expect(res.statusCode).toBe(401);
      expect(received).toHaveLength(0);
    });

    it('firma de otro cuerpo → 401', async () => {
      const res = await postWebhook(app, webhookPayload({ messages: [textMessage('hola')] }), {
        signature: sign('{}'),
      });
      expect(res.statusCode).toBe(401);
    });

    it('payload inválido → 400 y webhook_rejected{payload}', async () => {
      const res = await postWebhook(app, { object: 'page', entry: [] });
      expect(res.statusCode).toBe(400);
      expect(log.named('webhook_rejected')).toEqual([
        { event: 'webhook_rejected', reason: 'payload' },
      ]);
    });

    it('JSON mal formado con firma válida → 400', async () => {
      const res = await postWebhook(app, null, { raw: '{"object":' });
      expect(res.statusCode).toBe(400);
    });

    it('otro phone_number_id → 200 e ignorado', async () => {
      const res = await postWebhook(
        app,
        webhookPayload({ phoneNumberId: '999', messages: [textMessage('hola')] }),
      );
      expect(res.statusCode).toBe(200);
      expect(received).toHaveLength(0);
    });

    it('solo estados → 200; un failed se registra como send_failed', async () => {
      const res = await postWebhook(
        app,
        webhookPayload({ statuses: [statusUpdate('delivered'), statusUpdate('failed')] }),
      );
      expect(res.statusCode).toBe(200);
      expect(received).toHaveLength(0);
      expect(log.named('send_failed')).toHaveLength(1);
    });

    it('grupo → 200, ignorado y message_discarded{group}', async () => {
      const res = await postWebhook(
        app,
        webhookPayload({ messages: [textMessage('hola', { groupId: 'g-1' })] }),
      );
      expect(res.statusCode).toBe(200);
      expect(received).toHaveLength(0);
      expect(log.named('message_discarded')).toEqual([
        { event: 'message_discarded', reason: 'group' },
      ]);
    });

    it('otros tipos llegan a onInbound como other', async () => {
      await postWebhook(app, webhookPayload({ messages: [imageMessage({ caption: 'pie' })] }));
      expect(received[0]?.[0]).toMatchObject({ kind: 'other', otherType: 'image', caption: 'pie' });
    });

    it('si onInbound falla → 503', async () => {
      failIntake = true;
      const res = await postWebhook(app, webhookPayload({ messages: [textMessage('hola')] }));
      expect(res.statusCode).toBe(503);
    });

    it('cuerpo de más de 512 KB → 413', async () => {
      const res = await postWebhook(
        app,
        webhookPayload({ messages: [textMessage('x'.repeat(600 * 1024))] }),
      );
      expect(res.statusCode).toBe(413);
    });
  });

  it('el resto de la app sigue rechazando JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ user: 'operador', password: 'x' }),
    });
    expect(res.statusCode).toBe(415);
  });
});

describe('webhook de WhatsApp: recepción real', () => {
  let t: TestDatabase;
  let bot: TestBot | undefined;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(async () => {
    await bot?.close();
    bot = undefined;
  });

  it('un mensaje nuevo queda guardado como pending antes del 200', async () => {
    bot = await createTestBot(t);
    expect(await bot.send('hola', { id: 'wamid.NEW' })).toBe(200);
    const rows = await bot.messages();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: 'inbound',
      status: 'pending',
      kind: 'text',
      body: 'hola',
      channelMessageId: 'wamid.NEW',
    });
    expect(bot.log.named('message_received')).toEqual([
      expect.objectContaining({ event: 'message_received', kind: 'text' }),
    ]);
  });

  it('un duplicado responde 200 sin segunda fila', async () => {
    bot = await createTestBot(t);
    await bot.send('hola', { id: 'wamid.SAME' });
    expect(await bot.send('hola', { id: 'wamid.SAME' })).toBe(200);
    expect(await bot.messages()).toHaveLength(1);
  });

  it('negocio en preparación → 200, nada guardado y message_discarded{not_active} (FR-002)', async () => {
    bot = await createTestBot(t, { activate: false });
    expect(await bot.send('hola')).toBe(200);
    expect(await bot.messages()).toHaveLength(0);
    expect(bot.log.named('message_discarded')).toEqual([
      expect.objectContaining({ event: 'message_discarded', reason: 'not_active' }),
    ]);
  });

  it('si no se puede leer la información del negocio → 503 y nada guardado', async () => {
    bot = await createTestBot(t, {
      reader: {
        getSnapshot: async () => {
          throw new TypeError('BD caída');
        },
      },
    });
    expect(await bot.send('hola')).toBe(503);
    expect(await bot.messages()).toHaveLength(0);
    expect(bot.log.named('knowledge_read_failed')).toEqual([
      { event: 'knowledge_read_failed', errorClass: 'TypeError', stage: 'intake' },
    ]);
  });
});
