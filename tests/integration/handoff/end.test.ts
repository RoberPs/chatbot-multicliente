/**
 * US4 (005, FR-016 – FR-019, R14): la derivación termina por el botón, por el enlace, desde el
 * panel, desde "Probar el bot" o por 24 h sin mensajes del cliente; nunca con un mensaje al
 * cliente, y el bot retoma la conversación sin saludar ni volver a derivar sin petición.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handoff, handoffNotice } from '../../../src/db/schema.js';
import { cookieHeader, csrfFrom, get, login, postForm } from '../../helpers/app.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';
import { getWebMessages, postWebMessage, webToken } from '../../helpers/web.js';
import { buttonMessage, postWebhook, webhookPayload } from '../../helpers/whatsapp.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const WEB_ON = { enabled: true, allowedOrigins: ['https://negocio.example'] };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('US4: la conversación vuelve al bot', () => {
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

  async function derived(): Promise<{ b: TestBot; token: string; id: string }> {
    const b = (bot = await createTestBot(t, { handoffAlerts: ALERTS }));
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();
    const [row] = await t.db.select().from(handoff);
    const token = b.alertRoutes.whatsapp.received[0]?.handoff.token;
    if (!row || !token) throw new Error('Sin derivación');
    return { b, token, id: row.id };
  }

  const status = async () => (await t.db.select().from(handoff))[0];

  /** Tras el fin: ningún mensaje al cliente y el siguiente lo contesta el bot, sin saludo. */
  async function backToBot(b: TestBot, sentBefore: number) {
    expect(b.sender.sent).toHaveLength(sentBefore);
    b.model.queue(reply('Abrimos de martes a sábado.'));
    await b.send('¿Qué horario tenéis?');
    await b.settle();
    expect(b.sender.sent.at(-1)?.body).toBe('Abrimos de martes a sábado.');
    expect(b.model.calls.at(-1)?.context).toMatchObject({
      handoffEnded: true,
      greetingPrepended: false,
    });
    // Sin petición ni aceptación no se inicia otra derivación.
    expect(await t.db.select().from(handoff)).toHaveLength(1);
  }

  it('por el botón «Terminado» de WhatsApp', async () => {
    const { b, token } = await derived();
    await postWebhook(
      b.app,
      webhookPayload({
        messages: [buttonMessage(`h1:end:${token}`, { from: '34611000111', timestamp: b.clock.now() })],
      }),
    );
    expect(await status()).toMatchObject({ status: 'ended', endCause: 'business' });
    // El único envío nuevo es el acuse al negocio, no al cliente.
    expect(b.sender.sent.at(-1)?.to).toBe('+34611000111');
    await backToBot(b, b.sender.sent.length);
  });

  it('por el enlace del email (POST)', async () => {
    const { b, token } = await derived();
    const sent = b.sender.sent.length;
    const res = await b.app.inject({ method: 'POST', url: `/handoff/${token}/end` });
    expect(res.statusCode).toBe(200);
    expect(await status()).toMatchObject({ status: 'ended', confirmedVia: 'email' });
    await backToBot(b, sent);
  });

  it('desde el panel y desde "Probar el bot"', async () => {
    const { b, id } = await derived();
    const sent = b.sender.sent.length;
    const session = await login(b.app);
    expect((await postForm(b.app, session, `/admin/handoffs/${id}/end`)).statusCode).toBe(303);
    expect(await status()).toMatchObject({ status: 'ended', endCause: 'operator' });
    await backToBot(b, sent);

    // Playground: la conversación de prueba del operador.
    b.model.queue(
      reply('De acuerdo.', { handoffRequested: true }),
      reply('Gracias.', { contactName: 'Operador', contactPhone: '612 345 678' }),
    );
    const page = await get(b.app, session, '/admin/playground');
    // La sesión guarda el id de la conversación de prueba: se usa la cookie que devuelve.
    const pg = { cookie: cookieHeader(page) ?? session.cookie, csrf: csrfFrom(page.body) };
    await postForm(b.app, pg, '/admin/playground/messages', { text: 'Quiero hablar con alguien' });
    await b.settle();
    await postForm(b.app, pg, '/admin/playground/messages', { text: 'Operador, 612 345 678' });
    await b.settle();
    const pgRow = (await t.db.select().from(handoff)).find((h) => h.status === 'active');
    expect(pgRow).toBeDefined();
    const end = await postForm(b.app, pg, '/admin/playground/handoff/end');
    expect(end.statusCode).toBe(303);
    const [ended] = await t.db.select().from(handoff).where(eq(handoff.id, pgRow?.id ?? ''));
    expect(ended).toMatchObject({ status: 'ended', endCause: 'playground' });
  });

  it('por inactividad: a 23 h 59 min sigue; a 24 h termina, sin mensaje al cliente y con recordatorio', async () => {
    const { b } = await derived();
    const sent = b.sender.sent.length;
    b.clock.advance(24 * HOUR - MINUTE);
    await b.handoff.sweep();
    expect((await status())?.status).toBe('active');

    b.clock.advance(MINUTE);
    await b.handoff.sweep();
    expect(await status()).toMatchObject({ status: 'ended', endCause: 'inactivity' });
    expect(b.sender.sent).toHaveLength(sent);
    // Sin confirmar: recordatorio al negocio por cada vía, una vez (FR-019).
    for (const route of [b.alertRoutes.whatsapp, b.alertRoutes.email]) {
      expect(route.received.map((n) => n.type)).toEqual(['alert', 'reminder']);
      expect(route.received[1]).toMatchObject({ trigger: 'inactivity' });
    }
    expect(b.log.named('handoff_reminder_sent')).toEqual([
      expect.objectContaining({ trigger: 'inactivity', customerNotified: false }),
    ]);
    const reminders = await t.db
      .select()
      .from(handoffNotice)
      .where(eq(handoffNotice.type, 'reminder'));
    expect(reminders).toHaveLength(2);
    await b.handoff.sweep();
    expect(b.alertRoutes.whatsapp.received).toHaveLength(2);
    expect(b.log.named('handoff_ended')).toEqual([
      expect.objectContaining({ cause: 'inactivity', confirmed: false }),
    ]);
  });

  it('por inactividad con el recordatorio ya enviado o confirmada: sin recordatorio', async () => {
    const { b, token } = await derived();
    await b.app.inject({ method: 'POST', url: `/handoff/${token}/attend` });
    b.clock.advance(24 * HOUR);
    await b.handoff.sweep();
    expect((await status())?.status).toBe('ended');
    expect(b.alertRoutes.whatsapp.received.map((n) => n.type)).toEqual(['alert']);
    expect(b.log.named('handoff_reminder_sent')).toEqual([]);
  });

  it('una nueva petición explícita crea otra derivación', async () => {
    const { b, id } = await derived();
    await b.handoff.endByOperator(id, 'operator');
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero volver a hablar con una persona');
    await b.settle();
    const rows = await t.db.select().from(handoff);
    expect(rows.map((r) => r.status).sort()).toEqual(['active', 'ended']);
  });

  it('en la web, al terminar, `handoff` pasa a null sin mensajes nuevos del bot', async () => {
    const b = (bot = await createTestBot(t, { handoffAlerts: ALERTS, webChat: WEB_ON }));
    const token = await webToken(b.app);
    b.model.queue(
      reply('De acuerdo.', { handoffRequested: true }),
      reply('Gracias.', { contactName: 'Lucía', contactPhone: '612 345 678' }),
    );
    await postWebMessage(b.app, token, 'Quiero hablar con una persona');
    await b.settle();
    await postWebMessage(b.app, token, 'Lucía, 612 345 678');
    await b.settle();
    const during = await getWebMessages(b.app, token);
    expect(during.body.handoff).toMatchObject({ active: true });

    const [row] = await t.db.select().from(handoff);
    await b.handoff.endByOperator(row?.id ?? '', 'operator');
    const after = await getWebMessages(b.app, token);
    expect(after.body.handoff).toBeNull();
    expect(after.body.messages).toEqual(during.body.messages);
  });
});
