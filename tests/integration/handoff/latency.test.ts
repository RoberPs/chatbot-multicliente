/**
 * SC-002 (005): desde el último mensaje del cliente hasta el aviso aceptado por una vía pasa
 * menos de 1 minuto aunque todo agote su plazo; y las páginas de los enlaces del email
 * (`/handoff/*`) responden con p95 < 100 ms.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { conversationSettings } from '../../../src/conversation/settings.js';
import { ROUTE_TIMEOUT_MS } from '../../../src/handoff/service.js';
import { SUMMARY_BUDGET_MS } from '../../../src/handoff/summary.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { FakeAlertRoute, FakeSummarizer, reply } from '../../helpers/fakes.js';

const MINUTE = 60_000;
const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };

const p95 = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
};

describe('SC-002 (005): latencia de la derivación', () => {
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

  it('los plazos máximos de la cadena suman menos de 1 minuto', () => {
    const worst =
      conversationSettings.batchQuietMs +
      conversationSettings.modelBudgetMs +
      SUMMARY_BUDGET_MS +
      ROUTE_TIMEOUT_MS;
    expect(worst).toBeLessThan(MINUTE);
  });

  it(
    'con el resumen y una vía colgados hasta su plazo, el aviso sale en menos de 1 minuto',
    { timeout: 60_000 },
    async () => {
      const b = (bot = await createTestBot(t, {
        handoffAlerts: ALERTS,
        summarizer: new FakeSummarizer({ hang: true }),
        alertRoutes: { whatsapp: new FakeAlertRoute('whatsapp').always({ hang: true }) },
      }));
      b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
      await b.send('Quiero hablar con una persona');
      const wallStart = Date.now();
      // La espera de agrupado va con el reloj manual; el resto, con los plazos reales.
      await b.settle(conversationSettings.batchQuietMs);
      const elapsed = conversationSettings.batchQuietMs + (Date.now() - wallStart);
      process.stderr.write(`derivación con plazos agotados = ${elapsed} ms\n`);

      expect(b.alertRoutes.email.received).toHaveLength(1);
      expect(b.log.named('handoff_started')).toEqual([
        expect.objectContaining({
          summarySource: 'fallback',
          routes: { whatsapp: 'failed', email: 'sent' },
        }),
      ]);
      expect(elapsed).toBeLessThan(MINUTE);
    },
  );

  it('/handoff/:token/:action p95 < 100 ms', async () => {
    const b = (bot = await createTestBot(t, { handoffAlerts: ALERTS }));
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();
    const token = b.alertRoutes.email.received[0]?.handoff.token;
    if (!token) throw new Error('Sin derivación');

    const samples: number[] = [];
    // Menos de 30: el límite por IP de los enlaces es de 30 peticiones cada 15 min.
    for (let i = 0; i < 25; i++) {
      const url = `/handoff/${token}/${i % 2 === 0 ? 'attend' : 'end'}`;
      const started = performance.now();
      const res = await b.app.inject({ method: 'GET', url });
      samples.push(performance.now() - started);
      expect(res.statusCode).toBe(200);
    }
    process.stderr.write(`GET /handoff/* p95 = ${p95(samples).toFixed(1)} ms\n`);
    expect(p95(samples), `p95 = ${p95(samples).toFixed(1)} ms`).toBeLessThan(100);
  });
});
