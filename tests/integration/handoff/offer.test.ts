/**
 * US2 (005, FR-002): ante una consulta sin dato o una gestión que no se hace por este medio, el
 * bot ofrece la derivación (OFERTA, sin CONTACTO) si hay vías; si el cliente acepta, deriva con
 * tipo `unresolved`; si no, la oferta caduca (contracts/handoff-flow.md, filas 6 y 7).
 */
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { conversation, handoff, message } from '../../../src/db/schema.js';
import { createTestBot, GREETING, type TestBot, type TestBotOptions } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const WEB_ON = { enabled: true, allowedOrigins: ['https://negocio.example'] };
const NO_INFO = 'No dispongo de información sobre manicura.';
const OFFER = '¿Quieres que le pase tu consulta a Peluquería Tijeras para que te contacte?';
const CONTACT = 'Para hablar con una persona de Peluquería Tijeras:';

describe('US2: el bot ofrece la derivación y el cliente acepta o no', () => {
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
    (bot = await createTestBot(t, { handoffAlerts: ALERTS, webChat: WEB_ON, ...opts }));

  const outbound = () =>
    t.db
      .select({ body: message.body, replyTrace: message.replyTrace })
      .from(message)
      .where(eq(message.direction, 'outbound'))
      .orderBy(asc(message.sentAt));
  const step = async () => (await t.db.select().from(conversation))[0]?.handoffStep;
  const actions = async () =>
    (await outbound()).map(
      (m) => (m.replyTrace as { handoff?: { action: string } } | null)?.handoff?.action ?? null,
    );

  /** Primera pregunta sin dato en la web: cuerpo del modelo + OFERTA. */
  async function offered(b: TestBot) {
    b.model.queue(reply(NO_INFO, { offerContact: true }));
    await b.sendVia('web', '¿Hacéis manicura?');
    await b.settle();
  }

  it('consulta sin dato → cuerpo + OFERTA, sin CONTACTO, y handoff_offered', async () => {
    const b = await start();
    await offered(b);
    const [first] = await outbound();
    expect(first?.body).toBe(`${GREETING}\n\n${NO_INFO}\n\n${OFFER}`);
    expect(first?.body).not.toContain(CONTACT);
    expect(first?.replyTrace).toMatchObject({
      template: null,
      contact: { added: false, reason: null },
      handoff: { action: 'offered', kind: 'unresolved' },
    });
    expect(await step()).toMatchObject({ step: 'offered', kind: 'unresolved' });
    expect(b.log.named('handoff_offered')).toHaveLength(1);
    expect(b.alertRoutes.email.received).toEqual([]);
  });

  it('"sí" → pide los datos y deriva unresolved; el motivo recoge la pregunta (US2-1, US2-2)', async () => {
    const b = await start();
    await offered(b);
    b.model.queue(
      reply('De acuerdo.', { acceptsHandoff: true }),
      reply('Gracias.', { contactName: 'Lucía', contactPhone: '612 345 678' }),
    );
    await b.sendVia('web', 'Sí, por favor');
    await b.settle();
    expect((await outbound()).at(-1)?.body).toBe(
      'Para que Peluquería Tijeras pueda contactarte, ¿me dices tu nombre y un teléfono?',
    );
    expect(await step()).toMatchObject({ step: 'collecting', kind: 'unresolved' });

    await b.sendVia('web', 'Lucía, 612 345 678');
    await b.settle();
    expect((await outbound()).at(-1)?.body).toBe(
      'He avisado a Peluquería Tijeras. Te contactarán en el +34 612 34 56 78 lo antes posible.',
    );
    expect(await actions()).toEqual(['offered', 'asked', 'started']);
    const [row] = await t.db.select().from(handoff);
    expect(row).toMatchObject({ status: 'active', kind: 'unresolved' });
    expect(b.summarizer.calls[0]).toMatchObject({ kind: 'unresolved' });
    expect(b.summarizer.calls[0]?.customerTexts).toContain('¿Hacéis manicura?');
    expect(b.alertRoutes.email.received[0]?.handoff).toMatchObject({ kind: 'unresolved' });
    // La indicación del turno final se dio al modelo mientras la oferta estaba abierta.
    expect(b.model.calls[1]?.context.handoffStep).toMatchObject({ step: 'offered' });
  });

  it('en WhatsApp con perfil, "sí" deriva sin pedir datos', async () => {
    const b = await start();
    b.model.queue(
      reply(NO_INFO, { offerContact: true }),
      reply('De acuerdo.', { acceptsHandoff: true }),
    );
    await b.send('¿Hacéis manicura?');
    await b.settle();
    // El nombre de perfil llega en el webhook real; aquí se da como ya conocido.
    await t.db.update(conversation).set({ contactName: 'Lucía' });
    await b.send('Sí');
    await b.settle();
    expect(b.sender.sent.at(-1)?.body).toBe(
      'He avisado a Peluquería Tijeras. Te contactarán en el +34 600 11 12 22 lo antes posible.',
    );
    expect((await t.db.select().from(handoff))[0]?.kind).toBe('unresolved');
  });

  it.each([
    ['"no, gracias"', 'No, gracias', reply('De acuerdo, aquí estoy si necesitas algo más.')],
    ['cambio de tema', '¿A qué hora abrís?', reply('Abrimos de martes a sábado.')],
  ])('%s → sin aviso y la oferta caduca (US2-3)', async (_name, text, answer) => {
    const b = await start();
    await offered(b);
    b.model.queue(answer);
    await b.sendVia('web', text);
    await b.settle();
    expect((await outbound()).at(-1)?.body).toBe(answer.body);
    expect(await step()).toBeNull();
    expect(await t.db.select().from(handoff)).toEqual([]);
    expect(b.alertRoutes.email.received).toEqual([]);
  });

  it('petición de reserva → también ofrece (US2-4)', async () => {
    const b = await start();
    b.model.queue(reply('No puedo gestionar citas por aquí.', { bookingRequested: true }));
    await b.sendVia('web', 'Quiero reservar un corte para el sábado');
    await b.settle();
    expect((await outbound()).at(-1)?.body).toBe(
      `${GREETING}\n\nNo puedo gestionar citas por aquí.\n\n${OFFER}`,
    );
    expect(await step()).toMatchObject({ step: 'offered' });
  });

  it('sin vías → CONTACTO como en la 002, sin oferta', async () => {
    const b = await start({ handoffAlerts: { whatsapp: null, email: null } });
    await offered(b);
    const [first] = await outbound();
    expect(first?.body).toContain(CONTACT);
    expect(first?.body).not.toContain(OFFER);
    expect(first?.replyTrace).toMatchObject({ contact: { reason: 'offer_contact' } });
    expect(await step()).toBeNull();
    expect(b.log.named('handoff_offered')).toEqual([]);
  });
});
