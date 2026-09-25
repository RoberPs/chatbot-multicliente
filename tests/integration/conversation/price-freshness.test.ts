/** US2-4: un cambio de precio en el panel se aplica en la siguiente respuesta (FR-007). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { service } from '../../../src/db/schema.js';
import { updateService } from '../../../src/knowledge/services/catalog.js';
import { createTestBot, greeted, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';

describe('US2: frescura de los precios', () => {
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

  const priceOf = (turn: number, serviceId: string) =>
    bot.model.calls[turn]?.context.derived.prices.find((p) => p.serviceId === serviceId)?.text;

  it('entre dos turnos de la misma conversación, el segundo lleva el precio nuevo', async () => {
    const [corte] = await t.db.select().from(service).where(eq(service.name, 'Corte'));
    if (!corte) throw new Error('Falta el servicio Corte en el fixture');

    bot.model.queue(reply('El corte cuesta 15,00 €.', { mentionedServiceIds: [corte.id] }));
    await bot.send('¿cuánto cuesta el corte?');
    await bot.settle();
    expect(priceOf(0, corte.id)).toBe('15,00 €');
    expect(bot.sender.sent[0]?.body).toBe(greeted('El corte cuesta 15,00 €.'));

    await updateService(t.deps, corte.id, {
      name: 'Corte',
      price_type: 'fixed',
      price: '18',
      duration: '30',
      bookable: 'on',
      active: 'on',
    });

    // El modelo repite el precio antiguo: el verificador ya no lo acepta.
    bot.model.queue(
      reply('El corte cuesta 15,00 €.', { mentionedServiceIds: [corte.id] }),
      reply('El corte cuesta 18,00 €.', { mentionedServiceIds: [corte.id] }),
    );
    await bot.send('¿seguro?');
    await bot.settle();
    expect(priceOf(1, corte.id)).toBe('18,00 €');
    expect(bot.model.calls[1]?.context.history).toHaveLength(2);
    expect(bot.sender.sent[1]?.body).toBe('El corte cuesta 18,00 €.');
  });
});
