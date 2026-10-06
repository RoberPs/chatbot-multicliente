/** Fase 9: límite de 30 mensajes cada 15 minutos por número (FR-004a, research R6). */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { message } from '../../../src/db/schema.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';

const R_LIMIT = 'Has enviado muchos mensajes seguidos y voy a dejar de responder durante un rato.';
const CONTACT = 'Para hablar con una persona de Peluquería Tijeras:';
const MINUTE = 60_000;

describe('Fase 9: límite por número', () => {
  let t: TestDatabase;
  let bot: TestBot;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    bot = await createTestBot(t);
  });
  afterEach(async () => {
    await bot.close();
  });

  const notices = () => bot.sender.sent.filter((m) => m.body.startsWith(R_LIMIT));
  const rateLimited = () => t.db.select().from(message).where(eq(message.status, 'rate_limited'));

  /** `n` mensajes seguidos, uno por segundo. */
  async function burst(n: number, prefix = 'mensaje') {
    for (let i = 0; i < n; i++) {
      await bot.send(`${prefix} ${i + 1}`);
      bot.clock.advance(1000);
    }
  }

  it('30 mensajes en 15 min se atienden con normalidad', async () => {
    await burst(30);
    await bot.settle();
    expect(await rateLimited()).toHaveLength(0);
    expect(notices()).toHaveLength(0);
    expect(bot.sender.sent).toHaveLength(1);
    expect(bot.model.calls[0]?.context.pending).toHaveLength(30);
  });

  it('el 31 queda rate_limited y se envía una sola vez R-LIMIT con CONTACTO y sin saludo', async () => {
    await burst(30);
    await bot.settle();
    await bot.send('mensaje 31');
    await bot.settle();

    expect(await rateLimited()).toHaveLength(1);
    expect(notices()).toHaveLength(1);
    const notice = notices()[0]?.body ?? '';
    expect(notice).toContain(CONTACT);
    expect(notice).not.toContain('asistente automático');
    expect(bot.log.named('rate_limit_exceeded')).toEqual([
      expect.objectContaining({ count: 31, windowMinutes: 15, noticeSent: true }),
    ]);
    expect(bot.log.named('reply_sent').at(-1)).toMatchObject({
      template: 'R-LIMIT',
      contactBlock: true,
      greeting: false,
    });

    // Los siguientes no se contestan ni generan otro aviso.
    await burst(5, 'otro');
    await bot.settle();
    expect(await rateLimited()).toHaveLength(6);
    expect(notices()).toHaveLength(1);
    expect(bot.model.calls).toHaveLength(1);
    expect(bot.log.named('rate_limit_exceeded').at(-1)).toMatchObject({ noticeSent: false });
  });

  it('los pendientes anteriores al límite sí se contestan', async () => {
    bot.model.queue(reply('Te contesto a todo.'));
    await burst(31);
    await bot.settle();
    expect(bot.model.calls[0]?.context.pending).toHaveLength(30);
    expect(bot.sender.sent.some((m) => m.body.endsWith('Te contesto a todo.'))).toBe(true);
    expect(notices()).toHaveLength(1);
  });

  it('quien sigue enviando cada 20 s no recibe respuesta y como mucho un aviso cada 15 min', async () => {
    await burst(30);
    await bot.settle();
    const answered = bot.sender.sent.length;

    // 20 minutos más, un mensaje cada 20 s: la cuenta nunca baja de 30.
    const sentAt: number[] = [];
    for (let i = 0; i < 60; i++) {
      const before = notices().length;
      await bot.send(`insiste ${i + 1}`);
      await bot.settle(20_000);
      if (notices().length > before) sentAt.push(bot.clock.now().getTime());
    }
    expect(bot.sender.sent.length - answered).toBe(notices().length);
    expect(bot.model.calls).toHaveLength(1);
    expect(sentAt.length).toBeGreaterThanOrEqual(1);
    expect(sentAt.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < sentAt.length; i++) {
      expect((sentAt[i] ?? 0) - (sentAt[i - 1] ?? 0)).toBeGreaterThanOrEqual(15 * MINUTE);
    }
  });

  it('tras 15 min de silencio vuelve a ser atendido', async () => {
    await burst(31);
    await bot.settle();
    bot.clock.advance(15 * MINUTE + 1000);
    bot.model.queue(reply('Abrimos a las 10:00.'));
    await bot.send('¿a qué hora abrís?');
    await bot.settle();
    expect(bot.sender.sent.at(-1)?.body).toBe('Abrimos a las 10:00.');
  });
});
