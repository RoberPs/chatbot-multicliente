/**
 * «Como mucho una vez» (012, US5, R10.4; contracts/outbound-and-retries.md): un fallo a mitad de
 * iniciar la derivación no repite avisos al negocio ni respuestas al cliente en el reintento.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { conversation, handoff, message } from '../../../src/db/schema.js';
import * as handoffs from '../../../src/handoff/repositories/handoff.js';
import type { StartResult } from '../../../src/handoff/service.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { FakeAlertRoute, reply } from '../../helpers/fakes.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const OK = 'He avisado a Peluquería Tijeras.';
const FAIL = 'No he podido avisar a Peluquería Tijeras ahora mismo.';
const CONTACT = 'Para hablar con una persona de Peluquería Tijeras:';

describe('como mucho una vez', () => {
  let t: TestDatabase;
  let bot: TestBot | null = null;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(async () => {
    await bot?.close();
    bot = null;
  });

  const alerts = (b: TestBot) =>
    [...b.alertRoutes.whatsapp.received, ...b.alertRoutes.email.received].filter(
      (n) => n.type === 'alert',
    ).length;

  it('fallo tras avisar al negocio y antes de confirmar → el reintento envía solo la confirmación', async () => {
    const b = (bot = await createTestBot(t, { handoffAlerts: ALERTS }));
    // La transacción del saliente de confirmación falla una vez.
    const start = b.handoff.start.bind(b.handoff);
    let failOnce = true;
    b.handoff.start = async (input): Promise<StartResult> => {
      const result = await start(input);
      if (!result.started || !failOnce) return result;
      failOnce = false;
      return {
        ...result,
        persist: () => Promise.reject(new Error('BD caída')),
      };
    };
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();

    const [row] = await t.db.select().from(handoff);
    expect(row?.alertsSentAt).not.toBeNull();
    expect(row?.customerNotifiedAt).toBeNull();
    expect(b.sender.sent).toEqual([]);
    expect(alerts(b)).toBe(2);

    await b.settle(5000);
    expect(alerts(b)).toBe(2);
    expect(b.model.calls).toHaveLength(1);
    expect(b.sender.sent).toHaveLength(1);
    expect(b.sender.sent[0]?.body).toContain(OK);
    const [after] = await t.db.select().from(handoff);
    expect(after?.customerNotifiedAt).not.toBeNull();
    expect(after?.status).toBe('active');
  });

  it('derivación sin constancia de la alerta → fin interrupted y R-HANDOFF-FAIL con contacto', async () => {
    const b = (bot = await createTestBot(t, { handoffAlerts: ALERTS }));
    // Primer mensaje: crea la conversación.
    b.model.queue(reply('Hola.'));
    await b.send('Hola');
    await b.settle();
    const [conv] = await t.db.select().from(conversation);
    if (!conv) throw new Error('sin conversación');
    // Un fallo dejó la derivación guardada sin saber si salió la alerta.
    await handoffs.insertActive(t.db, {
      id: randomUUID(),
      conversationId: conv.id,
      kind: 'person',
      summary: 'Quiere hablar con alguien.',
      summarySource: 'fallback',
      tokenHash: randomBytes(32),
      tokenEnc: randomBytes(48),
      startedAt: b.clock.now(),
      reminderDueAt: null,
      alertsSentAt: null,
      customerNotifiedAt: null,
      lastNoticeAt: b.clock.now(),
    });
    await b.send('Quiero hablar con una persona');
    await b.settle();

    const [row] = await t.db.select().from(handoff);
    expect(row).toMatchObject({ status: 'ended', endCause: 'interrupted' });
    expect(b.log.named('handoff_ended')).toEqual([
      expect.objectContaining({ cause: 'interrupted', heldMessages: 0 }),
    ]);
    const last = b.sender.sent.at(-1)?.body ?? '';
    expect(last).toContain(FAIL);
    expect(last).toContain(CONTACT);
    expect(alerts(b)).toBe(0);
    const inbound = await t.db.select().from(message).where(eq(message.direction, 'inbound'));
    expect(inbound.map((m) => m.status)).toEqual(['answered', 'answered']);
  });

  it('ninguna vía entrega → la derivación guardada se borra', async () => {
    const b = (bot = await createTestBot(t, {
      handoffAlerts: ALERTS,
      alertRoutes: {
        whatsapp: new FakeAlertRoute('whatsapp', { fail: 'http_5xx' }),
        email: new FakeAlertRoute('email', { fail: 'network' }),
      },
    }));
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();
    expect(await t.db.select().from(handoff)).toEqual([]);
    expect(b.sender.sent.at(-1)?.body).toContain(FAIL);
  });

  it('un reenvío ya marcado no se repite aunque el lote se reintente', async () => {
    const b = (bot = await createTestBot(t, {
      handoffAlerts: ALERTS,
      alertRoutes: {
        whatsapp: new FakeAlertRoute('whatsapp').queue({ ok: true }).always({ fail: 'http_5xx' }),
      },
    }));
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();
    await t.db.update(handoff).set({ lastNoticeAt: new Date(0) });
    await b.send('¿Me llamáis?');
    await b.settle();
    await b.settle(10 * 60 * 1000);
    const forwards = b.alertRoutes.whatsapp.received.filter((n) => n.type === 'forward');
    expect(forwards).toHaveLength(1);
  });
});
