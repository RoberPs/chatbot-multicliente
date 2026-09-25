/** US4: saludo de presentación al inicio de cada conversación (FR-019 – FR-021, SC-005). */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conversation } from '../../../src/db/schema.js';
import { saveTone } from '../../../src/knowledge/services/settings.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';

const GREETING_TU =
  '¡Hola! Soy el asistente automático de Peluquería Tijeras. Puedo informarte sobre horario, ' +
  'ubicación, servicios, precios y dudas frecuentes.';
const GREETING_USTED = GREETING_TU.replace('informarte', 'informarle');
const HOUR = 60 * 60 * 1000;

describe('US4: saludo', () => {
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

  const conversations = () => t.db.select().from(conversation).orderBy(conversation.startedAt);

  it('el primer mensaje recibe saludo y respuesta en un solo envío; el segundo, sin saludo', async () => {
    bot.model.queue(reply('El sábado abrimos de 9:00 a 14:00.'), reply('El domingo cerramos.'));
    await bot.send('hola, ¿a qué hora abrís el sábado?');
    await bot.settle();
    expect(bot.sender.sent).toHaveLength(1);
    expect(bot.sender.sent[0]?.body).toBe(`${GREETING_TU}\n\nEl sábado abrimos de 9:00 a 14:00.`);
    expect(bot.model.calls[0]?.context.greetingPrepended).toBe(true);
    expect(bot.log.named('reply_sent')[0]).toMatchObject({ greeting: true });

    const [conv] = await conversations();
    expect(conv?.greeted).toBe(true);

    await bot.send('¿y el domingo?');
    await bot.settle();
    expect(bot.sender.sent[1]?.body).toBe('El domingo cerramos.');
    expect(bot.model.calls[1]?.context.greetingPrepended).toBe(false);
    expect(bot.log.named('reply_sent')[1]).toMatchObject({ greeting: false });
  });

  it('a las 24 h exactas sigue la misma conversación y no se saluda', async () => {
    await bot.send('hola');
    await bot.settle();
    bot.clock.advance(24 * HOUR - 3000);
    await bot.send('¿seguís ahí?');
    await bot.settle();
    expect(await conversations()).toHaveLength(1);
    expect(bot.sender.sent[1]?.body).not.toContain('asistente automático');
  });

  it('a las 24 h y 1 min se abre otra conversación y vuelve el saludo', async () => {
    await bot.send('hola');
    await bot.settle();
    bot.clock.advance(24 * HOUR + 60_000 - 3000);
    await bot.send('hola de nuevo');
    await bot.settle();
    const rows = await conversations();
    expect(rows).toHaveLength(2);
    expect(rows.every((c) => c.greeted)).toBe(true);
    expect(bot.sender.sent[1]?.body.startsWith(GREETING_TU)).toBe(true);
    // El historial de la conversación anterior no se pasa al modelo.
    expect(bot.model.calls[1]?.context.history).toEqual([]);
  });

  it('un cambio de forma de trato en el panel se aplica en la siguiente respuesta', async () => {
    await bot.send('hola');
    await bot.settle();
    expect(bot.model.calls[0]?.context.addressForm).toBe('informal');

    await saveTone(t.deps, { address_form: 'formal', style_description: '' });
    await bot.send('¿abren el sábado?');
    await bot.settle();
    expect(bot.model.calls[1]?.context.addressForm).toBe('formal');

    // Nueva conversación: el saludo ya sale en usted.
    bot.clock.advance(25 * HOUR);
    await bot.send('buenas');
    await bot.settle();
    expect(bot.sender.sent[2]?.body.startsWith(GREETING_USTED)).toBe(true);
  });

  it('greeted sigue a false mientras no se ha respondido', async () => {
    await bot.send('hola');
    const pending = await t.db.select().from(conversation).where(eq(conversation.greeted, false));
    expect(pending).toHaveLength(1);
  });
});
