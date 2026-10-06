/**
 * Límite por visitante del chat web (004 US4-1, FR-024, R6): al pasarse, un único aviso R-LIMIT
 * por ventana y silencio después; al bajar el ritmo vuelve a responder. Los mensajes del
 * playground no cuentan para el chat público.
 */
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { message } from '../../../src/db/schema.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';
import { postWebMessage, webToken } from '../../helpers/web.js';

const MINUTE = 60 * 1000;
const ORIGIN = 'https://negocio.example';
const WEB_ON = {
  enabled: true,
  allowedOrigins: [ORIGIN],
  privacyUrl: `${ORIGIN}/privacidad`,
};

describe('límite por visitante del chat web', () => {
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

  const outbound = () =>
    t.db
      .select({ body: message.body, replyTrace: message.replyTrace })
      .from(message)
      .where(eq(message.direction, 'outbound'))
      .orderBy(asc(message.sentAt));

  const inbound = () =>
    t.db
      .select({ status: message.status })
      .from(message)
      .where(eq(message.direction, 'inbound'));

  it('31 mensajes seguidos: R-LIMIT una vez y el resto sin respuesta (US4-1, FR-024)', async () => {
    const b = await createTestBot(t, { webChat: WEB_ON });
    bot = b;
    b.model.queue(reply('Te respondo a todo.'));
    const token = await webToken(b.app);

    for (let i = 0; i < 31; i++) {
      const res = await postWebMessage(b.app, token, `Pregunta ${i + 1}`);
      // Para el visitante la respuesta es la misma: el bot decide después.
      expect([i, res.statusCode]).toEqual([i, 202]);
    }
    await b.settle();

    // Los 30 primeros se contestan agrupados; el 31.º queda limitado sin respuesta.
    const estados = (await inbound()).map((m) => m.status);
    expect(estados.filter((s) => s === 'answered')).toHaveLength(30);
    expect(estados.filter((s) => s === 'rate_limited')).toHaveLength(1);

    const salientes = await outbound();
    const avisos = salientes.filter((m) => (m.replyTrace as { template?: string } | null)?.template === 'R-LIMIT');
    expect(avisos).toHaveLength(1);
    expect(avisos[0]?.body).toContain('Para hablar con una persona de Peluquería Tijeras');
    expect(b.log.named('rate_limit_exceeded')).toHaveLength(1);
    expect(b.log.named('rate_limit_exceeded')[0]?.noticeSent).toBe(true);
  });

  it('un segundo exceso en la misma ventana no repite el aviso', async () => {
    const b = await createTestBot(t, { webChat: WEB_ON });
    bot = b;
    const token = await webToken(b.app);
    for (let i = 0; i < 33; i++) await postWebMessage(b.app, token, `Pregunta ${i + 1}`);
    await b.settle();

    const avisos = (await outbound()).filter(
      (m) => (m.replyTrace as { template?: string } | null)?.template === 'R-LIMIT',
    );
    expect(avisos).toHaveLength(1);
    expect(b.log.named('rate_limit_exceeded').filter((e) => e.noticeSent)).toHaveLength(1);
  });

  it('al pasar la ventana vuelve a responder', async () => {
    const b = await createTestBot(t, { webChat: WEB_ON });
    bot = b;
    b.model.queue(reply('Primera respuesta.'), reply('Segunda respuesta.'));
    const token = await webToken(b.app);
    for (let i = 0; i < 31; i++) await postWebMessage(b.app, token, `Pregunta ${i + 1}`);
    await b.settle();

    // 16 minutos después la ventana de 15 min ya no cuenta los anteriores.
    b.clock.advance(16 * MINUTE);
    await postWebMessage(b.app, token, 'Ahora con calma, ¿abrís el sábado?');
    await b.settle();

    const ultimo = (await outbound()).at(-1);
    expect(ultimo?.body).toBe('Segunda respuesta.');
    expect((ultimo?.replyTrace as { template: string | null } | null)?.template).toBeNull();
  });

  it('los mensajes del playground no cuentan para el límite del chat público', async () => {
    const b = await createTestBot(t, { webChat: WEB_ON });
    bot = b;
    b.model.queue(reply('Respuesta del playground.'), reply('Respuesta del visitante.'));
    // 31 mensajes del operador probando el bot.
    for (let i = 0; i < 31; i++) await b.sendVia('playground', `Prueba ${i + 1}`);
    await b.settle();

    // El visitante web, con su propio contador, se contesta con normalidad.
    const token = await webToken(b.app);
    expect((await postWebMessage(b.app, token, '¿Abrís el sábado?')).statusCode).toBe(202);
    await b.settle();

    const webCustomer = await t.db.query.customer.findFirst({
      where: (c, { eq: is }) => is(c.channel, 'web'),
    });
    expect(webCustomer?.rateLimitNotifiedAt ?? null).toBeNull();
    const avisos = (await outbound()).filter(
      (m) => (m.replyTrace as { template?: string } | null)?.template === 'R-LIMIT',
    );
    // El único aviso es el del playground, que tiene su propio límite.
    expect(avisos).toHaveLength(1);
  });
});
