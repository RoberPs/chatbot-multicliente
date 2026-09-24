import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildTestApp,
  cookieHeader,
  csrfFrom,
  encodeForm,
  login,
  OPERATOR_USER,
} from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

describe('sesión del operador (FR-023)', () => {
  let t: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db);
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it.each([
    ['GET', '/admin'],
    ['GET', '/admin/business'],
    ['GET', '/admin/services'],
    ['GET', '/admin/services/new'],
    ['GET', '/admin/resources'],
    ['GET', '/admin/faqs'],
    ['GET', '/admin/handoff'],
    ['GET', '/admin/ruta-que-no-existe'],
    ['POST', '/admin/business'],
    ['POST', '/admin/status/activate'],
  ])('%s %s sin sesión → 302 al login', async (method, url) => {
    const res = await app.inject({ method: method as 'GET' | 'POST', url });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
  });

  it('petición htmx sin sesión → 401 con HX-Redirect', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/services',
      headers: { 'hx-request': 'true' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['hx-redirect']).toBe('/admin/login');
  });

  it('con sesión se accede al panel', async () => {
    const session = await login(app);
    const res = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { cookie: session.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('En preparación');
  });

  it('POST sin token CSRF → 403', async () => {
    const session = await login(app);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/business',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: encodeForm({ name: 'X', timezone: 'Europe/Madrid', currency: 'EUR' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST con token CSRF inválido → 403', async () => {
    const session = await login(app);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/status/deactivate',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: encodeForm({ _csrf: 'token-falso' }),
    });
    expect(res.statusCode).toBe(403);
  });

  it('contraseña incorrecta → error genérico y sin sesión', async () => {
    const page = await app.inject({ method: 'GET', url: '/admin/login' });
    const cookie = cookieHeader(page) ?? '';
    const res = await app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: encodeForm({ _csrf: csrfFrom(page.body), user: OPERATOR_USER, password: 'mala' }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('Usuario o contraseña incorrectos');
    const after = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { cookie: cookieHeader(res) ?? cookie },
    });
    expect(after.statusCode).toBe(302);
  });

  it('la cookie de sesión es HttpOnly y SameSite=Strict', async () => {
    const page = await app.inject({ method: 'GET', url: '/admin/login' });
    const cookie = page.cookies.find((c) => c.name === 'kb_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(String(cookie?.sameSite).toLowerCase()).toBe('strict');
  });

  it('cabeceras de seguridad en el panel', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/login' });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('cerrar sesión revoca también las copias de la cookie', async () => {
    const session = await login(app);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/logout',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: encodeForm({ _csrf: session.csrf }),
    });
    expect(res.statusCode).toBe(303);
    const after = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { cookie: cookieHeader(res) ?? '' },
    });
    expect(after.statusCode).toBe(302);
    // Una copia robada de la cookie anterior ya no sirve.
    const stolen = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { cookie: session.cookie },
    });
    expect(stolen.statusCode).toBe(302);
  });

  it('la sesión caduca a las 8 h del login aunque haya actividad', async () => {
    const session = await login(app);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 7 * 3600 * 1000);
      const active = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: { cookie: session.cookie },
      });
      expect(active.statusCode).toBe(200);
      const renewed = cookieHeader(active) ?? session.cookie;
      vi.setSystemTime(Date.now() + 1.5 * 3600 * 1000);
      const expired = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: { cookie: renewed },
      });
      expect(expired.statusCode).toBe(302);
    } finally {
      vi.useRealTimers();
    }
  });

  it('el panel solo acepta formularios: un cuerpo JSON → 415', async () => {
    const session = await login(app);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/business',
      headers: {
        cookie: session.cookie,
        'content-type': 'application/json',
        'x-csrf-token': session.csrf,
      },
      payload: JSON.stringify({ name: 'X' }),
    });
    expect(res.statusCode).toBe(415);
  });

  it('cabeceras de endurecimiento adicionales', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/login' });
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['permissions-policy']).toContain('camera=()');
  });
});

describe('límite de intentos de login', () => {
  let t: TestDatabase;
  let app: FastifyInstance;

  beforeAll(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db);
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it('tras 5 intentos por minuto desde la misma IP → 429', async () => {
    const page = await app.inject({ method: 'GET', url: '/admin/login' });
    const cookie = cookieHeader(page) ?? '';
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/admin/login',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: encodeForm({ _csrf: csrfFrom(page.body), user: 'x', password: 'y' }),
      });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await attempt()).statusCode);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);
  });

  it('cambiar de IP no evita el límite global de fallos', async () => {
    const page = await app.inject({ method: 'GET', url: '/admin/login' });
    const cookie = cookieHeader(page) ?? '';
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/login',
        remoteAddress: `10.0.0.${i + 10}`,
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-for': `1.2.3.${i}`,
        },
        payload: encodeForm({ _csrf: csrfFrom(page.body), user: 'x', password: 'y' }),
      });
      codes.push(res.statusCode);
    }
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(20);
    expect(codes.at(-1)).toBe(429);
  });
});
