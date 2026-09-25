/**
 * Conversación de prueba del operador (004 US1): el canal `playground` pasa por la misma
 * cadena que WhatsApp, funciona con el negocio en preparación, ve los cambios del panel al
 * instante y no consume el uso del chat web (FR-008, FR-010 – FR-012).
 */
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { updateService } from '../../../src/knowledge/services/catalog.js';
import { message, webUsageDay } from '../../../src/db/schema.js';
import { createTestBot, GREETING, type TestBot, type TestBotOptions } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';

/** Otra conversación de prueba: es lo que hace "Nueva conversación" (FR-010). */
const OTHER_PLAYGROUND = '9c1f2e4a-7b3d-4c8e-9a0b-1d2e3f4a5b6c';

describe('conversación de prueba del operador (playground)', () => {
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

  const start = async (opts: TestBotOptions = {}) => (bot = await createTestBot(t, opts));

  const outbound = () =>
    t.db
      .select({ body: message.body, replyTrace: message.replyTrace })
      .from(message)
      .where(eq(message.direction, 'outbound'))
      .orderBy(asc(message.sentAt));

  it('la primera respuesta saluda con el nombre del negocio y la segunda lleva historial (US1-2)', async () => {
    const b = await start();
    b.model.queue(reply('Abrimos de martes a sábado.'), reply('El corte cuesta 15 €.'));
    await b.sendVia('playground', '¿A qué hora abrís?');
    await b.settle();
    await b.sendVia('playground', '¿Y cuánto cuesta un corte?');
    await b.settle();

    const rows = await outbound();
    expect(rows[0]?.body).toBe(`${GREETING}\n\nAbrimos de martes a sábado.`);
    expect(rows[0]?.body).toContain('Peluquería Tijeras');
    expect(rows[1]?.body).toBe('El corte cuesta 15 €.');
    expect(rows[1]?.replyTrace).toMatchObject({ greeting: false });
    // El segundo turno llega al modelo con el historial del primero (FR-008).
    expect(b.model.calls[1]?.context.history.map((h) => h.direction)).toEqual([
      'inbound',
      'outbound',
    ]);
  });

  it('"Nueva conversación" vuelve a saludar y sin historial (US1-4)', async () => {
    const b = await start();
    b.model.queue(reply('Abrimos de martes a sábado.'), reply('Claro.'));
    await b.sendVia('playground', '¿A qué hora abrís?');
    await b.settle();
    await b.sendVia('playground', 'Otra cosa', { user: OTHER_PLAYGROUND });
    await b.settle();

    const rows = await outbound();
    expect(rows[1]?.body).toBe(`${GREETING}\n\nClaro.`);
    expect(rows[1]?.replyTrace).toMatchObject({ greeting: true });
    expect(b.model.calls[1]?.context.history).toEqual([]);
  });

  it('un precio cambiado en el panel aparece en la siguiente respuesta (US1-5)', async () => {
    const b = await start();
    b.model.queue(reply('El corte cuesta 15 €.'), reply('El corte cuesta 18 €.'));
    await b.sendVia('playground', '¿Cuánto cuesta un corte?');
    await b.settle();
    const prices = () => b.model.calls.at(-1)?.context.derived.prices.map((p) => p.text) ?? [];
    expect(prices().some((p) => p.includes('15'))).toBe(true);

    const corte = b.model.calls[0]?.context.snapshot.services.find((s) => s.name === 'Corte');
    if (!corte) throw new Error('El fixture no trae el servicio "Corte"');
    await updateService(t.deps, corte.id, {
      name: 'Corte',
      price_type: 'fixed',
      price: '18',
      duration: '30',
      bookable: 'on',
      active: 'on',
    });

    await b.sendVia('playground', '¿Y ahora?');
    await b.settle();
    // El snapshot se lee sin caché en cada respuesta.
    expect(prices().some((p) => p.includes('18'))).toBe(true);
    expect(prices().some((p) => p.includes('15'))).toBe(false);
  });

  it('un dato sin registrar añade el contacto con motivo offer_contact (US1-3)', async () => {
    const b = await start();
    b.model.queue(reply('No dispongo de ese dato.', { offerContact: true }));
    await b.sendVia('playground', '¿Tenéis aparcamiento?');
    await b.settle();

    const [row] = await outbound();
    expect(row?.replyTrace).toMatchObject({
      contact: { added: true, reason: 'offer_contact' },
      template: null,
    });
  });

  it('el negocio en preparación también responde y no gasta uso del chat web (US1-6, FR-012)', async () => {
    const b = await start({ activate: false });
    b.model.queue(reply('Abrimos de martes a sábado.'));
    expect((await b.sendVia('playground', '¿A qué hora abrís?')).status).toBe('stored');
    await b.settle();

    expect((await outbound())[0]?.body).toContain('Abrimos de martes a sábado.');
    expect(await t.db.select().from(webUsageDay)).toEqual([]);
    // El playground no llama a ningún sender externo: la respuesta se queda guardada.
    expect(b.sender.sent).toEqual([]);
  });
});
