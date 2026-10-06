/**
 * SC-003: con un modelo que tarda 5 s, el p95 de `latencyMs` (desde el último mensaje hasta el
 * envío, incluida la espera de agrupado) queda por debajo de 10 s, y el webhook responde rápido
 * porque solo guarda (research R3, R5).
 *
 * El canal web cumple el mismo presupuesto (004, R14, SC-004): la cadena es la misma y lo único
 * distinto es que la respuesta se queda guardada en vez de salir por la Graph API.
 */
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';
import { p95 } from '../../eval/report.js';

const ORIGIN = 'https://negocio.example';

describe('SC-003: latencia', () => {
  let t: TestDatabase;
  let bot: TestBot;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    bot = await createTestBot(t, {
      webChat: { enabled: true, allowedOrigins: [ORIGIN], privacyUrl: `${ORIGIN}/privacidad` },
    });
  });
  afterEach(async () => {
    await bot.close();
  });

  it('p95 de latencyMs < 10 s con un modelo de 5 s, y webhook p95 < 150 ms', async () => {
    const webhookMs: number[] = [];
    // Respuestas sucesivas: el reloj manual suma los 5 s de cada llamada al modelo.
    for (let i = 0; i < 22; i++) {
      bot.model.queue({ reply: reply('Abrimos a las 10:00.'), takesMs: 5_000 });
      const from = `346000000${String(i).padStart(2, '0')}`;
      const start = performance.now();
      expect(await bot.send('¿a qué hora abrís?', { from })).toBe(200);
      webhookMs.push(performance.now() - start);
      await bot.settle();
    }

    const latencies = bot.log.named('reply_sent').map((e) => e.latencyMs);
    expect(latencies).toHaveLength(22);
    expect(p95(latencies)).toBeLessThan(10_000);
    // Las dos primeras peticiones pagan el arranque en frío (JIT, pool de conexiones).
    expect(p95(webhookMs.slice(2))).toBeLessThan(150);
  });

  it('el canal web cumple el mismo presupuesto de latencia (004, R14, SC-004)', async () => {
    for (let i = 0; i < 22; i++) {
      bot.model.queue({ reply: reply('Abrimos a las 10:00.'), takesMs: 5_000 });
      // Un visitante distinto por vuelta: cada uno con su conversación.
      const user = String(i).padStart(2, '0').repeat(32);
      expect((await bot.sendVia('web', '¿a qué hora abrís?', { user })).status).toBe('stored');
      await bot.settle();
    }
    const latencies = bot.log.named('reply_sent').map((e) => e.latencyMs);
    expect(latencies).toHaveLength(22);
    expect(p95(latencies)).toBeLessThan(10_000);
    expect(bot.log.events.filter((e) => e.event === 'reply_sent').every((e) => e.via === 'web')).toBe(
      true,
    );
  });
});
