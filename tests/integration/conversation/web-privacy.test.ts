/**
 * SC-008 y garantías 1-3 de contracts/activity-log.md: en una conversación web completa, los
 * registros técnicos no contienen el token, el `channel_user_id` en claro, los textos enviados
 * ni la IP; y todo evento con conversación lleva `via: "web"`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';
import {
  createWebSession,
  getWebMessages,
  postWebMessage,
  webHeaders,
  webToken,
} from '../../helpers/web.js';

const ORIGIN = 'https://negocio.example';
const WEB_ON = {
  enabled: true,
  allowedOrigins: [ORIGIN],
  privacyUrl: `${ORIGIN}/privacidad`,
};
/** IP que `fastify.inject` pone en las peticiones de este test. */
const IP = '203.0.113.45';

/** Eventos con conversación o cliente (los que llevan `via`). */
const withCustomer = (bot: TestBot) => bot.log.events.filter((e) => e.via !== undefined);

describe('privacidad de los registros del chat web', () => {
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

  it('ni token, ni identificador en claro, ni textos, ni IP en los registros (SC-008)', async () => {
    const b = await createTestBot(t, { webChat: { ...WEB_ON, dailyCap: 2, monthlyCap: 2 } });
    bot = b;

    const sesion = await createWebSession(b.app, { 'x-forwarded-for': IP });
    const token = sesion.token;
    if (token === null) throw new Error('El chat debería estar disponible');
    const id = token.split('.')[0] ?? '';

    // Límite por visitante: el 31.º mensaje de la ventana ya no se contesta (R6, FR-024).
    const textos = Array.from({ length: 31 }, (_, i) => `Pregunta secreta número ${i + 1}`);
    for (const text of textos) {
      await postWebMessage(b.app, token, text);
    }
    await b.settle();
    // Tope del chat: dos respuestas más y la siguiente pregunta se descarta por cuota.
    for (const text of ['Una más', 'Y otra', 'Esta ya no entra']) {
      textos.push(text);
      await postWebMessage(b.app, token, text);
      await b.settle();
    }
    await getWebMessages(b.app, token);
    // Un token inválido y un origen ajeno, para que haya también eventos de rechazo.
    await postWebMessage(b.app, `${token}x`, 'Con token roto');
    await postWebMessage(b.app, token, 'Desde otra web', {
      headers: { origin: 'https://atacante.example' },
    });

    const registros = JSON.stringify(b.log.events);
    expect(registros).not.toContain(token);
    expect(registros).not.toContain(id);
    expect(registros).not.toContain(IP);
    // El `channel_user_id` (hash de la sesión) tampoco aparece en claro: solo el seudónimo.
    const channelUserId = (await t.db.query.customer.findFirst())?.channelUserId ?? 'sin-cliente';
    expect(channelUserId).toMatch(/^[0-9a-f]{64}$/);
    expect(registros).not.toContain(channelUserId);
    for (const text of textos) {
      expect(registros).not.toContain(text);
    }
    // Se ha registrado algo de verdad, incluidos los rechazos y el tope.
    expect(b.log.named('web_session_created')).toHaveLength(1);
    expect(b.log.named('web_rejected').map((e) => e.reason)).toEqual(['session', 'origin']);
    expect(b.log.named('web_quota_reached').length).toBeGreaterThan(0);
    expect(b.log.named('rate_limit_exceeded').length).toBeGreaterThan(0);
  });

  it('todos los eventos con cliente o conversación llevan via: "web"', async () => {
    const b = await createTestBot(t, { webChat: WEB_ON });
    bot = b;
    b.model.queue(reply('Abrimos de martes a sábado.'));
    const token = await webToken(b.app);
    await postWebMessage(b.app, token, '¿Cuándo abrís?');
    await b.settle();

    const conCliente = withCustomer(b);
    expect(conCliente.length).toBeGreaterThan(0);
    expect(conCliente.every((e) => e.via === 'web')).toBe(true);
    // El seudónimo es estable dentro del canal y siempre de 12 hex.
    const seudonimos = new Set(conCliente.map((e) => e.customer));
    expect(seudonimos.size).toBe(1);
    expect([...seudonimos][0]).toMatch(/^[0-9a-f]{12}$/);
  });

  it('el mismo identificador en dos canales da seudónimos distintos (garantía 2)', async () => {
    const b = await createTestBot(t, { webChat: WEB_ON });
    bot = b;
    const clave = 'ab'.repeat(32);
    expect(b.log.pseudonym('web', clave)).not.toBe(b.log.pseudonym('playground', clave));
  });

  it('las peticiones del chat no registran la IP en el log de Fastify (R10)', async () => {
    const lines: string[] = [];
    const b = await createTestBot(t, {
      webChat: WEB_ON,
      logger: {
        debug: (obj) => lines.push(JSON.stringify(obj)),
        info: (obj) => lines.push(JSON.stringify(obj)),
        warn: (obj) => lines.push(JSON.stringify(obj)),
        error: (obj) => lines.push(JSON.stringify(obj)),
      },
    });
    bot = b;
    const token = await webToken(b.app);
    await b.app.inject({
      method: 'GET',
      url: '/chat/api/state',
      headers: { ...webHeaders(token), 'x-forwarded-for': IP },
    });
    expect(lines.join('\n')).not.toContain(IP);
    expect(lines.join('\n')).not.toContain(token);
  });
});
