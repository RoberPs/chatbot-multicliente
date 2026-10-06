import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildTestApp,
  cookieHeader,
  csrfFrom,
  encodeForm,
  login,
  OPERATOR_PASSWORD,
  OPERATOR_USER,
} from '../helpers/app.js';
import { createLoginThrottle, type LoginThrottle } from '../../src/admin/auth/login-throttle.js';
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
});

describe('freno del login durante un ataque (012, US4)', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let sleeps: number[];
  let lines: string[];
  let n = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });

  /** App nueva con el freno real y las esperas anotadas en lugar de dormidas. */
  async function start(throttle?: LoginThrottle): Promise<void> {
    sleeps = [];
    lines = [];
    app = await buildTestApp(t.db, undefined, null, {}, lines, {
      loginThrottle:
        throttle ??
        createLoginThrottle({
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        }),
    });
  }

  /** Un intento desde una dirección nueva (sin el límite de 5 por minuto). */
  async function attempt(password: string, extraCookie = '') {
    n += 1;
    const page = await app.inject({ method: 'GET', url: '/admin/login' });
    const cookie = [cookieHeader(page) ?? '', extraCookie].filter(Boolean).join('; ');
    return app.inject({
      method: 'POST',
      url: '/admin/login',
      remoteAddress: `10.1.${String(Math.floor(n / 250))}.${String((n % 250) + 1)}`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: encodeForm({ _csrf: csrfFrom(page.body), user: OPERATOR_USER, password }),
    });
  }

  const deviceCookie = (res: { headers: Record<string, unknown> }) => {
    const raw = res.headers['set-cookie'];
    const list = (Array.isArray(raw) ? raw : [raw]) as string[];
    return list.find((c) => c.startsWith('__Host-chatbot-device='));
  };

  it('más fallos que el antiguo límite global: ningún 429 y la credencial correcta entra tras el retardo', async () => {
    await start();
    for (let i = 0; i < 30; i++) expect((await attempt('mala')).statusCode).toBe(401);
    const ok = await attempt(OPERATOR_PASSWORD);
    expect(ok.statusCode).toBe(303);
    expect(sleeps.at(-1)).toBe(5000);
    // login_throttled, sin dirección ni usuario, como mucho uno por minuto.
    const throttled = lines.filter((l) => l.includes('"login_throttled"'));
    expect(throttled).toHaveLength(1);
    expect(throttled[0]).not.toContain('10.1.');
    expect(throttled[0]).not.toContain(OPERATOR_USER);
    await app.close();
  });

  it('al entrar pone la cookie de navegador conocido, que evita el retardo', async () => {
    await start();
    const first = await attempt(OPERATOR_PASSWORD);
    const cookie = deviceCookie(first);
    expect(cookie).toMatch(
      /^__Host-chatbot-device=v1\.\d+\.[\w-]+; Max-Age=7776000; Path=\/; HttpOnly; SameSite=Strict$/,
    );
    for (let i = 0; i < 20; i++) await attempt('mala');
    sleeps = [];
    const known = await attempt(OPERATOR_PASSWORD, String(cookie).split(';')[0]);
    expect(known.statusCode).toBe(303);
    expect(sleeps).toEqual([]);
    // Una cookie manipulada no sirve.
    const forged = await attempt(OPERATOR_PASSWORD, '__Host-chatbot-device=v1.99999999999999.AAAA');
    expect(forged.statusCode).toBe(303);
    expect(sleeps).toEqual([3750]); // 20 fallos: 250 × 15 ms
    await app.close();
  });

  it('cola llena → 429 «Demasiados intentos…» sin verificar ni contar como fallo', async () => {
    const real = createLoginThrottle({ sleep: async () => undefined });
    let failures = 0;
    const full: LoginThrottle = {
      ...real,
      run: async () => 'full',
      failure: () => {
        failures += 1;
      },
    };
    await start(full);
    const res = await attempt(OPERATOR_PASSWORD);
    expect(res.statusCode).toBe(429);
    expect(res.body).toContain('Demasiados intentos. Inténtalo en unos segundos.');
    expect(failures).toBe(0);
    await app.close();
  });
});
