/**
 * Topes del chat web en el núcleo (004, garantías 6 y 7; SC-006; US4 escenario 4): con el tope
 * alcanzado la web no guarda ni llama al modelo, el playground nunca cuenta y WhatsApp sigue
 * respondiendo.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { message, webUsageDay } from '../../../src/db/schema.js';
import { localDay } from '../../../src/knowledge/time/local-date.js';
import { repliesOn } from '../../../src/webchat/usage.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const WEB_ON = {
  enabled: true,
  allowedOrigins: ['https://negocio.example'],
  privacyUrl: 'https://negocio.example/privacidad',
  dailyCap: 2,
  monthlyCap: 3000,
};

describe('tope del chat web en la recepción y el procesador', () => {
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

  const start = async () => (bot = await createTestBot(t, { webChat: WEB_ON }));
  const today = (b: TestBot) => localDay(b.clock.now(), 'Europe/Madrid');
  const fillCap = async (b: TestBot) => {
    await t.db.insert(webUsageDay).values({ day: today(b), replies: 2 });
  };
  const outbound = () => t.db.select().from(message).where(eq(message.direction, 'outbound'));

  it('cada respuesta web cuenta en el día local', async () => {
    const b = await start();
    await b.sendVia('web', 'Hola');
    await b.settle();
    expect(await repliesOn(t.db, today(b))).toBe(1);
  });

  it('tope alcanzado en la recepción → discarded/quota sin guardar', async () => {
    const b = await start();
    await fillCap(b);
    expect(await b.sendVia('web', 'Hola')).toEqual({ status: 'discarded', reason: 'quota' });
    expect(await b.messages()).toHaveLength(0);
    expect(b.log.named('message_discarded')).toEqual([
      expect.objectContaining({ reason: 'quota', via: 'web' }),
    ]);
    expect(b.log.named('web_quota_reached')).toEqual([
      { event: 'web_quota_reached', period: 'day', cap: 2 },
    ]);
  });

  it('tope alcanzado entre la recepción y el procesado → R-UNAVAILABLE sin modelo ni cuenta', async () => {
    const b = await start();
    expect((await b.sendVia('web', '¿Abrís el sábado?')).status).toBe('stored');
    await fillCap(b);
    await b.settle();
    expect(b.model.calls).toHaveLength(0);
    const [reply] = await outbound();
    expect(reply?.body).toMatch(
      /^Ahora mismo no puedo atenderte por este chat\.\n\nPara hablar con una persona de /,
    );
    expect(reply?.replyTrace).toMatchObject({
      template: 'R-UNAVAILABLE',
      greeting: false,
      contact: { added: true, reason: 'template' },
      modelMs: null,
    });
    expect(await repliesOn(t.db, today(b))).toBe(2);
    // Una sola vez por periodo, aunque se detecte varias veces.
    await b.sendVia('web', 'Otra');
    expect(b.log.named('web_quota_reached')).toHaveLength(1);
  });

  it('el playground nunca escribe en web_usage_day ni le afecta el tope', async () => {
    const b = await start();
    await b.sendVia('playground', 'Hola');
    await b.settle();
    expect(await t.db.select().from(webUsageDay)).toHaveLength(0);
    await fillCap(b);
    expect((await b.sendVia('playground', '¿Y el sábado?')).status).toBe('stored');
    await b.settle();
    expect(b.model.calls).toHaveLength(2);
    expect(await repliesOn(t.db, today(b))).toBe(2);
  });

  it('WhatsApp sigue respondiendo con el tope web alcanzado (US4-4)', async () => {
    const b = await start();
    await fillCap(b);
    expect((await b.sendVia('whatsapp', 'Hola')).status).toBe('stored');
    await b.settle();
    expect(b.sender.sent).toHaveLength(1);
    expect(b.model.calls).toHaveLength(1);
    expect(await repliesOn(t.db, today(b))).toBe(2);
  });
});
