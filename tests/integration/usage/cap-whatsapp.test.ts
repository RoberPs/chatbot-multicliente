/**
 * Tope de gasto alcanzado en WhatsApp (010 US3-2, US3-4, US3-5, US3-10, SC-004;
 * contracts/spend-cap-conversation.md): sin modelo, R-CAP con contacto, y la petición de persona
 * sigue derivando al negocio con el resumen literal.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  business,
  handoff,
  handoffChannel,
  message,
  modelPrice,
  modelUsage,
  usageSettings,
} from '../../../src/db/schema.js';
import {
  createTestBot,
  greeted,
  TEST_LLM_MODEL,
  type TestBot,
  type TestBotOptions,
} from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { tokens } from '../../helpers/fakes.js';
import { eq } from 'drizzle-orm';

const CENT = 10_000_000_000n;
const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const R_CAP =
  'Ahora mismo no puedo atenderte por este chat.\n\nPara hablar con una persona de Peluquería Tijeras:';
const REQUEST = 'Quiero hablar con una persona sobre la cita que tengo el sábado por la mañana';
const OK_WA =
  'He avisado a Peluquería Tijeras. Te contactarán en el +34 600 11 12 22 lo antes posible.';

describe('tope de gasto alcanzado en WhatsApp', () => {
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

  /** Bot con precio del modelo, tope de 10,00 y gasto del mes de 10,00: alcanzado. */
  async function start(opts: TestBotOptions = {}): Promise<TestBot> {
    const b = (bot = await createTestBot(t, opts));
    b.model.reportUsage(tokens(1000, 100));
    await t.db.insert(modelPrice).values({
      model: TEST_LLM_MODEL,
      inputMicrosPerMtok: 3_000_000n,
      outputMicrosPerMtok: 15_000_000n,
      cacheWriteMicrosPerMtok: 0n,
      cacheReadMicrosPerMtok: 0n,
    });
    await t.db.update(usageSettings).set({ capEnabled: true, monthlyCapCents: 1000 });
    await t.db.insert(modelUsage).values({
      at: b.clock.now(),
      day: '2026-09-24',
      channel: 'web',
      purpose: 'reply',
      model: TEST_LLM_MODEL,
      calls: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      costPico: 1000n * CENT,
      currency: 'USD',
    });
    return b;
  }
  const usageRows = () => t.db.select().from(modelUsage);
  const lastTrace = async () => {
    const rows = await t.db
      .select({ replyTrace: message.replyTrace })
      .from(message)
      .where(eq(message.direction, 'outbound'))
      .orderBy(message.sentAt);
    return rows.at(-1)?.replyTrace;
  };

  it('responde R-CAP con contacto, sin modelo ni consumo nuevo (SC-004)', async () => {
    const b = await start();
    await b.send('¿Abrís el sábado?');
    await b.settle();

    expect(b.model.calls).toHaveLength(0);
    expect(b.sender.sent).toHaveLength(1);
    expect(b.sender.sent[0]?.body.startsWith(R_CAP)).toBe(true);
    expect(b.sender.sent[0]?.body).not.toContain('¡Hola!');
    expect(await lastTrace()).toMatchObject({
      template: 'R-CAP',
      greeting: false,
      contact: { added: true, reason: 'template' },
      modelMs: null,
    });
    expect(b.log.named('reply_sent')).toEqual([expect.objectContaining({ template: 'R-CAP' })]);
    expect(await usageRows()).toHaveLength(1);
  });

  it('cada lote recibe R-CAP y el evento sale una sola vez en el mes (US3-10)', async () => {
    const b = await start();
    await b.send('Hola');
    await b.settle();
    await b.send('¿Seguís ahí?');
    await b.settle();
    await b.send('Otra pregunta', { from: '34611000999' });
    await b.settle();

    expect(b.model.calls).toHaveLength(0);
    expect(b.sender.sent).toHaveLength(3);
    for (const sent of b.sender.sent) expect(sent.body).toContain('Para hablar con una persona');
    expect(b.log.named('spend_cap_reached')).toEqual([
      expect.objectContaining({ event: 'spend_cap_reached', month: '2026-09', via: 'whatsapp' }),
    ]);
  });

  it('sin contacto del negocio, el de emergencia (FR-016)', async () => {
    const b = await start();
    await t.db.delete(handoffChannel);
    await t.db.update(business).set({ phone: null });
    await b.send('Hola');
    await b.settle();
    expect(b.sender.sent[0]?.body).toBe(
      'Ahora mismo no puedo atenderte por este chat.\n\n' +
        'Si necesitas hablar con una persona: teléfono +34 600 99 98 88.',
    );
  });

  it('petición de persona con vías: deriva con el resumen literal, sin resumidor (US3-4, US3-5)', async () => {
    const b = await start({ handoffAlerts: ALERTS });
    await b.send(REQUEST);
    await b.settle();

    expect(b.model.calls).toHaveLength(0);
    expect(b.summarizer.calls).toHaveLength(0);
    // Primer mensaje de la conversación: lleva el saludo, igual que sin tope.
    expect(b.sender.sent.at(-1)?.body).toBe(greeted(OK_WA));
    const [row] = await t.db.select().from(handoff);
    expect(row).toMatchObject({ status: 'active', summarySource: 'fallback', summary: REQUEST });
    expect(b.alertRoutes.whatsapp.received).toHaveLength(1);
    expect(b.log.named('handoff_summary_fallback')).toEqual([
      expect.objectContaining({ reason: 'spend_cap' }),
    ]);
    expect(await lastTrace()).toMatchObject({
      template: 'R-HANDOFF-OK',
      handoff: { action: 'started', kind: 'person' },
    });
    // Ni respuesta ni resumen registran consumo.
    expect(await usageRows()).toHaveLength(1);
  });

  it('petición de persona sin vías: R-CAP con contacto', async () => {
    const b = await start();
    await b.send(REQUEST);
    await b.settle();
    expect(b.sender.sent[0]?.body.startsWith(R_CAP)).toBe(true);
    expect(await t.db.select().from(handoff)).toEqual([]);
    expect(b.log.named('handoff_not_started')).toEqual([
      expect.objectContaining({ reason: 'no_routes' }),
    ]);
  });
});
