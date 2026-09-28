/**
 * Contrato del recurso estático y del iframe del chat web (004 US2,
 * contracts/web-chat-http.md): `widget.js` siempre disponible, y `/chat/frame` con la CSP y el
 * `frame-ancestors` que corresponden al estado del chat, sin caché (US2-5).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/app.js';
import { createTestBot, type TestBot } from '../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const ORIGIN = 'https://negocio.example';
const OTRA = 'https://otra.example';
const WEB_ON = {
  enabled: true,
  allowedOrigins: [ORIGIN],
  privacyUrl: `${ORIGIN}/privacidad`,
};

const UNAVAILABLE = 'Ahora mismo el chat no está disponible.';

/** Directiva concreta de la CSP de la respuesta. */
function directive(headers: Record<string, unknown>, name: string): string {
  const raw = headers['content-security-policy'];
  const csp = typeof raw === 'string' ? raw : '';
  const found = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
  if (found === undefined) throw new Error(`La CSP no trae "${name}": ${csp}`);
  return found;
}

describe('widget y frame del chat web', () => {
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

  const frame = (app: FastifyInstance, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/chat/frame', headers });

  it('widget.js se sirve siempre, también sin bot, y se puede cachear', async () => {
    const withBot = await createTestBot(t, { webChat: WEB_ON });
    bot = withBot;
    const noBot = await buildTestApp(t.db, undefined, null);
    try {
      for (const app of [withBot.app, noBot]) {
        const res = await app.inject({ method: 'GET', url: '/chat/widget.js' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/javascript/);
        expect(res.headers['cache-control']).toBe('public, max-age=3600');
        expect(res.body).toContain('/chat/frame');
      }
    } finally {
      await noBot.close();
    }
  });

  it('chat activado: frame-ancestors con los orígenes configurados y el resto de la CSP', async () => {
    const b = await createTestBot(t, { webChat: WEB_ON });
    bot = b;
    const res = await frame(b.app);
    expect(res.statusCode).toBe(200);
    expect(directive(res.headers, 'frame-ancestors')).toBe(`frame-ancestors ${ORIGIN}`);
    expect(directive(res.headers, 'default-src')).toBe("default-src 'self'");
    expect(directive(res.headers, 'script-src')).toBe("script-src 'self'");
    expect(directive(res.headers, 'style-src')).toBe("style-src 'self'");
    expect(directive(res.headers, 'connect-src')).toBe("connect-src 'self'");
    expect(directive(res.headers, 'base-uri')).toBe("base-uri 'none'");
    expect(directive(res.headers, 'form-action')).toBe("form-action 'none'");
    expect(directive(res.headers, 'object-src')).toBe("object-src 'none'");
    // El frame se incrusta: no puede llevar X-Frame-Options.
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    // Vista del chat: aviso de asistente automático y enlace de privacidad (FR-017, SC-005).
    expect(res.body).toContain('asistente automático');
    expect(res.body).toContain('Peluquería Tijeras');
    expect(res.body).toContain(`${ORIGIN}/privacidad`);
    expect(res.body).toContain('30 días');
    expect(res.body).toContain('/chat/assets/frame.js');
    expect(res.body).toContain('/chat/assets/frame.css');
    // `links.js` (FR-020a) se carga antes que `frame.js`, que lo usa.
    expect(res.body.indexOf('/chat/assets/links.js')).toBeGreaterThan(-1);
    expect(res.body.indexOf('/chat/assets/links.js')).toBeLessThan(
      res.body.indexOf('/chat/assets/frame.js'),
    );
    expect(res.body).not.toContain(UNAVAILABLE);
  });

  it('los assets del frame se sirven y el resto de la app mantiene X-Frame-Options: DENY', async () => {
    const b = await createTestBot(t, { webChat: WEB_ON });
    bot = b;
    for (const url of ['/chat/assets/frame.js', '/chat/assets/links.js']) {
      const js = await b.app.inject({ method: 'GET', url });
      expect([url, js.statusCode]).toEqual([url, 200]);
      expect(js.headers['content-type']).toMatch(/text\/javascript/);
    }
    const css = await b.app.inject({ method: 'GET', url: '/chat/assets/frame.css' });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toMatch(/text\/css/);

    const login = await b.app.inject({ method: 'GET', url: '/admin/login' });
    expect(login.headers['x-frame-options']).toBe('DENY');
    expect(String(login.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
  });

  it('chat desactivado: vista "no disponible" con el contacto y frame-ancestors none (FR-022)', async () => {
    const b = await createTestBot(t);
    bot = b;
    const res = await frame(b.app);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(UNAVAILABLE);
    expect(res.body).toContain('Para hablar con una persona de Peluquería Tijeras');
    expect(directive(res.headers, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('negocio en preparación: "no disponible" aunque el chat esté activado', async () => {
    const b = await createTestBot(t, { webChat: WEB_ON, activate: false });
    bot = b;
    const res = await frame(b.app);
    expect(res.body).toContain(UNAVAILABLE);
    expect(directive(res.headers, 'frame-ancestors')).toBe("frame-ancestors 'none'");
  });

  it('sin bot: "no disponible" con el contacto de emergencia de la instancia', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    const noBot = await buildTestApp(t.db, undefined, null);
    try {
      const res = await frame(noBot);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(UNAVAILABLE);
      expect(res.body).toContain('600 99 98 88');
      expect(directive(res.headers, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    } finally {
      await noBot.close();
    }
  });

  it('Referer de un origen no permitido: "no disponible" y frame-ancestors none (FR-027)', async () => {
    const b = await createTestBot(t, { webChat: WEB_ON });
    bot = b;
    const ajeno = await frame(b.app, { referer: `${OTRA}/pagina` });
    expect(ajeno.body).toContain(UNAVAILABLE);
    expect(directive(ajeno.headers, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    // Desde una web permitida sí se sirve el chat.
    const propio = await frame(b.app, { referer: `${ORIGIN}/contacto` });
    expect(propio.body).not.toContain(UNAVAILABLE);
    expect(directive(propio.headers, 'frame-ancestors')).toBe(`frame-ancestors ${ORIGIN}`);
  });

  it('al desactivar, la siguiente petición ya ve "no disponible" (US2-5, sin caché)', async () => {
    const b = await createTestBot(t, { webChat: WEB_ON });
    bot = b;
    expect((await frame(b.app)).body).not.toContain(UNAVAILABLE);
    await b.setWebChat({ enabled: false });
    const after = await frame(b.app);
    expect(after.body).toContain(UNAVAILABLE);
    expect(directive(after.headers, 'frame-ancestors')).toBe("frame-ancestors 'none'");
  });
});
