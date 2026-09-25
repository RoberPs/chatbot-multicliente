/** Fase 10: borrado de conversaciones a los 30 días (FR-030, SC-011, research R11). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRetention } from '../../../src/conversation/retention.js';
import { conversation, customer, message } from '../../../src/db/schema.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const DAY = 24 * 60 * 60 * 1000;
const OTHER = '34611000999';

describe('Fase 10: retención', () => {
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

  const retention = () => createRetention({ db: t.db, clock: bot.clock, activityLog: bot.log });

  it('a los 30 días + 24 h no queda la conversación, ni sus mensajes, ni el cliente', async () => {
    await bot.send('hola');
    await bot.settle();
    expect(await t.db.select().from(message)).toHaveLength(2);

    bot.clock.advance(30 * DAY + DAY);
    await retention().purge();

    expect(await t.db.select().from(conversation)).toHaveLength(0);
    expect(await t.db.select().from(message)).toHaveLength(0);
    expect(await t.db.select().from(customer)).toHaveLength(0);
    expect(bot.log.named('retention_purged')).toEqual([
      expect.objectContaining({ conversations: 1, customers: 1 }),
    ]);
  });

  it('antes de 30 días no se borra nada', async () => {
    await bot.send('hola');
    await bot.settle();
    bot.clock.advance(29 * DAY);
    await retention().purge();
    expect(await t.db.select().from(conversation)).toHaveLength(1);
    expect(bot.log.named('retention_purged')).toEqual([
      expect.objectContaining({ conversations: 0, customers: 0 }),
    ]);
  });

  it('un cliente con otra conversación reciente se conserva', async () => {
    await bot.send('hola');
    await bot.send('hola', { from: OTHER });
    await bot.settle();
    // 20 días después, el primer cliente vuelve a escribir: conversación nueva.
    bot.clock.advance(20 * DAY);
    await bot.send('¿seguís abiertos?');
    await bot.settle();
    bot.clock.advance(11 * DAY);
    await retention().purge();

    const conversations = await t.db.select().from(conversation);
    expect(conversations).toHaveLength(1);
    const customers = await t.db.select().from(customer);
    expect(customers.map((c) => c.phone)).toEqual(['+34600111222']);
    expect(bot.log.named('retention_purged')).toEqual([
      expect.objectContaining({ conversations: 2, customers: 1 }),
    ]);
  });

  it('start() borra al arrancar y stop() para el temporizador', async () => {
    await bot.send('hola');
    await bot.settle();
    bot.clock.advance(31 * DAY);
    const r = retention();
    r.start();
    await r.stop();
    expect(await t.db.select().from(conversation)).toHaveLength(0);
  });
});
