/**
 * Contrato del tema del panel (014, contracts/admin-theme.md): el atributo `data-theme` que pinta
 * el servidor, el control de tres opciones y `POST /admin/theme`. La ruta vive fuera del ámbito
 * del operador: el control también funciona en la pantalla de acceso (R5).
 */
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { THEME_COOKIE } from '../../../src/admin/theme.js';
import { buildTestApp, cookieHeader, csrfFrom, encodeForm, login } from '../../helpers/app.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

let t: TestDatabase;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  t = await createTestDatabase();
  await resetDb(t.db);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

afterAll(async () => {
  await t.close();
});

/** La etiqueta `<html …>` tal como sale, que es donde va el tema. */
const htmlTag = (body: string): string => /<html[^>]*>/.exec(body)?.[0] ?? '';

/** Cabeceras `Set-Cookie` de la respuesta que son de la cookie del tema. */
const themeCookies = (res: LightMyRequestResponse): string[] => {
  const raw = res.headers['set-cookie'];
  const list: string[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  return list.filter((cookie) => cookie.startsWith(`${THEME_COOKIE}=`));
};

/** Sesión anónima y token de la pantalla de acceso: el control funciona sin haber entrado. */
async function anonymous(instance: FastifyInstance): Promise<{ cookie: string; csrf: string }> {
  const page = await instance.inject({ method: 'GET', url: '/admin/login' });
  const cookie = cookieHeader(page);
  if (!cookie) throw new Error('la pantalla de acceso no crea sesión');
  return { cookie, csrf: csrfFrom(page.body) };
}

function postTheme(
  instance: FastifyInstance,
  session: { cookie: string; csrf: string },
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return instance.inject({
    method: 'POST',
    url: '/admin/theme',
    headers: {
      cookie: session.cookie,
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    payload: encodeForm({ _csrf: session.csrf, ...fields }),
  });
}

describe('el tema en el HTML de cada página', () => {
  it('la cookie decide el atributo en las páginas del panel', async () => {
    app = await buildTestApp(t.db, t.url);
    const session = await login(app);
    for (const [theme, expected] of [
      ['dark', '<html lang="es" data-theme="dark">'],
      ['light', '<html lang="es" data-theme="light">'],
    ] as const) {
      const res = await app.inject({
        method: 'GET',
        url: '/admin',
        headers: { cookie: `${session.cookie}; ${THEME_COOKIE}=${theme}` },
      });
      expect(htmlTag(res.body)).toBe(expected);
    }
  });

  it('sin cookie o con un valor desconocido no hay atributo: manda el sistema (FR-011)', async () => {
    app = await buildTestApp(t.db, t.url);
    const session = await login(app);
    for (const cookie of [session.cookie, `${session.cookie}; ${THEME_COOKIE}=morado`]) {
      const res = await app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
      expect(htmlTag(res.body)).toBe('<html lang="es">');
    }
  });

  it('la pantalla de acceso lleva el tema igual que el panel (FR-002)', async () => {
    app = await buildTestApp(t.db, t.url);
    const withCookie = await app.inject({
      method: 'GET',
      url: '/admin/login',
      headers: { cookie: `${THEME_COOKIE}=dark` },
    });
    expect(htmlTag(withCookie.body)).toBe('<html lang="es" data-theme="dark">');
    const without = await app.inject({ method: 'GET', url: '/admin/login' });
    expect(htmlTag(without.body)).toBe('<html lang="es">');
  });

  it('la página 404 del panel también lleva el tema', async () => {
    app = await buildTestApp(t.db, t.url);
    const session = await login(app);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/no-existe',
      headers: { cookie: `${session.cookie}; ${THEME_COOKIE}=dark` },
    });
    expect(res.statusCode).toBe(404);
    expect(htmlTag(res.body)).toBe('<html lang="es" data-theme="dark">');
  });
});

describe('el control de tres opciones', () => {
  it('está en el panel y en el acceso, con su token y la opción activa marcada (FR-006)', async () => {
    app = await buildTestApp(t.db, t.url);
    const session = await login(app);
    const panel = await app.inject({
      method: 'GET',
      url: '/admin/hours',
      headers: { cookie: `${session.cookie}; ${THEME_COOKIE}=dark` },
    });
    expect(panel.body).toContain('class="theme-switch"');
    expect(panel.body).toContain('action="/admin/theme"');
    expect(panel.body).toContain('name="_csrf"');
    expect(panel.body).toContain('<input type="hidden" name="next" value="/admin/hours">');
    expect(panel.body).toContain('value="dark" checked');
    expect(panel.body).not.toContain('value="auto" checked');

    const loginPage = await app.inject({ method: 'GET', url: '/admin/login' });
    expect(loginPage.body).toContain('class="theme-switch"');
    expect(loginPage.body).toContain('<input type="hidden" name="next" value="/admin/login">');
    // Sin cookie, la opción activa es automático.
    expect(loginPage.body).toContain('value="auto" checked');
  });

  it('las tres opciones y el botón de respaldo están siempre', async () => {
    app = await buildTestApp(t.db, t.url);
    const res = await app.inject({ method: 'GET', url: '/admin/login' });
    for (const value of ['auto', 'light', 'dark']) {
      expect(res.body).toContain(`value="${value}"`);
    }
    expect(res.body).toContain('<legend>Tema</legend>');
    expect(res.body).toContain('Aplicar');
  });
});

describe('POST /admin/theme', () => {
  it('con htmx responde 204 y pone la cookie, sin sesión de operador (FR-013)', async () => {
    app = await buildTestApp(t.db, t.url);
    const session = await anonymous(app);
    for (const theme of ['light', 'dark'] as const) {
      const res = await postTheme(app, session, { theme }, { 'hx-request': 'true' });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect(themeCookies(res)).toEqual([
        `${THEME_COOKIE}=${theme}; Path=/admin; Max-Age=31536000; HttpOnly; SameSite=Lax`,
      ]);
    }
  });

  it('en automático borra la cookie', async () => {
    app = await buildTestApp(t.db, t.url);
    const session = await anonymous(app);
    const res = await postTheme(app, session, { theme: 'auto' }, { 'hx-request': 'true' });
    expect(res.statusCode).toBe(204);
    expect(themeCookies(res)).toEqual([
      `${THEME_COOKIE}=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Lax`,
    ]);
  });

  it('sin htmx vuelve con un 303 al destino, y solo si es del panel', async () => {
    app = await buildTestApp(t.db, t.url);
    const session = await login(app);
    const ok = await postTheme(app, session, { theme: 'dark', next: '/admin/hours' });
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe('/admin/hours');
    expect(themeCookies(ok)).toHaveLength(1);

    for (const next of ['//evil.com', 'http://evil.com', '/chat', '']) {
      const res = await postTheme(app, session, { theme: 'dark', next });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/admin');
    }
    const sinDestino = await postTheme(app, session, { theme: 'light' });
    expect(sinDestino.headers.location).toBe('/admin');
  });

  it('un valor que no es de la lista da 422 y no toca la cookie', async () => {
    app = await buildTestApp(t.db, t.url);
    const session = await anonymous(app);
    const invalidos: Array<Record<string, string>> = [{ theme: 'morado' }, { theme: '' }, {}];
    for (const fields of invalidos) {
      const res = await postTheme(app, session, fields, { 'hx-request': 'true' });
      expect(res.statusCode).toBe(422);
      expect(themeCookies(res)).toEqual([]);
    }
  });

  it('sin token CSRF da 403 y no toca la cookie', async () => {
    app = await buildTestApp(t.db, t.url);
    const session = await anonymous(app);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/theme',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: encodeForm({ theme: 'dark' }),
    });
    expect(res.statusCode).toBe(403);
    expect(themeCookies(res)).toEqual([]);
  });

  it('no responde a GET: para el panel esa ruta no existe', async () => {
    app = await buildTestApp(t.db, t.url);
    const session = await login(app);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/theme',
      headers: { cookie: session.cookie },
    });
    expect(res.statusCode).toBe(404);
    // Sin sesión, como cualquier otra ruta del panel: a la pantalla de acceso.
    const anon = await app.inject({ method: 'GET', url: '/admin/theme' });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers.location).toBe('/admin/login');
  });
});
