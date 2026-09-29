/**
 * Enlaces del email al negocio (005, R8, contracts/business-alerts.md § Enlaces): el `GET` nunca
 * cambia la BD, el `POST` aplica y es idempotente, cabeceras de seguridad, sin cookies y límite
 * de 30 peticiones cada 15 min por IP.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handoff } from '../../src/db/schema.js';
import { createTestBot, type TestBot } from '../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { reply } from '../helpers/fakes.js';
import { buttonMessage, postWebhook, webhookPayload } from '../helpers/whatsapp.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };

describe('/handoff/:token/:action', () => {
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

  async function derived(): Promise<{ b: TestBot; token: string }> {
    const b = (bot = await createTestBot(t, { handoffAlerts: ALERTS }));
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();
    const token = b.alertRoutes.email.received[0]?.handoff.token;
    if (!token) throw new Error('Sin aviso por email');
    return { b, token };
  }

  const get = (b: TestBot, url: string, remoteAddress = '10.0.0.1') =>
    b.app.inject({ method: 'GET', url, remoteAddress });
  const post = (b: TestBot, url: string, remoteAddress = '10.0.0.1') =>
    b.app.inject({ method: 'POST', url, remoteAddress });
  const state = async () => {
    const [row] = await t.db.select().from(handoff);
    return row;
  };

  it('el GET nunca cambia la BD en ninguna de sus variantes', async () => {
    const { b, token } = await derived();
    const before = await state();
    const attend = await get(b, `/handoff/${token}/attend`);
    expect(attend.statusCode).toBe(200);
    expect(attend.body).toContain('Cliente (+34 600 11 12 22) · quiere hablar con una persona · desde hoy a las');
    expect(attend.body).toContain(`action="/handoff/${token}/attend"`);
    expect(attend.body).toContain('>Le atiendo</button>');
    const end = await get(b, `/handoff/${token}/end`);
    expect(end.body).toContain('>Terminado</button>');
    expect(await state()).toEqual(before);

    // Ya confirmada: el enlace de «Le atiendo» ofrece «Terminado».
    await post(b, `/handoff/${token}/attend`);
    const confirmed = await state();
    const again = await get(b, `/handoff/${token}/attend`);
    expect(again.body).toContain('Ya está anotado que atiendes a Cliente.');
    expect(again.body).toContain(`action="/handoff/${token}/end"`);
    expect(await state()).toEqual(confirmed);

    // Terminada: sin botón y con el teléfono del cliente.
    await post(b, `/handoff/${token}/end`);
    const ended = await state();
    const after = await get(b, `/handoff/${token}/attend`);
    expect(after.body).toContain(
      'Esta derivación ya ha terminado y la conversación ha vuelto al asistente. Si aún no has contactado con Cliente, su teléfono es +34 600 11 12 22.',
    );
    expect(after.body).not.toContain('<form');
    expect(await state()).toEqual(ended);
  });

  it('el POST aplica, confirma con la vía email y es idempotente', async () => {
    const { b, token } = await derived();
    const first = await post(b, `/handoff/${token}/attend`);
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('Anotado: atiendes a Cliente.');
    expect(await state()).toMatchObject({ status: 'active', confirmedVia: 'email' });
    const repeat = await post(b, `/handoff/${token}/attend`);
    expect(repeat.body).toContain('Ya estaba anotado que atiendes a Cliente.');

    const end = await post(b, `/handoff/${token}/end`);
    expect(end.body).toContain(
      'Anotado: derivación terminada. El asistente vuelve a atender a Cliente.',
    );
    const ended = await state();
    expect(ended).toMatchObject({ status: 'ended', endCause: 'business' });
    const endAgain = await post(b, `/handoff/${token}/end`);
    expect(endAgain.body).toContain('Esta derivación ya ha terminado');
    expect(await state()).toEqual(ended);
  });

  it('token con formato no válido o desconocido, o acción desconocida → 404', async () => {
    const { b, token } = await derived();
    for (const url of [
      '/handoff/corto/attend',
      '/handoff/ZZZZZZZZZZZZZZZZZZZZZZ/attend',
      `/handoff/${token}/borrar`,
    ]) {
      const res = await get(b, url);
      expect(res.statusCode).toBe(404);
      expect(res.body).toContain('Este enlace no es válido.');
      expect((await post(b, url)).statusCode).toBe(404);
    }
    expect((await state())?.confirmedAt).toBeNull();
  });

  it('cabeceras de seguridad y sin cookies', async () => {
    const { b, token } = await derived();
    for (const res of [await get(b, `/handoff/${token}/attend`), await get(b, '/handoff/x/attend')]) {
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'none'; style-src 'self'; form-action 'self'",
      );
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const css = await get(b, '/handoff/assets/handoff.css');
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toMatch(/text\/css/);
  });

  it('límite de 30 peticiones cada 15 min por IP', async () => {
    const { b, token } = await derived();
    for (let i = 0; i < 30; i++) {
      expect((await get(b, `/handoff/${token}/attend`, '10.0.0.9')).statusCode).toBe(200);
    }
    expect((await get(b, `/handoff/${token}/attend`, '10.0.0.9')).statusCode).toBe(429);
    // Otra IP no se ve afectada.
    expect((await get(b, `/handoff/${token}/attend`, '10.0.0.10')).statusCode).toBe(200);
  });

  it('«Le atiendo» por email y «Terminado» por WhatsApp a la vez → solo cuenta el primero', async () => {
    const { b, token } = await derived();
    await Promise.all([
      post(b, `/handoff/${token}/attend`),
      postWebhook(
        b.app,
        webhookPayload({
          messages: [
            buttonMessage(`h1:end:${token}`, { from: '34611000111', timestamp: b.clock.now() }),
          ],
        }),
      ),
    ]);
    const row = await state();
    // Termina (el «Terminado» siempre acaba) y queda confirmada por una sola vía.
    expect(row?.status).toBe('ended');
    expect(['email', 'whatsapp']).toContain(row?.confirmedVia);
    expect(b.log.named('handoff_confirmed')).toHaveLength(1);
    expect(b.log.named('handoff_ended')).toHaveLength(1);
  });
});
