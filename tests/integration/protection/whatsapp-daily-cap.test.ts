/**
 * Tope diario de respuestas con modelo en WhatsApp (012 US1, R5, FR-005): superado, R-CAP con
 * `capReason: 'whatsapp_daily'` hasta las 00:00 locales del negocio; cuentan las respuestas con
 * modelo aunque falle su registro de consumo, y no cuentan «Probar el bot» ni el chat web.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { message, usageSettings, whatsappUsageDay } from '../../../src/db/schema.js';
import type { UsageMeter } from '../../../src/usage/meter.js';
import { createTestBot, type TestBot, type TestBotOptions } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply, tokens } from '../../helpers/fakes.js';

const R_CAP =
  'Ahora mismo no puedo atenderte por este chat.\n\nPara hablar con una persona de Peluquería Tijeras:';
const WEB_ON = {
  enabled: true,
  allowedOrigins: ['https://negocio.example'],
  privacyUrl: 'https://negocio.example/privacidad',
  dailyCap: 200,
  monthlyCap: 3000,
};
const CAP = 2;

describe('tope diario de WhatsApp', () => {
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

  async function start(opts: TestBotOptions = {}): Promise<TestBot> {
    const b = (bot = await createTestBot(t, { webChat: WEB_ON, ...opts }));
    b.model.reportUsage(tokens(100, 10));
    await t.db.update(usageSettings).set({ whatsappDailyCap: CAP });
    return b;
  }
  /** Un mensaje de WhatsApp y su respuesta (el modelo contesta si se le llama). */
  const exchange = async (b: TestBot, text: string) => {
    b.model.queue(reply('Respuesta del modelo.'));
    await b.send(text);
    await b.settle();
  };
  const repliesOn = async (day: string) =>
    (await t.db.select().from(whatsappUsageDay).where(eq(whatsappUsageDay.day, day)))[0]
      ?.replies ?? 0;
  const lastTrace = async () => {
    const rows = await t.db
      .select({ replyTrace: message.replyTrace })
      .from(message)
      .where(eq(message.direction, 'outbound'))
      .orderBy(message.sentAt);
    return rows.at(-1)?.replyTrace;
  };

  it('tras el tope, R-CAP con whatsapp_daily; el evento sale una vez; a las 00:00 locales vuelve el modelo', async () => {
    const b = await start();
    await exchange(b, 'Primera');
    await exchange(b, 'Segunda');
    expect(b.model.calls).toHaveLength(CAP);
    expect(await repliesOn('2026-09-24')).toBe(CAP);

    await exchange(b, 'Tercera');
    await exchange(b, 'Cuarta');
    expect(b.model.calls).toHaveLength(CAP);
    expect(b.sender.sent.at(-1)?.body.startsWith(R_CAP)).toBe(true);
    expect(await lastTrace()).toMatchObject({ template: 'R-CAP', capReason: 'whatsapp_daily' });
    expect(b.log.named('whatsapp_quota_reached')).toEqual([
      { event: 'whatsapp_quota_reached', cap: CAP },
    ]);
    expect(b.log.named('contact_only_reply')).toEqual([
      expect.objectContaining({ reason: 'whatsapp_daily' }),
      expect.objectContaining({ reason: 'whatsapp_daily' }),
    ]);
    // R-CAP no cuenta.
    expect(await repliesOn('2026-09-24')).toBe(CAP);

    // 23:59 locales: sigue alcanzado.
    b.clock.set('2026-09-24T21:59:00Z');
    await exchange(b, 'Casi medianoche');
    expect(b.model.calls).toHaveLength(CAP);

    // 00:00 locales del 25 (22:00 UTC): día nuevo.
    b.clock.set('2026-09-24T22:00:00Z');
    await exchange(b, 'Día nuevo');
    expect(b.model.calls).toHaveLength(CAP + 1);
    expect(await repliesOn('2026-09-25')).toBe(1);
  });

  it('cuentan las respuestas con el registro del consumo fallido o sin tokens (FR-005)', async () => {
    const meter = {
      record: () => Promise.reject(new Error('caída')),
      recordTranscription: () => Promise.reject(new Error('caída')),
    } as unknown as UsageMeter;
    const b = await start({ usageMeter: meter });
    await exchange(b, 'Primera');
    b.model.reportUsage(null);
    await exchange(b, 'Segunda');
    expect(await repliesOn('2026-09-24')).toBe(2);
    await exchange(b, 'Tercera');
    expect(b.model.calls).toHaveLength(2);
  });

  it('«Probar el bot» y el chat web no cuentan', async () => {
    const b = await start();
    for (const channel of ['playground', 'web'] as const) {
      for (let i = 0; i < CAP + 1; i++) {
        b.model.queue(reply('Respuesta del modelo.'));
        await b.sendVia(channel, `Mensaje ${i}`);
        await b.settle();
      }
    }
    expect(b.model.calls).toHaveLength(2 * (CAP + 1));
    expect(await t.db.select().from(whatsappUsageDay)).toEqual([]);
    await exchange(b, 'Por WhatsApp');
    expect(b.model.calls).toHaveLength(2 * (CAP + 1) + 1);
  });
});
