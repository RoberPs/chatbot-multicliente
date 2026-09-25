/**
 * Conversación completa del visitante por la web (004 US3): saludo, agrupado, contacto,
 * continuidad al reconectar y conversación nueva a las 24 h. Todo con el modelo falso y
 * atravesando la API JSON, como lo haría el iframe.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestBot, GREETING, type TestBot, type TestBotOptions } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';
import {
  createWebSession,
  getWebMessages,
  messagesOf,
  postWebMessage,
  webToken,
} from '../../helpers/web.js';

const HOUR = 60 * 60 * 1000;
const ORIGIN = 'https://negocio.example';
const WEB_ON = {
  enabled: true,
  allowedOrigins: [ORIGIN],
  privacyUrl: `${ORIGIN}/privacidad`,
};

describe('conversación del visitante en la web', () => {
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

  const start = async (opts: TestBotOptions = {}) =>
    (bot = await createTestBot(t, { webChat: WEB_ON, ...opts }));

  /** Textos del bot en la conversación vigente. */
  const botTexts = async (b: TestBot, token: string) =>
    messagesOf(await getWebMessages(b.app, token))
      .filter((m) => m.from === 'bot')
      .map((m) => m.text);

  it('la primera respuesta saluda con el nombre del negocio (US3-2)', async () => {
    const b = await start();
    b.model.queue(reply('Abrimos de martes a sábado.'));
    const token = await webToken(b.app);
    expect((await postWebMessage(b.app, token, '¿Cuándo abrís?')).statusCode).toBe(202);
    await b.settle();

    expect(await botTexts(b, token)).toEqual([`${GREETING}\n\nAbrimos de martes a sábado.`]);
    expect(GREETING).toContain('Peluquería Tijeras');
  });

  it('tres mensajes en menos de 3 s reciben una sola respuesta (US3-3)', async () => {
    const b = await start();
    b.model.queue(reply('Te respondo a las tres cosas.'));
    const token = await webToken(b.app);
    for (const text of ['Hola', '¿Abrís hoy?', '¿Y mañana?']) {
      expect((await postWebMessage(b.app, token, text)).statusCode).toBe(202);
      b.clock.advance(500);
    }
    await b.settle();

    expect(await botTexts(b, token)).toHaveLength(1);
    // Una sola llamada al modelo, con los tres mensajes pendientes.
    expect(b.model.calls).toHaveLength(1);
    expect(b.model.calls[0]?.context.pending).toHaveLength(3);
  });

  it('pedir hablar con una persona añade el contacto de derivación (US3-4)', async () => {
    const b = await start();
    b.model.queue(reply('Te paso el contacto.', { handoffRequested: true }));
    const token = await webToken(b.app);
    await postWebMessage(b.app, token, 'Quiero hablar con una persona');
    await b.settle();

    const [texto] = await botTexts(b, token);
    expect(texto).toContain('Para hablar con una persona de Peluquería Tijeras');
    // El medio registrado en el fixture (sin horario de atención, que es opcional).
    expect(texto).toContain('+34 612 34 56 78');
    const outbound = (await b.messages()).filter((m) => m.direction === 'outbound');
    expect(outbound[0]?.replyTrace).toMatchObject({
      contact: { added: true, reason: 'handoff_requested' },
    });
  });

  it('al reconectar se recupera el historial y no se repite el saludo (US3-5)', async () => {
    const b = await start();
    b.model.queue(reply('Abrimos de martes a sábado.'), reply('El corte cuesta 15 €.'));
    const token = await webToken(b.app);
    await postWebMessage(b.app, token, '¿Cuándo abrís?');
    // La respuesta llega mientras el visitante tiene la pestaña cerrada.
    await b.settle();

    // Vuelve con el mismo token y sin cursor: recibe todo lo de la conversación vigente.
    const historial = messagesOf(await getWebMessages(b.app, token));
    expect(historial.map((m) => m.from)).toEqual(['visitor', 'bot']);
    expect(historial[1]?.text).toContain(GREETING);

    await postWebMessage(b.app, token, '¿Cuánto cuesta un corte?');
    await b.settle();
    const textos = await botTexts(b, token);
    expect(textos[1]).toBe('El corte cuesta 15 €.');
    expect(textos[1]).not.toContain(GREETING);
  });

  it('más de 24 h sin mensajes abre conversación nueva con saludo (FR-019)', async () => {
    const b = await start();
    b.model.queue(reply('Abrimos de martes a sábado.'), reply('Claro que sí.'));
    const token = await webToken(b.app);
    await postWebMessage(b.app, token, '¿Cuándo abrís?');
    await b.settle();

    b.clock.advance(25 * HOUR);
    await postWebMessage(b.app, token, '¿Seguís abiertos?');
    await b.settle();

    // La conversación vigente es la nueva: el historial no arrastra la anterior.
    const mensajes = messagesOf(await getWebMessages(b.app, token));
    expect(mensajes).toHaveLength(2);
    expect(mensajes[0]?.text).toBe('¿Seguís abiertos?');
    expect(mensajes[1]?.text).toBe(`${GREETING}\n\nClaro que sí.`);
  });

  it('negocio en preparación: unavailable con el contacto y sin guardar (US3-6)', async () => {
    const b = await start({ activate: false });
    const sesion = await createWebSession(b.app);
    expect(sesion.token).toBeNull();
    const un = sesion.body.unavailable as { reason: string; contact: string };
    expect(un.reason).toBe('not_active');
    expect(un.contact).toContain('Peluquería Tijeras');
    expect(await b.messages()).toHaveLength(0);
  });

  it('dos pestañas con el mismo token no duplican la respuesta', async () => {
    const b = await start();
    b.model.queue(reply('Abrimos de martes a sábado.'));
    const token = await webToken(b.app);
    const id = randomUUID();
    // La misma pregunta enviada dos veces (dos pestañas con el mismo localStorage).
    await postWebMessage(b.app, token, '¿Cuándo abrís?', { clientMessageId: id });
    await postWebMessage(b.app, token, '¿Cuándo abrís?', { clientMessageId: id });
    await b.settle();

    const mensajes = messagesOf(await getWebMessages(b.app, token));
    expect(mensajes.filter((m) => m.from === 'visitor')).toHaveLength(1);
    expect(mensajes.filter((m) => m.from === 'bot')).toHaveLength(1);
  });

  it('dos visitantes distintos tienen conversaciones separadas', async () => {
    const b = await start();
    // Las dos conversaciones se procesan a la vez y el reparto de la cola del modelo falso no
    // es determinista: se comprueba la separación, no qué respuesta le toca a cada uno.
    b.model.queue(reply('Respuesta A.'), reply('Respuesta B.'));
    const uno = await webToken(b.app);
    const dos = await webToken(b.app);
    await postWebMessage(b.app, uno, 'Soy el primero');
    await postWebMessage(b.app, dos, 'Soy el segundo');
    await b.settle();

    const primero = messagesOf(await getWebMessages(b.app, uno));
    const segundo = messagesOf(await getWebMessages(b.app, dos));
    expect(primero[0]?.text).toBe('Soy el primero');
    expect(segundo[0]?.text).toBe('Soy el segundo');
    // Cada uno recibe una sola respuesta, con su propio saludo, y no ve la del otro.
    for (const mensajes of [primero, segundo]) {
      const delBot = mensajes.filter((m) => m.from === 'bot');
      expect(delBot).toHaveLength(1);
      expect(delBot[0]?.text).toContain(GREETING);
    }
    expect(primero[1]?.text).not.toBe(segundo[1]?.text);
  });
});
