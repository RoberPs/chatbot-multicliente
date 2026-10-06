/**
 * US1 (005): el cliente pide hablar con una persona y el negocio recibe el aviso, en WhatsApp y
 * en el chat web, con vías falsas (contracts/handoff-flow.md, filas 3 y 5 y § Inicio).
 */
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { conversation, handoff, handoffNotice, message } from '../../../src/db/schema.js';
import {
  createTestBot,
  GREETING,
  WEB_USER,
  type TestBot,
  type TestBotOptions,
} from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';
import { CUSTOMER_E164, postWebhook, textMessage, webhookPayload } from '../../helpers/whatsapp.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const WEB_ON = { enabled: true, allowedOrigins: ['https://negocio.example'] };
const OK_WA =
  'He avisado a Peluquería Tijeras. Te contactarán en el +34 600 11 12 22 lo antes posible.';
const CONTACT = 'Para hablar con una persona de Peluquería Tijeras:';

describe('US1: petición de persona', () => {
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

  const start = async (opts: TestBotOptions = {}) =>
    (bot = await createTestBot(t, { handoffAlerts: ALERTS, ...opts }));

  const outbound = () =>
    t.db
      .select({ body: message.body, replyTrace: message.replyTrace })
      .from(message)
      .where(eq(message.direction, 'outbound'))
      .orderBy(asc(message.sentAt));
  const handoffs = () => t.db.select().from(handoff);
  const noticesRows = () => t.db.select().from(handoffNotice);
  const conversations = () => t.db.select().from(conversation);

  it('WhatsApp con perfil: sin pedir datos, un aviso por vía y R-HANDOFF-OK (US1-1)', async () => {
    const b = await start();
    b.model.queue(
      reply('El precio del tinte depende del largo.'),
      reply('De acuerdo.', { handoffRequested: true }),
    );
    b.summarizer.queue({ summary: 'Pregunta cuánto cuesta el tinte y quiere hablar con alguien.' });
    await b.send('¿Cuánto cuesta el tinte?');
    await b.settle();
    await b.send('Quiero hablar con una persona');
    await b.settle();

    expect(b.sender.sent.at(-1)?.body).toBe(OK_WA);
    const [row] = await handoffs();
    expect(row).toMatchObject({ status: 'active', kind: 'person', summarySource: 'model' });
    expect(row?.summary).toContain('tinte');
    expect(row?.reminderDueAt).not.toBeNull();
    const notices = await noticesRows();
    expect(notices.map((n) => [n.route, n.type, n.status]).sort()).toEqual([
      ['email', 'alert', 'sent'],
      ['whatsapp', 'alert', 'sent'],
    ]);
    // Aviso con nombre de perfil, número del cliente y el motivo resumido.
    for (const route of [b.alertRoutes.whatsapp, b.alertRoutes.email]) {
      expect(route.received).toHaveLength(1);
      expect(route.received[0]).toMatchObject({
        type: 'alert',
        handoff: {
          customerName: 'Cliente',
          customerPhone: CUSTOMER_E164,
          channel: 'whatsapp',
          kind: 'person',
        },
      });
    }
    // El resumidor solo ve textos del cliente, incluida la consulta previa.
    expect(b.summarizer.calls[0]?.customerTexts).toEqual([
      '¿Cuánto cuesta el tinte?',
      'Quiero hablar con una persona',
    ]);
    const [conv] = await conversations();
    expect(conv).toMatchObject({
      handoffStep: null,
      contactName: 'Cliente',
      contactPhone: CUSTOMER_E164,
    });
    expect((await outbound()).at(-1)?.replyTrace).toMatchObject({
      template: 'R-HANDOFF-OK',
      contact: { added: false, reason: null },
      handoff: { action: 'started', kind: 'person', routes: { whatsapp: 'sent', email: 'sent' } },
    });
    expect(b.log.named('handoff_started')).toHaveLength(1);
    expect(b.log.named('reply_sent').at(-1)).toMatchObject({ handoffAction: 'started' });
  });

  it('WhatsApp sin perfil: pide solo el nombre y después deriva', async () => {
    const b = await start();
    b.model.queue(
      reply('De acuerdo.', { handoffRequested: true }),
      reply('Gracias.', { contactName: 'Lucía' }),
    );
    await postWebhook(
      b.app,
      webhookPayload({
        messages: [textMessage('Quiero hablar con una persona', { timestamp: b.clock.now() })],
        profileName: null,
      }),
    );
    await b.settle();
    expect(b.sender.sent.at(-1)?.body).toBe(
      `${GREETING}\n\nPara pasarle tu consulta a Peluquería Tijeras, ¿me dices tu nombre?`,
    );
    expect((await conversations())[0]?.handoffStep).toMatchObject({
      step: 'collecting',
      missing: ['name'],
    });
    expect(b.alertRoutes.whatsapp.received).toEqual([]);

    await postWebhook(
      b.app,
      webhookPayload({
        messages: [textMessage('Me llamo Lucía', { timestamp: b.clock.now() })],
        profileName: null,
      }),
    );
    await b.settle();
    expect(b.sender.sent.at(-1)?.body).toBe(OK_WA);
    expect(b.alertRoutes.whatsapp.received[0]?.handoff.customerName).toBe('Lucía');
    expect(b.model.calls[1]?.context.handoffStep).toMatchObject({ step: 'collecting' });
  });

  it('web: pide nombre y teléfono en una pregunta; teléfono no válido una vez; después deriva', async () => {
    const b = await start({ webChat: WEB_ON });
    b.model.queue(
      reply('De acuerdo.', { handoffRequested: true }),
      reply('Gracias.', { contactName: 'Lucía', contactPhone: '612' }),
      reply('Gracias.', { contactPhone: '612 345 678' }),
    );
    await b.sendVia('web', 'Quiero hablar con alguien');
    await b.settle();
    expect((await outbound()).at(-1)?.body).toBe(
      `${GREETING}\n\nPara que Peluquería Tijeras pueda contactarte, ¿me dices tu nombre y un teléfono?`,
    );

    await b.sendVia('web', 'Lucía, 612');
    await b.settle();
    expect((await outbound()).at(-1)?.body).toBe(
      'Ese teléfono no parece válido. ¿Me lo escribes de nuevo, con el prefijo internacional si no es un número nacional?',
    );
    expect((await conversations())[0]).toMatchObject({
      contactName: 'Lucía',
      contactPhone: null,
      handoffStep: { step: 'collecting', missing: ['phone'], phoneRetried: true },
    });

    await b.sendVia('web', '612 345 678');
    await b.settle();
    const last = await outbound();
    expect(last.at(-1)?.body).toBe(
      'He avisado a Peluquería Tijeras. Te contactarán en el +34 612 34 56 78 lo antes posible.',
    );
    expect(
      last.map((m) => (m.replyTrace as { handoff?: { action: string } }).handoff?.action),
    ).toEqual(['asked', 'asked_again', 'started']);
    expect((await conversations())[0]).toMatchObject({
      contactName: 'Lucía',
      contactPhone: '+34612345678',
      handoffStep: null,
    });
    expect(b.alertRoutes.email.received[0]?.handoff).toMatchObject({
      customerName: 'Lucía',
      customerPhone: '+34612345678',
      channel: 'web',
    });
    expect(b.log.named('handoff_contact_requested')).toEqual([
      expect.objectContaining({ missing: ['name', 'phone'], retry: false }),
      expect.objectContaining({ missing: ['phone'], retry: true }),
    ]);
  });

  it('web: el cliente no quiere dar sus datos → CONTACTO (contact_refused) sin aviso (US1-4)', async () => {
    const b = await start({ webChat: WEB_ON });
    b.model.queue(
      reply('De acuerdo.', { handoffRequested: true }),
      reply('Entendido.', { refusesContact: true }),
    );
    await b.sendVia('web', 'Quiero hablar con una persona');
    await b.settle();
    await b.sendVia('web', 'Prefiero no dar mis datos');
    await b.settle();

    const last = (await outbound()).at(-1);
    expect(last?.body).toContain('Entendido.');
    expect(last?.body).toContain(CONTACT);
    expect(last?.replyTrace).toMatchObject({
      contact: { added: true, reason: 'contact_refused' },
      handoff: { action: 'not_started' },
    });
    expect(await handoffs()).toEqual([]);
    expect(b.alertRoutes.email.received).toEqual([]);
    expect((await conversations())[0]?.handoffStep).toBeNull();
    expect(b.log.named('handoff_not_started')).toEqual([
      expect.objectContaining({ reason: 'contact_refused' }),
    ]);
  });

  it('petición en mitad de otra gestión: el detector basta y el resumen la recoge (Principio V)', async () => {
    const b = await start();
    b.model.queue(reply('No puedo reservar citas por aquí.', { bookingRequested: true }));
    await b.send('¿Me reservas para el sábado? Mejor pásame con alguien');
    await b.settle();

    expect(b.sender.sent.at(-1)?.body).toBe(`${GREETING}\n\n${OK_WA}`);
    expect(b.summarizer.calls[0]?.customerTexts).toEqual([
      '¿Me reservas para el sábado? Mejor pásame con alguien',
    ]);
    expect(await handoffs()).toHaveLength(1);
  });

  it('varios mensajes seguidos → un solo aviso por vía', async () => {
    const b = await start();
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Hola');
    b.clock.advance(1000);
    await b.send('Quiero hablar con una persona');
    b.clock.advance(1000);
    await b.send('Es por una cita');
    await b.settle();

    expect(b.model.calls).toHaveLength(1);
    expect(b.alertRoutes.whatsapp.received).toHaveLength(1);
    expect(b.alertRoutes.email.received).toHaveLength(1);
    expect(await noticesRows()).toHaveLength(2);
  });

  it('con el límite por cliente superado → R-LIMIT con CONTACTO, sin derivación (Principio V)', async () => {
    const b = await start();
    // 30 mensajes en la ventana: el siguiente supera el límite (FR-004a).
    for (let i = 0; i < 30; i++) {
      await b.send(`mensaje ${i + 1}`);
      b.clock.advance(1000);
    }
    await b.settle();
    await b.send('Quiero hablar con una persona');
    await b.settle();

    const limit = b.sender.sent.at(-1)?.body ?? '';
    expect(limit).toContain('Has enviado muchos mensajes seguidos');
    expect(limit).toContain(CONTACT);
    expect(await handoffs()).toEqual([]);
    expect(b.alertRoutes.whatsapp.received).toEqual([]);
  });

  it('web con el tope diario alcanzado → no se guarda ni se deriva', async () => {
    const b = await start({ webChat: { ...WEB_ON, dailyCap: 1, monthlyCap: 100 } });
    b.model.queue(reply('Abrimos a las diez.'));
    await b.sendVia('web', '¿A qué hora abrís?');
    await b.settle();
    const outcome = await b.sendVia('web', 'Quiero hablar con una persona', { user: WEB_USER });
    await b.settle();

    expect(outcome).toEqual({ status: 'discarded', reason: 'quota' });
    expect(await handoffs()).toEqual([]);
    expect(b.alertRoutes.email.received).toEqual([]);
  });
});
