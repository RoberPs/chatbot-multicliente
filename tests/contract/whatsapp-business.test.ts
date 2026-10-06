/**
 * Lo que el negocio escribe al número del bot (005, R10, contracts/business-alerts.md): botones
 * «Le atiendo» y «Terminado» (webhook firmado), la ayuda al WhatsApp de avisos (FR-008b) y
 * tokens desconocidos o de derivaciones terminadas.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { conversation, customer, handoff, message } from '../../src/db/schema.js';
import { createTestBot, type TestBot } from '../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { reply } from '../helpers/fakes.js';
import { buttonMessage, postWebhook, textMessage, webhookPayload } from '../helpers/whatsapp.js';

const BUSINESS_WA = '34611000111';
const ALERTS = { whatsapp: `+${BUSINESS_WA}`, email: 'avisos@negocio.es' };
const SECOND_CUSTOMER = '34600333444';
const MINUTE = 60_000;

describe('webhook: botones y mensajes del negocio', () => {
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

  /** Bot con una derivación activa del cliente por defecto; devuelve su token. */
  async function derived(): Promise<{ b: TestBot; token: string }> {
    const b = (bot = await createTestBot(t, { handoffAlerts: ALERTS }));
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();
    const token = b.alertRoutes.whatsapp.received[0]?.handoff.token;
    if (!token) throw new Error('Sin aviso de derivación');
    return { b, token };
  }

  const press = (b: TestBot, payload: string, from = BUSINESS_WA) =>
    postWebhook(
      b.app,
      webhookPayload({ messages: [buttonMessage(payload, { from, timestamp: b.clock.now() })] }),
    );
  const lastTo = (b: TestBot, to: string) =>
    b.sender.sent.filter((m) => m.to === `+${to}`).at(-1)?.body;
  const rows = () => t.db.select().from(handoff);

  it('«Le atiendo» confirma y acusa; «Terminado» termina y acusa', async () => {
    const { b, token } = await derived();
    expect((await press(b, `h1:attend:${token}`)).statusCode).toBe(200);
    expect(lastTo(b, BUSINESS_WA)).toBe(
      'Anotado: atiendes a Cliente. Pulsa «Terminado» cuando acabes.',
    );
    expect((await rows())[0]).toMatchObject({ status: 'active', confirmedVia: 'whatsapp' });
    expect(b.log.named('handoff_confirmed')).toEqual([
      expect.objectContaining({ via: 'whatsapp' }),
    ]);

    await press(b, `h1:end:${token}`);
    expect(lastTo(b, BUSINESS_WA)).toBe(
      'Anotado: derivación de Cliente terminada. El asistente vuelve a atenderle.',
    );
    expect((await rows())[0]).toMatchObject({ status: 'ended', endCause: 'business' });
    // Los eventos del negocio no llevan seudónimo de remitente.
    const ended = b.log.named('handoff_ended')[0] as Record<string, unknown>;
    expect(ended).toMatchObject({ cause: 'business', confirmed: true });
    expect(ended.customer).toBeUndefined();
    expect(ended.via).toBeUndefined();
  });

  it('con dos derivaciones activas, el botón solo cambia la suya (SC-010)', async () => {
    const { b, token } = await derived();
    // El segundo cliente no trae nombre de perfil: se le pide y después se deriva.
    b.model.queue(
      reply('De acuerdo.', { handoffRequested: true }),
      reply('Gracias.', { contactName: 'Marta' }),
    );
    await b.send('Quiero hablar con alguien', { from: SECOND_CUSTOMER });
    await b.settle();
    await b.send('Soy Marta', { from: SECOND_CUSTOMER });
    await b.settle();
    expect(await rows()).toHaveLength(2);

    await press(b, `h1:end:${token}`);
    const after = await t.db
      .select({ status: handoff.status, user: customer.channelUserId })
      .from(handoff)
      .innerJoin(conversation, eq(conversation.id, handoff.conversationId))
      .innerJoin(customer, eq(customer.id, conversation.customerId));
    expect(after.find((r) => r.user === `+${SECOND_CUSTOMER}`)?.status).toBe('active');
    expect(after.filter((r) => r.status === 'ended')).toHaveLength(1);
  });

  it('un botón válido desde otro número también se acepta', async () => {
    const { b, token } = await derived();
    await press(b, `h1:attend:${token}`, '34699888777');
    expect((await rows())[0]?.confirmedVia).toBe('whatsapp');
    expect(lastTo(b, '34699888777')).toContain('Anotado: atiendes a Cliente.');
  });

  it('texto del WhatsApp de avisos → ayuda una vez cada 15 min, sin cliente ni mensajes (FR-008b)', async () => {
    const { b } = await derived();
    const before = {
      customers: (await t.db.select().from(customer)).length,
      conversations: (await t.db.select().from(conversation)).length,
      messages: (await t.db.select().from(message)).length,
    };
    const write = (text: string) =>
      postWebhook(
        b.app,
        webhookPayload({
          messages: [textMessage(text, { from: BUSINESS_WA, timestamp: b.clock.now() })],
        }),
      );

    await write('Ya le he llamado');
    await write('¿Me oyes?');
    b.clock.advance(15 * MINUTE);
    await write('Hola otra vez');
    await b.settle();

    const helps = b.sender.sent.filter((m) => m.to === `+${BUSINESS_WA}`);
    expect(helps).toHaveLength(2);
    expect(helps[0]?.body).toContain('Este número es el del asistente automático');
    expect({
      customers: (await t.db.select().from(customer)).length,
      conversations: (await t.db.select().from(conversation)).length,
      messages: (await t.db.select().from(message)).length,
    }).toEqual(before);
    expect((await rows())[0]?.status).toBe('active');
    expect(b.log.named('handoff_business_message').map((e) => e.helpSent)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('token desconocido o derivación terminada → acuse sin cambios y handoff_action_ignored', async () => {
    const { b, token } = await derived();
    await press(b, 'h1:attend:ZZZZZZZZZZZZZZZZZZZZZZ');
    expect(lastTo(b, BUSINESS_WA)).toBe('No reconozco ese botón; no se ha cambiado nada.');
    expect((await rows())[0]?.confirmedAt).toBeNull();

    await press(b, `h1:end:${token}`);
    await press(b, `h1:attend:${token}`);
    expect(lastTo(b, BUSINESS_WA)).toBe(
      'Esa derivación ya había terminado y la conversación ha vuelto al asistente; no se ha ' +
        'cambiado nada. Si aún no has contactado con Cliente, su teléfono es +34 600 11 12 22.',
    );
    expect(b.log.named('handoff_action_ignored').map((e) => e.reason)).toEqual([
      'invalid',
      'already_ended',
    ]);
  });
});
