/**
 * Exceso por concurrencia (010, SC-007, contracts/spend-cap-conversation.md): cada respuesta
 * comprueba el tope antes de llamar al modelo; las que estaban en curso al cruzarlo terminan y se
 * registran, y el exceso queda acotado a `processorConcurrency` respuestas simultáneas.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { modelPrice, modelUsage, usageSettings } from '../../../src/db/schema.js';
import { spendCapState } from '../../../src/usage/spend-cap.js';
import { createTestBot, TEST_LLM_MODEL, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply, tokens } from '../../helpers/fakes.js';

const CENT = 10_000_000_000n;
const CONCURRENCY = 4;
/** 1 000 000 tokens de entrada a 1 por millón = 1,00 por respuesta. */
const PER_REPLY = 100n * CENT;

describe('respuestas simultáneas cerca del tope', () => {
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

  it('terminan y se registran; el exceso queda acotado y lo siguiente ya no llama al modelo', async () => {
    const b = (bot = await createTestBot(t, {
      settings: { processorConcurrency: CONCURRENCY },
    }));
    // Las respuestas tardan de verdad: se solapan dentro de la misma pasada.
    for (let i = 0; i < CONCURRENCY; i++) {
      b.model.queue({ reply: reply('Respuesta.'), realDelayMs: 50, usage: tokens(1_000_000, 0) });
    }
    b.model.reportUsage(tokens(1_000_000, 0));
    await t.db.insert(modelPrice).values({
      model: TEST_LLM_MODEL,
      inputMicrosPerMtok: 1_000_000n,
      outputMicrosPerMtok: 0n,
      cacheWriteMicrosPerMtok: 0n,
      cacheReadMicrosPerMtok: 0n,
    });
    // Tope 10,00 con 9,50 gastados: cualquier respuesta lo cruza.
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
      costPico: 950n * CENT,
      currency: 'USD',
    });

    for (let i = 0; i < CONCURRENCY; i++) {
      await b.send(`Pregunta ${i + 1}`, { from: `3461100000${i}` });
    }
    await b.settle();

    // Todas comprobaron antes del modelo con 9,50 gastados: todas terminan y se registran.
    expect(b.model.calls).toHaveLength(CONCURRENCY);
    expect(b.sender.sent).toHaveLength(CONCURRENCY);
    const replies = (await t.db.select().from(modelUsage)).filter((r) => r.channel === 'whatsapp');
    expect(replies).toHaveLength(CONCURRENCY);
    const state = await spendCapState(t.db, b.clock.now(), 'Europe/Madrid');
    expect(state.level).toBe('reached');
    // Exceso acotado: como mucho una respuesta por hueco de concurrencia.
    expect(state.spentPico).toBe(950n * CENT + BigInt(CONCURRENCY) * PER_REPLY);
    expect(state.spentPico - 1000n * CENT).toBeLessThanOrEqual(BigInt(CONCURRENCY) * PER_REPLY);

    // Lo siguiente ya no llama al modelo.
    await b.send('Otra', { from: '34611000000' });
    await b.settle();
    expect(b.model.calls).toHaveLength(CONCURRENCY);
    expect(b.sender.sent.at(-1)?.body).toMatch(/^Ahora mismo no puedo atenderte por este chat\./);
  });
});
