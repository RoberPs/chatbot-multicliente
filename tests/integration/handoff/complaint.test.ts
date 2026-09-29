/**
 * US6 (005, FR-003): una queja o reclamación se deriva sin pedir aceptación y sin el cuerpo del
 * modelo; sin vías (o sin entrega), disculpa + CONTACTO; un comentario negativo que no reclama
 * nada se atiende con normalidad (contracts/handoff-flow.md, filas 1 y 2).
 */
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { conversation, handoff, message } from '../../../src/db/schema.js';
import { createTestBot, GREETING, type TestBot, type TestBotOptions } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { FakeAlertRoute, reply } from '../../helpers/fakes.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const WEB_ON = { enabled: true, allowedOrigins: ['https://negocio.example'] };
/** Lo que un modelo desobediente podría contestar a una queja: nunca debe llegar al cliente. */
const EXCUSE = 'Lamentamos lo ocurrido; seguramente fue por la humedad, suele pasar.';
const COMPLAINT = 'Quiero poner una reclamación, el trabajo me lo hicieron mal';
const DERIVED =
  'Siento las molestias. He pasado tu reclamación a Peluquería Tijeras; te contactarán en el ' +
  '+34 600 11 12 22 lo antes posible.';
const APOLOGY =
  'Siento las molestias. Para tu reclamación, puedes contactar directamente con Peluquería Tijeras.';
const CONTACT = 'Para hablar con una persona de Peluquería Tijeras:';

describe('US6: las quejas se derivan siempre', () => {
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

  /** Queja por WhatsApp (el webhook de prueba trae el nombre de perfil). */
  async function complain(b: TestBot) {
    b.model.queue(reply(EXCUSE, { complaint: true }));
    b.summarizer.queue({ summary: 'Queja: el trabajo que le hicieron quedó mal.' });
    await b.send(COMPLAINT);
    await b.settle();
  }

  /** Conversación web ya saludada y con nombre y teléfono conocidos; después, la queja. */
  async function complainKnown(b: TestBot) {
    b.model.queue(reply('¡Hola! ¿En qué te ayudo?'), reply(EXCUSE, { complaint: true }));
    await b.sendVia('web', 'Hola');
    await b.settle();
    await t.db.update(conversation).set({ contactName: 'Lucía', contactPhone: '+34612345678' });
    await b.sendVia('web', COMPLAINT);
    await b.settle();
    return (await outbound()).at(-1);
  }

  it('con vías: sin pedir aceptación, R-HANDOFF-COMPLAINT, aviso "queja o reclamación" y sin el cuerpo del modelo', async () => {
    const b = await start();
    await complain(b);
    // WhatsApp da el teléfono y el nombre de perfil: se deriva en la primera respuesta.
    expect(b.sender.sent.map((m) => m.body)).toEqual([`${GREETING}\n\n${DERIVED}`]);
    const [row] = await t.db.select().from(handoff);
    expect(row).toMatchObject({ status: 'active', kind: 'complaint' });
    expect(row?.summary.startsWith('Queja:')).toBe(true);
    expect(b.summarizer.calls[0]).toMatchObject({ kind: 'complaint' });
    expect(b.alertRoutes.whatsapp.received[0]?.handoff).toMatchObject({ kind: 'complaint' });
    expect((await outbound()).at(-1)?.replyTrace).toMatchObject({
      template: 'R-HANDOFF-COMPLAINT',
      contact: { added: false, reason: null },
      handoff: { action: 'started', kind: 'complaint' },
    });
  });

  it('con los datos ya conocidos se deriva en la misma respuesta', async () => {
    const b = await start();
    const last = await complainKnown(b);
    expect(last?.body).toBe(
      'Siento las molestias. He pasado tu reclamación a Peluquería Tijeras; te contactarán en ' +
        'el +34 612 34 56 78 lo antes posible.',
    );
    expect(b.alertRoutes.email.received).toHaveLength(1);
  });

  it('sin vías: disculpa + CONTACTO, sin el cuerpo del modelo', async () => {
    const b = await start({ handoffAlerts: { whatsapp: null, email: null } });
    await complain(b);
    const body = b.sender.sent[0]?.body ?? '';
    expect(body.startsWith(`${GREETING}\n\n${APOLOGY}\n\n${CONTACT}`)).toBe(true);
    expect(body).not.toContain('humedad');
    expect((await outbound())[0]?.replyTrace).toMatchObject({
      template: 'R-HANDOFF-COMPLAINT',
      contact: { added: true, reason: 'handoff_unavailable' },
      handoff: { action: 'not_started', kind: 'complaint' },
    });
    expect(b.log.named('handoff_not_started')).toEqual([
      expect.objectContaining({ kind: 'complaint', reason: 'no_routes' }),
    ]);
    expect(await t.db.select().from(handoff)).toEqual([]);
  });

  it('con las vías caídas: disculpa + CONTACTO, sin derivación', async () => {
    const b = await start({
      alertRoutes: {
        whatsapp: new FakeAlertRoute('whatsapp').always({ fail: 'network' }),
        email: new FakeAlertRoute('email').always({ fail: 'smtp_5xx' }),
      },
    });
    const last = await complainKnown(b);
    expect((last?.body ?? '').startsWith(`${APOLOGY}\n\n${CONTACT}`)).toBe(true);
    expect(last?.body).not.toContain('humedad');
    expect(last?.replyTrace).toMatchObject({
      template: 'R-HANDOFF-COMPLAINT',
      contact: { added: true, reason: 'handoff_unavailable' },
      handoff: { action: 'not_started', kind: 'complaint' },
    });
    expect(await t.db.select().from(handoff)).toEqual([]);
  });

  it('comentario negativo sin queja (complaint = false) → respuesta normal', async () => {
    const b = await start();
    b.model.queue(reply('El corte cuesta 15,00 €.'));
    await b.send('Qué caro, ¿no?');
    await b.settle();
    expect(b.sender.sent.at(-1)?.body).toBe(`${GREETING}\n\nEl corte cuesta 15,00 €.`);
    expect(await t.db.select().from(handoff)).toEqual([]);
    expect(b.alertRoutes.whatsapp.received).toEqual([]);
  });
});
