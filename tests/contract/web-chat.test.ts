/**
 * Contrato de la API JSON del chat web (004 US3, contracts/web-chat-http.md): sesión firmada,
 * comprobación de origen, validación del mensaje, deduplicación y "no disponible".
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { message } from '../../src/db/schema.js';
import { buildTestApp } from '../helpers/app.js';
import { createTestBot, type TestBot } from '../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import {
  createWebSession,
  getWebMessages,
  getWebState,
  messagesOf,
  postWebMessage,
  webHeaders,
  webToken,
} from '../helpers/web.js';

const ORIGIN = 'https://negocio.example';
const WEB_ON = {
  enabled: true,
  allowedOrigins: [ORIGIN],
  privacyUrl: `${ORIGIN}/privacidad`,
};

describe('API del chat web', () => {
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

  const start = async (opts: Parameters<typeof createTestBot>[1] = {}) =>
    (bot = await createTestBot(t, { webChat: WEB_ON, ...opts }));

  const rows = () => t.db.select().from(message);

  it('POST /session da 201 con token y no guarda nada', async () => {
    const b = await start();
    const res = await createWebSession(b.app);
    expect(res.statusCode).toBe(201);
    expect(res.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(b.log.named('web_session_created')).toHaveLength(1);
    expect(await rows()).toHaveLength(0);
  });

  it('GET /state trae el estado para pintar el iframe', async () => {
    const b = await start();
    const res = await getWebState(b.app, await webToken(b.app));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      available: true,
      businessName: 'Peluquería Tijeras',
      privacyUrl: `${ORIGIN}/privacidad`,
      maxLength: 1000,
      unavailable: null,
    });
    // El contacto va siempre: el iframe lo usa también para la disculpa (FR-021).
    expect(String(res.body.contact)).toContain('Peluquería Tijeras');
  });

  it('Origin ajeno o Sec-Fetch-Site cross-site dan 403 sin guardar (FR-027, garantía 3)', async () => {
    const b = await start();
    const token = await webToken(b.app);

    const ajeno = await postWebMessage(b.app, token, 'Hola', {
      headers: { origin: 'https://atacante.example' },
    });
    expect(ajeno.statusCode).toBe(403);
    expect(ajeno.body).toEqual({ error: 'forbidden' });

    const cross = await postWebMessage(b.app, token, 'Hola', {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(cross.statusCode).toBe(403);

    const sinOrigen = await b.app.inject({
      method: 'POST',
      url: '/chat/api/messages',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ clientMessageId: randomUUID(), text: 'Hola' }),
    });
    expect(sinOrigen.statusCode).toBe(403);

    expect(await rows()).toHaveLength(0);
    expect(b.log.named('web_rejected').map((e) => e.reason)).toEqual(['origin', 'origin', 'origin']);
  });

  it('token alterado o ausente da 401 (garantía 4)', async () => {
    const b = await start();
    const token = await webToken(b.app);
    const roto = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

    expect((await postWebMessage(b.app, roto, 'Hola')).statusCode).toBe(401);
    expect((await getWebMessages(b.app, roto)).body).toEqual({ error: 'session' });
    const sinToken = await b.app.inject({
      method: 'GET',
      url: '/chat/api/state',
      headers: webHeaders(),
    });
    expect(sinToken.statusCode).toBe(401);
    expect(await rows()).toHaveLength(0);
    expect(b.log.named('web_rejected').map((e) => e.reason)).toEqual([
      'session',
      'session',
      'session',
    ]);
  });

  it('texto vacío o de más de 1 000 caracteres da 400 con maxLength', async () => {
    const b = await start();
    const token = await webToken(b.app);
    for (const text of ['', '   ', 'a'.repeat(1001)]) {
      const res = await postWebMessage(b.app, token, text);
      expect([text.length, res.statusCode]).toEqual([text.length, 400]);
      expect(res.body).toEqual({ error: 'text', maxLength: 1000 });
    }
    expect((await postWebMessage(b.app, token, 'a'.repeat(1000))).statusCode).toBe(202);
    expect(await rows()).toHaveLength(1);
    expect(b.log.named('web_rejected').map((e) => e.reason)).toEqual([
      'invalid',
      'invalid',
      'invalid',
    ]);
  });

  it('clientMessageId que no es UUID da 400', async () => {
    const b = await start();
    const res = await postWebMessage(b.app, await webToken(b.app), 'Hola', {
      clientMessageId: 'no-es-uuid',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'clientMessageId' });
    expect(await rows()).toHaveLength(0);
  });

  it('el mismo clientMessageId dos veces deja una sola fila (FR-023, garantía 5)', async () => {
    const b = await start();
    const token = await webToken(b.app);
    const id = randomUUID();
    const first = await postWebMessage(b.app, token, '¿Abrís el sábado?', { clientMessageId: id });
    const again = await postWebMessage(b.app, token, '¿Abrís el sábado?', { clientMessageId: id });
    expect([first.statusCode, again.statusCode]).toEqual([202, 202]);
    expect(first.body).toEqual({ accepted: true });
    expect(await rows()).toHaveLength(1);
  });

  it('chat desactivado o negocio no activo: accepted:false con unavailable y sin guardar', async () => {
    const b = await start({ webChat: { enabled: false } });
    // Sin chat activado no se puede ni abrir sesión.
    const sesion = await createWebSession(b.app);
    expect(sesion.statusCode).toBe(200);
    expect(sesion.token).toBeNull();
    expect(sesion.body).toMatchObject({
      unavailable: { reason: 'disabled', message: 'Ahora mismo el chat no está disponible.' },
    });

    // Con una sesión emitida antes de desactivar, el mensaje se rechaza igual.
    await b.setWebChat({ enabled: true, allowedOrigins: [ORIGIN], privacyUrl: WEB_ON.privacyUrl });
    const token = await webToken(b.app);
    await b.setWebChat({ enabled: false });
    const res = await postWebMessage(b.app, token, 'Hola');
    expect(res.statusCode).toBe(200);
    expect(res.body.accepted).toBe(false);
    expect(res.body).toMatchObject({ unavailable: { reason: 'disabled' } });
    expect((res.body.unavailable as { contact: string }).contact).toContain('Peluquería Tijeras');
    expect(await rows()).toHaveLength(0);
  });

  it('negocio en preparación: unavailable con not_active', async () => {
    const b = await start({ activate: false });
    const sesion = await createWebSession(b.app);
    expect(sesion.body).toMatchObject({ unavailable: { reason: 'not_active' } });
  });

  it('snapshot ilegible: 503 con el contacto de emergencia', async () => {
    const roto = { getSnapshot: () => Promise.reject(new Error('sin base')) };
    const b = await start({ reader: roto });
    // Sin snapshot no hay sesión nueva; se usa una firmada por la instancia.
    const otra = await createTestBot(t, { webChat: WEB_ON });
    const token = await webToken(otra.app);
    await otra.close();

    const res = await postWebMessage(b.app, token, 'Hola');
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ unavailable: { reason: 'no_bot' } });
    expect((res.body.unavailable as { contact: string }).contact).toContain('600 99 98 88');
  });

  it('GET /messages no incluye reply_trace y devuelve el texto tal cual (garantía 9)', async () => {
    const b = await start();
    const token = await webToken(b.app);
    const texto = '¿Y esto? <script>alert(1)</script>';
    await postWebMessage(b.app, token, texto);
    await b.settle();

    const res = await getWebMessages(b.app, token);
    expect(res.statusCode).toBe(200);
    const mensajes = messagesOf(res);
    expect(mensajes[0]).toMatchObject({ from: 'visitor', text: texto });
    expect(mensajes[1]?.from).toBe('bot');
    expect(res.raw.body).not.toContain('replyTrace');
    expect(res.raw.body).not.toContain('reply_trace');
    expect(res.body.waiting).toBe(false);
    // El cursor sirve para pedir solo lo siguiente.
    const siguiente = await getWebMessages(b.app, token, String(res.body.cursor));
    expect(messagesOf(siguiente)).toEqual([]);
  });

  it('waiting es true mientras el bot no ha contestado', async () => {
    const b = await start();
    const token = await webToken(b.app);
    await postWebMessage(b.app, token, '¿Abrís el sábado?');
    const esperando = await getWebMessages(b.app, token);
    expect(esperando.body.waiting).toBe(true);
    expect(messagesOf(esperando)).toHaveLength(1);
    await b.settle();
    expect((await getWebMessages(b.app, token)).body.waiting).toBe(false);
  });

  it('cursor inventado da 400 y un cuerpo de más de 8 KB se rechaza', async () => {
    const b = await start();
    const token = await webToken(b.app);
    expect((await getWebMessages(b.app, token, 'no-es-un-cursor')).statusCode).toBe(400);

    const grande = await b.app.inject({
      method: 'POST',
      url: '/chat/api/messages',
      headers: { ...webHeaders(token), 'content-type': 'application/json' },
      payload: JSON.stringify({ clientMessageId: randomUUID(), text: 'a'.repeat(9000) }),
    });
    expect(grande.statusCode).toBe(413);
    expect(await rows()).toHaveLength(0);
  });

  it('la API solo acepta JSON: un formulario se rechaza sin analizarlo', async () => {
    const b = await start();
    const res = await b.app.inject({
      method: 'POST',
      url: '/chat/api/session',
      headers: { ...webHeaders(), 'content-type': 'application/x-www-form-urlencoded' },
      // Más de los 8 KB del chat: con el parser de formularios del panel se habría analizado.
      payload: `text=${'a'.repeat(20000)}`,
    });
    expect(res.statusCode).toBe(415);
    expect(await rows()).toHaveLength(0);
  });

  it('sin bot: la API contesta "no disponible" sin tocar la base', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    const noBot = await buildTestApp(t.db, undefined, null);
    try {
      const sesion = await createWebSession(noBot);
      expect(sesion.statusCode).toBe(200);
      expect(sesion.body).toMatchObject({ unavailable: { reason: 'no_bot' } });
      expect(sesion.token).toBeNull();
    } finally {
      await noBot.close();
    }
  });
});
