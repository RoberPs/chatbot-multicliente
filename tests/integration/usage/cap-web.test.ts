/**
 * Tope de gasto alcanzado en el chat web (010 US3; FR-017, FR-018, FR-023,
 * contracts/spend-cap-conversation.md): la web pasa a "no disponible" igual que con el tope de
 * respuestas de la 004, sin llamar al modelo.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  message,
  modelPrice,
  modelUsage,
  usageSettings,
  webUsageDay,
} from '../../../src/db/schema.js';
import { contactBlock } from '../../../src/conversation/templates.js';
import { createKnowledgeReader } from '../../../src/knowledge/snapshot.js';
import { webChatAvailability } from '../../../src/webchat/availability.js';
import { createTestBot, TEST_LLM_MODEL, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const CENT = 10_000_000_000n;
const WEB_ON = {
  enabled: true,
  allowedOrigins: ['https://negocio.example'],
  privacyUrl: 'https://negocio.example/privacidad',
  dailyCap: 200,
  monthlyCap: 3000,
};

describe('tope de gasto alcanzado en el chat web', () => {
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

  const start = async () => {
    const b = (bot = await createTestBot(t, { webChat: WEB_ON, whatsapp: false }));
    await t.db.insert(modelPrice).values({
      model: TEST_LLM_MODEL,
      inputMicrosPerMtok: 3_000_000n,
      outputMicrosPerMtok: 15_000_000n,
      cacheWriteMicrosPerMtok: 0n,
      cacheReadMicrosPerMtok: 0n,
    });
    await t.db.update(usageSettings).set({ capEnabled: true, monthlyCapCents: 1000 });
    return b;
  };
  /** Gasto del mes que alcanza el tope de 10,00. */
  const reachCap = () =>
    t.db.insert(modelUsage).values({
      at: new Date('2026-09-24T08:00:00Z'),
      day: '2026-09-24',
      channel: 'playground',
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
  const availability = (b: TestBot) =>
    webChatAvailability({
      tx: t.db,
      reader: createKnowledgeReader(t.db),
      botPresent: true,
      emergencyPhone: '+34600999888',
      now: b.clock.now(),
      activityLog: b.log,
    });
  const outbound = () => t.db.select().from(message).where(eq(message.direction, 'outbound'));

  it('la recepción descarta con spend_cap y la disponibilidad da quota con contacto', async () => {
    const b = await start();
    await reachCap();
    expect(await b.sendVia('web', 'Hola')).toEqual({ status: 'discarded', reason: 'spend_cap' });
    expect(await b.messages()).toHaveLength(0);
    expect(b.log.named('message_discarded')).toEqual([
      expect.objectContaining({ reason: 'spend_cap', via: 'web' }),
    ]);

    const state = await availability(b);
    const snapshot = await createKnowledgeReader(t.db).getSnapshot();
    expect(state).toEqual({
      available: false,
      unavailable: {
        reason: 'quota',
        message: 'Ahora mismo el chat no está disponible.',
        contact: contactBlock(snapshot),
      },
    });
  });

  it('lo ya aceptado recibe R-UNAVAILABLE sin modelo (FR-018)', async () => {
    const b = await start();
    expect((await b.sendVia('web', '¿Abrís el sábado?')).status).toBe('stored');
    await reachCap();
    await b.settle();
    expect(b.model.calls).toHaveLength(0);
    const [reply] = await outbound();
    expect(reply?.body).toMatch(
      /^Ahora mismo no puedo atenderte por este chat\.\n\nPara hablar con una persona de /,
    );
    expect(reply?.replyTrace).toMatchObject({ template: 'R-UNAVAILABLE', modelMs: null });
    // R-UNAVAILABLE no cuenta como respuesta del chat web.
    expect(await t.db.select().from(webUsageDay)).toEqual([]);
  });

  it('con los dos topes a la vez, el mismo estado (FR-017)', async () => {
    const b = await start();
    await reachCap();
    await t.db.insert(webUsageDay).values({ day: '2026-09-24', replies: 200 });
    expect(await b.sendVia('web', 'Hola')).toEqual({ status: 'discarded', reason: 'quota' });
    expect((await availability(b)).available).toBe(false);
    const state = await availability(b);
    if (state.available) throw new Error('debería estar no disponible');
    expect(state.unavailable.reason).toBe('quota');
  });

  it('solo con tráfico web, cruzar el tope deja un único spend_cap_reached en el mes (FR-023)', async () => {
    const b = await start();
    await reachCap();
    await availability(b);
    await b.sendVia('web', 'Hola');
    await b.sendVia('web', 'Otra', { user: 'cd'.repeat(32) });
    await availability(b);
    expect(b.log.named('spend_cap_reached')).toEqual([
      expect.objectContaining({ event: 'spend_cap_reached', month: '2026-09' }),
    ]);
  });
});
