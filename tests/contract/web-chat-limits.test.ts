/**
 * Límites por IP del chat web (004 US4, FR-025, SC-007, contracts/web-chat-http.md garantía 6):
 * sesiones y mensajes por hora y por ventana, con el contacto del negocio en la respuesta y sin
 * que la IP llegue a los registros ni al dominio.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { message, modelPrice, modelUsage, usageSettings } from '../../src/db/schema.js';
import { createTestBot, TEST_LLM_MODEL, type TestBot } from '../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { createWebSession, getWebMessages, getWebState, postWebMessage } from '../helpers/web.js';

const ORIGIN = 'https://negocio.example';
const WEB_ON = {
  enabled: true,
  allowedOrigins: [ORIGIN],
  privacyUrl: `${ORIGIN}/privacidad`,
};
const IP = '198.51.100.7';
const OTRA_IP = '198.51.100.8';

interface Unavailable {
  reason: string;
  message: string;
  contact: string;
}

const unavailableOf = (body: Record<string, unknown>): Unavailable =>
  body.unavailable as Unavailable;

describe('límites por IP del chat web', () => {
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

  const start = async () => (bot = await createTestBot(t, { webChat: WEB_ON }));
  const rows = () => t.db.select().from(message);

  it('la 21.ª sesión en una hora desde la misma IP da 429 con contacto (SC-007)', async () => {
    const b = await start();
    for (let i = 0; i < 20; i++) {
      const res = await createWebSession(b.app, {}, IP);
      expect([i, res.statusCode]).toEqual([i, 201]);
    }
    const pasada = await createWebSession(b.app, {}, IP);
    expect(pasada.statusCode).toBe(429);
    expect(pasada.token).toBeNull();
    const un = unavailableOf(pasada.body);
    expect(un.reason).toBe('ip_limit');
    expect(un.message).toBe('Ahora mismo el chat no está disponible.');
    expect(un.contact).toContain('Peluquería Tijeras');
    expect(Number(pasada.headers['retry-after'])).toBeGreaterThan(0);
    expect(b.log.named('web_rejected').map((e) => e.reason)).toEqual(['session_limit']);

    // Otra IP no se ve afectada.
    expect((await createWebSession(b.app, {}, OTRA_IP)).statusCode).toBe(201);
  });

  it('el 121.º mensaje en 15 min da 429 sin guardar ni llamar al modelo (ip_limit)', async () => {
    const b = await start();
    const { token } = await createWebSession(b.app, {}, IP);
    if (token === null) throw new Error('El chat debería estar disponible');

    for (let i = 0; i < 120; i++) {
      const res = await postWebMessage(b.app, token, `Pregunta ${i + 1}`, {
        clientMessageId: randomUUID(),
        ip: IP,
      });
      expect([i, res.statusCode]).toEqual([i, 202]);
    }
    const guardados = (await rows()).length;

    const pasado = await postWebMessage(b.app, token, 'Una más', { ip: IP });
    expect(pasado.statusCode).toBe(429);
    expect(unavailableOf(pasado.body).reason).toBe('ip_limit');
    expect(Number(pasado.headers['retry-after'])).toBeGreaterThan(0);
    // No se ha guardado nada nuevo y el modelo no se ha llamado en ningún momento.
    expect((await rows()).length).toBe(guardados);
    expect(b.model.calls).toHaveLength(0);
    expect(b.log.named('web_rejected').map((e) => e.reason)).toEqual(['ip_limit']);

    // Desde otra IP, con la misma sesión, sigue aceptándose.
    expect((await postWebMessage(b.app, token, 'Desde otra red', { ip: OTRA_IP })).statusCode).toBe(
      202,
    );
  });

  it('las demás rutas de la API admiten 600 por IP en 15 min', async () => {
    const b = await start();
    const { token } = await createWebSession(b.app, {}, IP);
    if (token === null) throw new Error('El chat debería estar disponible');

    for (let i = 0; i < 600; i++) {
      const res = await getWebMessages(b.app, token, null, IP);
      if (res.statusCode !== 200) throw new Error(`Corte en la petición ${i + 1}`);
    }
    const pasada = await getWebMessages(b.app, token, null, IP);
    expect(pasada.statusCode).toBe(429);
    expect(unavailableOf(pasada.body).reason).toBe('ip_limit');
    // Cada ruta lleva su propio contador: el estado sigue respondiendo.
    expect((await getWebState(b.app, token, IP)).statusCode).toBe(200);
  });

  it('la IP no aparece en los registros técnicos (FR-029)', async () => {
    const b = await start();
    for (let i = 0; i < 21; i++) await createWebSession(b.app, {}, IP);
    expect(JSON.stringify(b.log.events)).not.toContain(IP);
  });
});

describe('tope de gasto alcanzado en el chat web (010, FR-017)', () => {
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

  /** Tope de 10,00 alcanzado; el tope de respuestas del chat web, no. */
  async function reachSpendCap(): Promise<void> {
    await t.db.insert(modelPrice).values({
      model: TEST_LLM_MODEL,
      inputMicrosPerMtok: 3_000_000n,
      outputMicrosPerMtok: 15_000_000n,
      cacheWriteMicrosPerMtok: 0n,
      cacheReadMicrosPerMtok: 0n,
    });
    await t.db.update(usageSettings).set({ capEnabled: true, monthlyCapCents: 1000 });
    await t.db.insert(modelUsage).values({
      at: new Date('2026-09-24T08:00:00Z'),
      day: '2026-09-24',
      channel: 'whatsapp',
      purpose: 'reply',
      model: TEST_LLM_MODEL,
      calls: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      costPico: 1000n * 10_000_000_000n,
      currency: 'USD',
    });
  }

  it('la API y el frame dan "no disponible" con reason quota y contacto', async () => {
    const b = (bot = await createTestBot(t, { webChat: WEB_ON }));
    const { token } = await createWebSession(b.app);
    if (token === null) throw new Error('El chat debería estar disponible');
    await reachSpendCap();

    const session = await createWebSession(b.app);
    expect(session.token).toBeNull();
    expect(unavailableOf(session.body)).toMatchObject({
      reason: 'quota',
      message: 'Ahora mismo el chat no está disponible.',
    });
    expect(unavailableOf(session.body).contact).toContain(
      'Para hablar con una persona de Peluquería Tijeras',
    );

    const state = await getWebState(b.app, token);
    expect(state.body).toMatchObject({ available: false, unavailable: { reason: 'quota' } });

    const sent = await postWebMessage(b.app, token, '¿Abrís el sábado?');
    expect(sent.statusCode).toBe(200);
    expect(sent.body).toMatchObject({ accepted: false, unavailable: { reason: 'quota' } });
    expect(await t.db.select().from(message)).toEqual([]);

    const frame = await b.app.inject({ method: 'GET', url: '/chat/frame' });
    expect(frame.statusCode).toBe(200);
    expect(frame.body).toContain('Ahora mismo el chat no está disponible.');
    expect(frame.body).toContain('Para hablar con una persona de Peluquería Tijeras');
    expect(frame.body).not.toContain('id="chat-messages"');

    expect(b.model.calls).toHaveLength(0);
  });
});
