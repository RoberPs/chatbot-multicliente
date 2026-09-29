/**
 * Chat web durante una derivación (005, contracts/admin-and-web.md § Chat web): campo
 * `handoff` en `GET /chat/api/messages`, `waiting = false` y los reenviados como del visitante.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestBot, type TestBot } from '../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { reply } from '../helpers/fakes.js';
import { getWebMessages, messagesOf, postWebMessage, webToken } from '../helpers/web.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const WEB_ON = { enabled: true, allowedOrigins: ['https://negocio.example'] };

describe('GET /chat/api/messages con derivación', () => {
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

  it('sin derivación → handoff: null', async () => {
    const b = (bot = await createTestBot(t, { webChat: WEB_ON, handoffAlerts: ALERTS }));
    const token = await webToken(b.app);
    b.model.queue(reply('Abrimos de martes a sábado.'));
    await postWebMessage(b.app, token, '¿Qué horario tenéis?');
    await b.settle();
    const res = await getWebMessages(b.app, token);
    expect(res.body.handoff).toBeNull();
    expect(res.body.waiting).toBe(false);
  });

  it('con derivación activa: aviso fijo con el teléfono dado, waiting false y reenviados del visitante', async () => {
    const b = (bot = await createTestBot(t, { webChat: WEB_ON, handoffAlerts: ALERTS }));
    const token = await webToken(b.app);
    b.model.queue(
      reply('De acuerdo.', { handoffRequested: true }),
      reply('Gracias.', { contactName: 'Lucía', contactPhone: '612 345 678' }),
    );
    await postWebMessage(b.app, token, 'Quiero hablar con una persona');
    await b.settle();
    await postWebMessage(b.app, token, 'Lucía, 612 345 678');
    await b.settle();

    // Mensaje durante la derivación: se acepta igual (202) y queda pendiente hasta el reenvío.
    b.clock.advance(1000);
    const posted = await postWebMessage(b.app, token, 'Estaré atenta al teléfono');
    expect(posted.statusCode).toBe(202);
    const pending = await getWebMessages(b.app, token);
    expect(pending.body.waiting).toBe(false);
    expect(pending.body.handoff).toEqual({
      active: true,
      notice:
        'Hemos avisado a Peluquería Tijeras. Te contactarán en el +34 612 34 56 78. Lo que escribas aquí también les llega.',
    });
    const notice = JSON.stringify(pending.body.handoff);
    expect(notice).not.toContain('611000111');
    expect(notice).not.toContain('avisos@negocio.es');

    await b.settle();
    const after = await getWebMessages(b.app, token);
    const last = messagesOf(after).at(-1);
    expect(last).toMatchObject({ from: 'visitor', text: 'Estaré atenta al teléfono' });
    expect(after.body.waiting).toBe(false);
    // Ninguna respuesta del bot al mensaje reenviado.
    expect(messagesOf(after).filter((m) => m.from === 'bot')).toHaveLength(2);
  });
});
