/** Fase 10: retrasos y ventana de 24 h de WhatsApp (FR-002, FR-002a). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deactivateBusiness } from '../../../src/knowledge/services/business-status.js';
import { createTestBot, greeted, inboundOf, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';

const HOUR = 60 * 60 * 1000;

describe('Fase 10: retrasos y ventana de 24 h', () => {
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

  it('pendientes fuera de la ventana de 24 h se descartan sin respuesta', async () => {
    await bot.send('¿abrís mañana?');
    await bot.send('¿y el sábado?');
    // El proceso estuvo parado más de un día.
    await bot.settle(24 * HOUR + 60_000);

    expect(bot.sender.sent).toHaveLength(0);
    expect(bot.model.calls).toHaveLength(0);
    const inbound = await inboundOf(t);
    expect(inbound.map((m) => m.status)).toEqual(['discarded', 'discarded']);
    expect(bot.log.named('message_discarded')).toEqual([
      expect.objectContaining({ reason: 'outside_window' }),
      expect.objectContaining({ reason: 'outside_window' }),
    ]);
  });

  it('dentro de la ventana se contestan con el snapshot y la hora del momento de responder', async () => {
    await bot.send('¿estáis abiertos?');
    // Jueves 10:00 en Madrid + 10 h = 20:00, justo al cerrar.
    await bot.settle(10 * HOUR);
    expect(bot.sender.sent).toHaveLength(1);
    expect(bot.model.calls[0]?.context.derived.now.time).toBe('20:00');
    expect(bot.model.calls[0]?.context.derived.openNow).toBe(false);
  });

  it('un envío que falla deja de reintentarse si la ventana se cierra y queda failed', async () => {
    bot.model.queue(reply('Abrimos a las 10:00.'));
    await bot.send('¿a qué hora abrís?');
    bot.clock.advance(24 * HOUR - 10_000);
    // Cada reintento espera 15 s: el segundo ya cae fuera de la ventana.
    bot.sender.failRetrying(3, () => {
      bot.clock.advance(15_000);
    });
    await bot.settle();

    expect(bot.sender.canRetryAnswers).toEqual([false]);
    expect(bot.sender.sent).toHaveLength(0);
    const outbound = (await bot.messages()).filter((m) => m.direction === 'outbound');
    expect(outbound).toMatchObject([{ status: 'failed' }]);
    expect(bot.log.named('send_failed')).toEqual([
      expect.objectContaining({ attempts: 1, finalFailure: true, status: 503 }),
    ]);
    // Los entrantes quedan cubiertos: no se genera otra respuesta.
    expect((await inboundOf(t)).every((m) => m.status === 'answered')).toBe(true);
  });

  it('dentro de la ventana, el envío reintenta hasta conseguirlo', async () => {
    bot.sender.failRetrying(2, () => {
      bot.clock.advance(4_000);
    });
    await bot.send('hola');
    await bot.settle();
    expect(bot.sender.canRetryAnswers).toEqual([true, true]);
    expect(bot.sender.sent[0]?.body).toBe(greeted('Respuesta de prueba.'));
  });

  it('si el negocio pasa a "en preparación" antes de procesar, los pendientes se borran', async () => {
    await bot.send('¿abrís el sábado?');
    await deactivateBusiness(t.db);
    await bot.settle();
    expect(bot.sender.sent).toHaveLength(0);
    expect(await inboundOf(t)).toHaveLength(0);
    expect(bot.log.named('message_discarded')).toEqual([
      expect.objectContaining({ reason: 'deactivated' }),
    ]);
  });
});
