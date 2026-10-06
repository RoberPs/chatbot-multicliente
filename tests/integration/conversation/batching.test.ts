/** US1: espera de agrupado, tope, duplicados, concurrencia y reanudación (FR-004, R5). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatModel } from '../../../src/conversation/ports.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';

describe('US1: agrupado de mensajes', () => {
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

  it('tres mensajes en menos de 3 s reciben una sola respuesta que cubre los tres', async () => {
    await bot.send('hola');
    bot.clock.advance(1000);
    await bot.send('¿abrís el sábado?');
    bot.clock.advance(1000);
    await bot.send('¿y a qué hora?');

    await bot.settle(2900);
    expect(bot.sender.sent).toHaveLength(0);
    await bot.settle(100);
    expect(bot.sender.sent).toHaveLength(1);
    expect(bot.model.calls).toHaveLength(1);
    expect(bot.model.calls[0]?.context.pending.map((p) => p.text)).toEqual([
      'hola',
      '¿abrís el sábado?',
      '¿y a qué hora?',
    ]);
    const inbound = (await bot.messages()).filter((m) => m.direction === 'inbound');
    const outbound = (await bot.messages()).find((m) => m.direction === 'outbound');
    expect(inbound.every((m) => m.status === 'answered' && m.replyId === outbound?.id)).toBe(true);
    expect(bot.log.named('reply_sent')[0]).toMatchObject({ messagesCovered: 3, kinds: ['text'] });
  });

  it('un cliente que escribe sin parar recibe respuesta a los 8 s', async () => {
    for (let i = 0; i < 4; i++) {
      await bot.send(`mensaje ${i}`);
      await bot.settle(2000);
    }
    // 8 s desde el primero y solo 2 s desde el último.
    expect(bot.sender.sent).toHaveLength(1);
    expect(bot.model.calls[0]?.context.pending).toHaveLength(4);
  });

  it('un wa_message_id repetido no genera otra respuesta', async () => {
    await bot.send('hola', { id: 'wamid.DUP' });
    expect(await bot.send('hola', { id: 'wamid.DUP' })).toBe(200);
    await bot.settle();
    expect(await bot.send('hola', { id: 'wamid.DUP' })).toBe(200);
    await bot.settle();
    expect(bot.sender.sent).toHaveLength(1);
    expect((await bot.messages()).filter((m) => m.direction === 'inbound')).toHaveLength(1);
    expect(bot.log.named('duplicate_ignored')).toHaveLength(2);
  });

  it('no hay más de 4 conversaciones procesándose a la vez', async () => {
    let active = 0;
    let maxActive = 0;
    // Cada llamada espera a que haya 4 en curso (o 2 s) y sigue 100 ms más: así coinciden
    // aunque la máquina vaya lenta, y una quinta que se colara también se vería.
    const slowModel: ChatModel = {
      async reply() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        for (let waited = 0; active < 4 && waited < 2000; waited += 10) {
          await new Promise((r) => setTimeout(r, 10));
        }
        await new Promise((r) => setTimeout(r, 100));
        active -= 1;
        return reply('Respuesta.');
      },
    };
    await bot.close();
    bot = await createTestBot(t, { chatModel: slowModel });
    for (let i = 0; i < 6; i++) await bot.send('hola', { from: `3460000000${i}` });
    await bot.settle();
    expect(bot.sender.sent).toHaveLength(6);
    expect(maxActive).toBe(4);
  });

  it('los pendientes que quedan al parar el procesador se contestan al volver a arrancarlo', async () => {
    await bot.send('hola');
    await bot.processor.stop();
    bot.clock.advance(5000);

    const restarted = bot.newProcessor();
    restarted.start();
    try {
      for (let i = 0; i < 50 && bot.sender.sent.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await restarted.stop();
    }
    expect(bot.sender.sent).toHaveLength(1);
  });
});
