/**
 * Salida a una persona con cualquier límite alcanzado (012, Principio V, SC-002): con el tope de
 * gasto, con el tope diario de WhatsApp y con cada motivo de solo contacto, una petición de persona
 * por WhatsApp se sigue derivando al negocio con el detector determinista y el resumen literal.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  handoff,
  modelPrice,
  modelUsage,
  usageSettings,
  whatsappUsageDay,
} from '../../../src/db/schema.js';
import type { CapReason } from '../../../src/usage/types.js';
import { createTestBot, greeted, TEST_LLM_MODEL, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const CENT = 10_000_000_000n;
const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const REQUEST = 'Quiero hablar con una persona sobre la cita que tengo el sábado por la mañana';
const OK_WA =
  'He avisado a Peluquería Tijeras. Te contactarán en el +34 600 11 12 22 lo antes posible.';

describe('derivación con los límites alcanzados', () => {
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

  /** Deja la instancia en producción con el motivo `reason` activo. */
  async function start(reason: CapReason): Promise<TestBot> {
    const b = (bot = await createTestBot(t, { production: true, handoffAlerts: ALERTS }));
    if (reason !== 'model_unpriced') {
      await t.db.insert(modelPrice).values({
        model: TEST_LLM_MODEL,
        inputMicrosPerMtok: 3_000_000n,
        outputMicrosPerMtok: 15_000_000n,
        cacheWriteMicrosPerMtok: 0n,
        cacheReadMicrosPerMtok: 0n,
      });
    }
    if (reason !== 'cap_disabled') {
      await t.db.update(usageSettings).set({ capEnabled: true, monthlyCapCents: 1000 });
    }
    if (reason === 'spend_cap') {
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
    }
    if (reason === 'whatsapp_daily') {
      await t.db.update(usageSettings).set({ whatsappDailyCap: 3 });
      await t.db.insert(whatsappUsageDay).values({ day: '2026-09-24', replies: 3 });
    }
    if (reason === 'spend_unreadable') await t.db.delete(usageSettings);
    return b;
  }

  const REASONS: CapReason[] = [
    'spend_cap',
    'whatsapp_daily',
    'cap_disabled',
    'model_unpriced',
    'spend_unreadable',
  ];

  it.each(REASONS)('%s: deriva con el resumen literal y sin modelo', async (reason) => {
    const b = await start(reason);
    await b.send(REQUEST);
    await b.settle();

    expect(b.model.calls).toHaveLength(0);
    expect(b.summarizer.calls).toHaveLength(0);
    expect(b.sender.sent.at(-1)?.body).toBe(greeted(OK_WA));
    const [row] = await t.db.select().from(handoff);
    expect(row).toMatchObject({ status: 'active', summarySource: 'fallback', summary: REQUEST });
    expect(b.alertRoutes.whatsapp.received).toHaveLength(1);
    expect(b.log.named('handoff_started')).toHaveLength(1);
  });
});
