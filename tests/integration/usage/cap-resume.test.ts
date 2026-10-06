/**
 * Reanudación tras el tope de gasto (010 US3-7 – US3-10, FR-022, SC-005): subir el tope,
 * desactivarlo o empezar el mes local hace que el siguiente mensaje vuelva al modelo sin
 * reiniciar; "Probar el bot" nunca se corta y su consumo suma.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { modelPrice, modelUsage, usageSettings } from '../../../src/db/schema.js';
import { createTestBot, TEST_LLM_MODEL, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { tokens } from '../../helpers/fakes.js';

const CENT = 10_000_000_000n;
const R_CAP = 'Ahora mismo no puedo atenderte por este chat.';

describe('reanudación tras el tope de gasto', () => {
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

  /** Precio: 1 por millón de tokens de entrada; el resto, gratis. Tope de 10,00. */
  async function start(): Promise<TestBot> {
    const b = (bot = await createTestBot(t));
    b.model.reportUsage(tokens(1000, 0));
    await t.db.insert(modelPrice).values({
      model: TEST_LLM_MODEL,
      inputMicrosPerMtok: 1_000_000n,
      outputMicrosPerMtok: 0n,
      cacheWriteMicrosPerMtok: 0n,
      cacheReadMicrosPerMtok: 0n,
    });
    await t.db.update(usageSettings).set({ capEnabled: true, monthlyCapCents: 1000 });
    return b;
  }
  const spend = (cents: bigint, day = '2026-09-24') =>
    t.db.insert(modelUsage).values({
      at: new Date(`${day}T08:00:00Z`),
      day,
      channel: 'web',
      purpose: 'reply',
      model: TEST_LLM_MODEL,
      calls: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      costPico: cents * CENT,
      currency: 'USD',
    });
  const lastSent = (b: TestBot) => b.sender.sent.at(-1)?.body ?? '';

  it('subir el tope por encima del gasto: el siguiente mensaje llama al modelo', async () => {
    const b = await start();
    await spend(1000n);
    await b.send('Hola');
    await b.settle();
    expect(lastSent(b).startsWith(R_CAP)).toBe(true);

    await t.db.update(usageSettings).set({ monthlyCapCents: 2000 });
    await b.send('¿Abrís el sábado?');
    await b.settle();
    expect(b.model.calls).toHaveLength(1);
    expect(lastSent(b).startsWith(R_CAP)).toBe(false);
  });

  it('desactivar el tope: el siguiente mensaje llama al modelo', async () => {
    const b = await start();
    await spend(1500n);
    await t.db.update(usageSettings).set({ capEnabled: false });
    await b.send('Hola');
    await b.settle();
    expect(b.model.calls).toHaveLength(1);
  });

  it('el mes local siguiente vuelve al modelo y el evento puede salir otra vez', async () => {
    const b = await start();
    await spend(1000n);
    await b.send('Hola');
    await b.settle();
    expect(b.model.calls).toHaveLength(0);
    expect(b.log.named('spend_cap_reached')).toEqual([
      expect.objectContaining({ month: '2026-09' }),
    ]);

    // 22:30 UTC del 30/09 = 00:30 del 01/10 en Madrid: mes nuevo, gasto 0.
    b.clock.set('2026-09-30T22:30:00Z');
    await b.send('¿Abrís mañana?');
    await b.settle();
    expect(b.model.calls).toHaveLength(1);

    await spend(1000n, '2026-10-01');
    await b.send('Otra cosa');
    await b.settle();
    expect(b.model.calls).toHaveLength(1);
    expect(b.log.named('spend_cap_reached').map((e) => e.month)).toEqual(['2026-09', '2026-10']);
  });

  it('"Probar el bot" sigue llamando al modelo y su consumo suma (FR-019)', async () => {
    const b = await start();
    await spend(1000n);
    await b.sendVia('playground', '¿Abrís el sábado?');
    await b.settle();
    expect(b.model.calls).toHaveLength(1);
    const rows = await t.db.select().from(modelUsage);
    const playground = rows.find((r) => r.channel === 'playground');
    expect(playground?.costPico).toBe(1000n * 1_000_000n);
    expect(b.log.named('spend_cap_reached')).toEqual([]);
  });

  it('si el tope lo cruza "Probar el bot", el evento sale con el siguiente cliente final', async () => {
    const b = await start();
    // 9,999 gastados; la respuesta del playground (0,001) llega justo al tope.
    await spend(999n);
    await t.db.insert(modelUsage).values({
      at: new Date('2026-09-24T08:00:00Z'),
      day: '2026-09-24',
      channel: 'web',
      purpose: 'reply',
      model: TEST_LLM_MODEL,
      calls: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      costPico: 1n * CENT - 1000n * 1_000_000n,
      currency: 'USD',
    });
    await b.sendVia('playground', 'Prueba');
    await b.settle();
    expect(b.model.calls).toHaveLength(1);
    expect(b.log.named('spend_cap_reached')).toEqual([]);

    await b.send('Hola');
    await b.settle();
    expect(b.model.calls).toHaveLength(1);
    expect(b.log.named('spend_cap_reached')).toEqual([
      expect.objectContaining({ month: '2026-09', via: 'whatsapp' }),
    ]);
  });
});
