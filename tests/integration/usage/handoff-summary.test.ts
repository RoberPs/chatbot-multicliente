/**
 * Consumo del resumen de una derivación (010 US1-4, contracts/usage-recording.md): un registro
 * `handoff_summary` en el canal de la conversación, también si el resumen se descarta tras
 * informar tokens (el aviso lleva entonces el extracto literal).
 */
import { asc } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handoff, modelUsage } from '../../../src/db/schema.js';
import { createTestBot, TEST_LLM_MODEL, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply, tokens } from '../../helpers/fakes.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const REQUEST = 'Quiero hablar con una persona sobre la cita que tengo el sábado por la mañana';

describe('consumo del resumen de derivación', () => {
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

  const summaries = () =>
    t.db
      .select()
      .from(modelUsage)
      .orderBy(asc(modelUsage.at))
      .then((rows) => rows.filter((r) => r.purpose === 'handoff_summary'));

  it('WhatsApp: un registro handoff_summary con los tokens del resumidor', async () => {
    const b = (bot = await createTestBot(t, { handoffAlerts: ALERTS }));
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    b.summarizer.queue({
      summary: 'Quiere hablar con alguien sobre su cita del sábado.',
      usage: tokens(400, 60),
    });
    await b.send(REQUEST);
    await b.settle();

    const [row] = await t.db.select().from(handoff);
    expect(row).toMatchObject({ status: 'active', summarySource: 'model' });
    const rows = await summaries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'whatsapp',
      model: TEST_LLM_MODEL,
      calls: 1,
      inputTokens: 400,
      outputTokens: 60,
    });
  });

  it('playground: el resumen se registra en el canal playground', async () => {
    const b = (bot = await createTestBot(t, { activate: false }));
    b.model.queue(
      reply('De acuerdo.', { handoffRequested: true }),
      reply('Gracias.', { contactName: 'Operador', contactPhone: '+34 612 345 678' }),
    );
    b.summarizer.queue({
      summary: 'Quiere hablar con una persona para una prueba.',
      usage: tokens(300, 40),
    });
    await b.sendVia('playground', 'Quiero hablar con una persona');
    await b.settle();
    await b.sendVia('playground', 'Operador, +34 612 345 678');
    await b.settle();

    const rows = await summaries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'playground', inputTokens: 300, outputTokens: 40 });
  });

  it('resumen fallido tras informar tokens: se registran y el aviso lleva el extracto literal', async () => {
    const b = (bot = await createTestBot(t, { handoffAlerts: ALERTS }));
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    b.summarizer.queue({ fail: true, usage: tokens(400, 900) });
    await b.send(REQUEST);
    await b.settle();

    const [row] = await t.db.select().from(handoff);
    expect(row).toMatchObject({ summarySource: 'fallback', summary: REQUEST });
    expect(b.log.named('handoff_summary_fallback')).toEqual([
      expect.objectContaining({ reason: 'model_error' }),
    ]);
    const rows = await summaries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'whatsapp', inputTokens: 400, outputTokens: 900 });
  });

  it('un resumen sin tokens (sin respuesta del proveedor) no registra nada', async () => {
    const b = (bot = await createTestBot(t, { handoffAlerts: ALERTS }));
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    b.summarizer.queue({ fail: true });
    await b.send(REQUEST);
    await b.settle();
    expect(await summaries()).toEqual([]);
  });
});
