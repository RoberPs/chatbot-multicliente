/**
 * Contrato de la página "Chat web" del panel (004 US2 y US4,
 * contracts/admin-web-channel.md): estado, validación al activar, fragmento para la web del
 * negocio, uso del día y del mes, y la línea de estado de la portada.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { webChatSettings, webUsageDay } from '../../../src/db/schema.js';
import { readWebChatSettings } from '../../../src/webchat/settings.js';
import {
  buildTestApp,
  cookieHeader,
  encodeForm,
  fieldErrorsIn,
  get,
  login,
  postForm,
  type FormFields,
  type Session,
} from '../../helpers/app.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const ORIGIN = 'https://negocio.example';

/** Formulario válido que activa el chat. */
const activar = (over: FormFields = {}): FormFields => ({
  enabled: 'on',
  allowed_origins: ORIGIN,
  privacy_url: `${ORIGIN}/privacidad`,
  daily_cap: '200',
  monthly_cap: '3000',
  ...over,
});

describe('Chat web (/admin/web-chat)', () => {
  let t: TestDatabase;
  let bot: TestBot | null = null;
  let app: FastifyInstance;
  let session: Session;

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

  async function start(): Promise<TestBot> {
    bot = await createTestBot(t);
    app = bot.app;
    session = await login(app);
    return bot;
  }

  /** Envía el formulario y se queda con la cookie nueva (el aviso viaja en la sesión). */
  async function save(fields: FormFields) {
    const res = await postForm(app, session, '/admin/web-chat', fields);
    const cookie = cookieHeader(res);
    if (cookie) session = { ...session, cookie };
    return res;
  }

  const settings = () => readWebChatSettings(t.db);

  it('sin sesión redirige al login y el POST sin CSRF da 403', async () => {
    const b = await start();
    const anon = await b.app.inject({ method: 'GET', url: '/admin/web-chat' });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers.location).toBe('/admin/login');

    const noCsrf = await b.app.inject({
      method: 'POST',
      url: '/admin/web-chat',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: encodeForm(activar()),
    });
    expect(noCsrf.statusCode).toBe(403);
    expect((await settings()).enabled).toBe(false);
  });

  it('por defecto está desactivado y el fragmento avisa de que no mostrará nada (FR-014)', async () => {
    await start();
    const page = await get(app, session, '/admin/web-chat');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Desactivado');
    expect(page.body).toContain('/chat/widget.js');
    expect(page.body).toContain('No mostrará nada hasta que actives el chat');
  });

  it('activar sin webs o sin enlace da 422 y la fila sigue desactivada (US2-2)', async () => {
    await start();
    const sinWebs = await postForm(
      app,
      session,
      '/admin/web-chat',
      activar({ allowed_origins: '' }),
    );
    expect(sinWebs.statusCode).toBe(422);
    expect(sinWebs.body).toContain('Indica al menos una web donde se mostrará el chat');
    expect(fieldErrorsIn(sinWebs.body)).toContain('allowed_origins');

    const sinEnlace = await postForm(app, session, '/admin/web-chat', activar({ privacy_url: '' }));
    expect(sinEnlace.statusCode).toBe(422);
    expect(sinEnlace.body).toContain('Indica el enlace a la política de privacidad del negocio');

    expect(await settings()).toMatchObject({ enabled: false, allowedOrigins: [] });
  });

  it('origen con ruta, http público o repetido da 422 con el error en su línea', async () => {
    await start();
    const casos: Array<[string, string]> = [
      [`${ORIGIN}/tienda`, 'Línea 1: indica solo la dirección de la web, sin ruta ni parámetros'],
      ['http://negocio.example', 'Línea 1: la web debe usar https'],
      [`${ORIGIN}\n${ORIGIN}/`, 'Línea 2: esa web está repetida'],
    ];
    for (const [origins, message] of casos) {
      const res = await postForm(
        app,
        session,
        '/admin/web-chat',
        activar({ allowed_origins: origins }),
      );
      expect([origins, res.statusCode]).toEqual([origins, 422]);
      expect(res.body).toContain(message);
    }
    expect((await settings()).enabled).toBe(false);
  });

  it('el tope mensual menor que el diario da 422 en el tope mensual', async () => {
    await start();
    const res = await postForm(
      app,
      session,
      '/admin/web-chat',
      activar({ daily_cap: '200', monthly_cap: '100' }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('El tope mensual no puede ser menor que el diario');
    expect(fieldErrorsIn(res.body)).toContain('monthly_cap');
  });

  it('guardado válido: 303 con aviso, y desactivar conserva los valores', async () => {
    await start();
    const saved = await save(activar({ monthly_cap: '1000' }));
    expect(saved.statusCode).toBe(303);
    expect(saved.headers.location).toBe('/admin/web-chat');
    expect(await settings()).toEqual({
      enabled: true,
      allowedOrigins: [ORIGIN],
      privacyUrl: `${ORIGIN}/privacidad`,
      dailyCap: 200,
      monthlyCap: 1000,
    });
    const page = await get(app, session, '/admin/web-chat');
    expect(page.body).toContain('Chat web activado');
    expect(page.body).toContain('Activado');
    expect(page.body).not.toContain('No mostrará nada hasta que actives el chat');

    const off = await save(activar({ enabled: undefined, monthly_cap: '1000' }));
    expect(off.statusCode).toBe(303);
    expect(await settings()).toMatchObject({
      enabled: false,
      allowedOrigins: [ORIGIN],
      privacyUrl: `${ORIGIN}/privacidad`,
      monthlyCap: 1000,
    });
    expect((await get(app, session, '/admin/web-chat')).body).toContain('Chat web desactivado');
  });

  it('el fragmento usa PUBLIC_BASE_URL si está definida y el origen de la petición si no', async () => {
    const b = await start();
    const propia = await get(b.app, session, '/admin/web-chat');
    // `fastify.inject` pide a localhost: ese es el origen que se ofrece si no hay variable.
    expect(propia.body).toMatch(/http:\/\/localhost(:\d+)?\/chat\/widget\.js/);

    const publica = await buildTestApp(t.db, undefined, null, {
      PUBLIC_BASE_URL: 'https://instancia.example',
    });
    try {
      const otra = await login(publica);
      const page = await get(publica, otra, '/admin/web-chat');
      expect(page.body).toContain('https://instancia.example/chat/widget.js');
      expect(page.body).not.toContain('localhost/chat/widget.js');
    } finally {
      await publica.close();
    }
  });

  it('el uso del día y del mes sale de web_usage_day en la zona del negocio (FR-026a)', async () => {
    await start();
    // El reloj de prueba está en el 24/09/2026 (Europe/Madrid).
    await t.db.insert(webUsageDay).values([
      { day: '2026-09-01', replies: 5 },
      { day: '2026-09-24', replies: 7 },
      // Día del mes anterior: no cuenta en ninguno de los dos números.
      { day: '2026-08-31', replies: 99 },
    ]);
    const page = await get(app, session, '/admin/web-chat');
    expect(page.body).toContain('Hoy: 7 de 200');
    expect(page.body).toContain('Este mes: 12 de 3 000');
  });

  it('la portada muestra el estado del chat web con enlace', async () => {
    await start();
    expect((await get(app, session, '/admin')).body).toContain('Chat web: desactivado');

    await t.db.update(webChatSettings).set({
      enabled: true,
      allowedOrigins: [ORIGIN, 'https://otra.example'],
      privacyUrl: `${ORIGIN}/privacidad`,
    });
    const page = await get(app, session, '/admin');
    expect(page.body).toContain('Chat web: activado en 2 webs');
    expect(page.body).toContain('/admin/web-chat');
  });

  it('sin bot avisa de que falta la clave del modelo', async () => {
    bot = await createTestBot(t);
    const noBot = await buildTestApp(t.db, undefined, null);
    try {
      const noBotSession = await login(noBot);
      const page = await get(noBot, noBotSession, '/admin/web-chat');
      expect(page.body).toContain('Falta la clave del modelo de lenguaje');
    } finally {
      await noBot.close();
    }
  });
});
