/**
 * FR-020 y Principio IV: tras aplicar una importación, la siguiente respuesta del bot usa la
 * configuración importada (lee el snapshot sin caché) y nada de lo eliminado.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { importSource, loadFixture, previewAndApply } from '../../helpers/config-transfer.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

describe('el bot responde con la configuración importada', () => {
  let t: TestDatabase;
  let bot: TestBot;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(async () => {
    await bot.close();
  });

  it('la respuesta siguiente lleva los servicios, precios y preguntas importados', async () => {
    bot = await createTestBot(t);
    await bot.send('hola');
    await bot.settle();
    const before = bot.model.calls[0]?.context.snapshot;
    const removed = before?.services.map((s) => s.name) ?? [];
    expect(removed.length).toBeGreaterThan(0);

    await previewAndApply(t.db, importSource(loadFixture('valid-full.json')));

    await bot.send('¿qué servicios tenéis?');
    await bot.settle();
    const snapshot = bot.model.calls.at(-1)?.context.snapshot;
    expect(snapshot?.status).toBe('active');
    expect(snapshot?.services.map((s) => [s.name, s.price])).toEqual([
      ['Servicio A', { type: 'fixed', amountCents: 2500 }],
      ['Servicio B', { type: 'from', amountCents: 4000 }],
    ]);
    expect(snapshot?.faqs.map((f) => f.question)).toEqual([
      '¿Hay aparcamiento?',
      '¿Se puede pagar con tarjeta?',
    ]);
    for (const name of removed) {
      expect(snapshot?.services.some((s) => s.name === name)).toBe(false);
    }
  });
});
