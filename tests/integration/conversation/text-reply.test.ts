/** US1: respuesta a un texto por el webhook con el snapshot vigente (FR-003, FR-006, FR-007, FR-022). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { saveBusinessHours } from '../../../src/knowledge/services/business-info.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { CUSTOMER_E164 } from '../../helpers/whatsapp.js';

const CONTACT = 'Para hablar con una persona de Peluquería Tijeras: WhatsApp';

describe('US1: respuesta a un texto', () => {
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

  it('un texto por el webhook genera una respuesta enviada al número', async () => {
    bot.model.queue(reply('Abrimos de martes a viernes de 10:00 a 20:00.'));
    expect(await bot.send('¿a qué hora abrís?')).toBe(200);
    await bot.settle();

    expect(bot.sender.sent).toEqual([
      { to: CUSTOMER_E164, body: 'Abrimos de martes a viernes de 10:00 a 20:00.' },
    ]);
    const [call] = bot.model.calls;
    expect(call?.context.snapshot.business.name).toBe('Peluquería Tijeras');
    expect(call?.context.pending).toEqual([{ kind: 'text', text: '¿a qué hora abrís?' }]);
    // Jueves 24/09/2026 10:00 en Madrid: abierto (martes a viernes de 10 a 20).
    expect(call?.context.derived.now).toEqual({
      date: '2026-09-24',
      time: '10:00',
      weekday: 4,
      timezone: 'Europe/Madrid',
    });
    expect(call?.context.derived.openNow).toBe(true);
    expect(bot.log.named('reply_sent')).toHaveLength(1);
  });

  it('los entrantes quedan answered con reply_id y el saliente sent con su id de canal', async () => {
    await bot.send('hola');
    await bot.settle();
    const rows = await bot.messages();
    const inbound = rows.find((m) => m.direction === 'inbound');
    const outbound = rows.find((m) => m.direction === 'outbound');
    expect(outbound).toMatchObject({ status: 'sent', waMessageId: 'wamid.out.1', kind: 'text' });
    expect(inbound).toMatchObject({ status: 'answered', replyId: outbound?.id });
  });

  it('el siguiente turno ve un cambio de horario hecho en el panel (FR-007)', async () => {
    await bot.send('¿abrís el lunes?');
    await bot.settle();
    expect(bot.model.calls[0]?.context.snapshot.openingHours.some((s) => s.weekday === 1)).toBe(
      false,
    );

    await saveBusinessHours(t.deps, {
      slots: [{ weekday: '1', start: '10:00', end: '14:00' }],
    });
    await bot.send('¿y ahora?');
    await bot.settle();
    expect(bot.model.calls[1]?.context.snapshot.openingHours).toEqual([
      { weekday: 1, start: '10:00', end: '14:00' },
    ]);
  });

  it('el segundo turno lleva el historial de la conversación (FR-022)', async () => {
    bot.model.queue(reply('Abrimos el sábado de 9:00 a 14:00.'));
    await bot.send('¿abrís el sábado?');
    await bot.settle();
    await bot.send('¿y el domingo?');
    await bot.settle();
    expect(bot.model.calls[1]?.context.history).toEqual([
      { direction: 'inbound', text: '¿abrís el sábado?' },
      { direction: 'outbound', text: 'Abrimos el sábado de 9:00 a 14:00.' },
    ]);
    expect(bot.model.calls[1]?.context.pending).toEqual([{ kind: 'text', text: '¿y el domingo?' }]);
  });

  it('una hora inventada se regenera con feedback y la segunda respuesta válida se envía', async () => {
    bot.model.queue(reply('Abrimos a las 8:30.'), reply('Abrimos a las 10:00.'));
    await bot.send('¿a qué hora abrís?');
    await bot.settle();
    expect(bot.model.calls).toHaveLength(2);
    expect(bot.model.calls[1]?.feedback).toMatch(/hora/);
    expect(bot.model.calls[1]?.feedback).not.toContain('8:30');
    expect(bot.sender.sent[0]?.body).toBe('Abrimos a las 10:00.');
    expect(bot.log.named('grounding_rejected')).toEqual([
      expect.objectContaining({ event: 'grounding_rejected', attempt: 1, offendingCount: 1 }),
    ]);
  });

  it('si vuelve a fallar se envía R-SAFE con CONTACTO', async () => {
    bot.model.queue(reply('Abrimos a las 8:30.'), reply('Abrimos a las 7:45.'));
    await bot.send('¿a qué hora abrís?');
    await bot.settle();
    const body = bot.sender.sent[0]?.body ?? '';
    expect(body.startsWith('No dispongo de esa información.')).toBe(true);
    expect(body).toContain(CONTACT);
    expect(body).not.toMatch(/8:30|7:45/);
    expect(bot.log.named('reply_sent')[0]).toMatchObject({
      template: 'R-SAFE',
      contactBlock: true,
    });
  });

  it('si el primer intento tarda 16 s y se rechaza, R-SAFE sin segunda llamada (plazo de 20 s)', async () => {
    bot.model.queue({ reply: reply('Abrimos a las 8:30.'), takesMs: 16_000 });
    await bot.send('¿a qué hora abrís?');
    await bot.settle();
    expect(bot.model.calls).toHaveLength(1);
    expect(bot.sender.sent[0]?.body).toContain('No dispongo de esa información.');
  });

  it('fuera del horario de apertura también se contesta (FR-003)', async () => {
    bot.clock.set('2026-09-24T21:00:00Z'); // 23:00 en Madrid
    await bot.send('¿mañana abrís?');
    await bot.settle();
    expect(bot.sender.sent).toHaveLength(1);
    expect(bot.model.calls[0]?.context.derived.openNow).toBe(false);
  });

  it('en un día de cierre puntual también se contesta (FR-003)', async () => {
    bot.clock.set('2026-12-25T10:00:00Z'); // Navidad, cerrado
    await bot.send('¿abrís hoy?');
    await bot.settle();
    expect(bot.sender.sent).toHaveLength(1);
    const today = bot.model.calls[0]?.context.derived.next14Days[0];
    expect(today).toMatchObject({ date: '2026-12-25', intervals: [], closureReason: 'Navidad' });
  });
});
