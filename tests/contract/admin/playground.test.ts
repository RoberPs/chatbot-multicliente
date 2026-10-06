/**
 * Contrato de "Probar el bot" (004 US1, contracts/admin-web-channel.md): sesión, CSRF,
 * validación del texto, fragmentos de htmx y la información técnica de cada respuesta.
 */
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { business, message } from '../../../src/db/schema.js';
import {
  buildTestApp,
  cookieHeader,
  csrfFrom,
  encodeForm,
  get,
  login,
  postForm,
  type Session,
} from '../../helpers/app.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';

const HTMX = { 'hx-request': 'true' };

const MAP_URL = 'https://maps.example.com/@40.41,-3.70,17z?q=Plaza+Mayor&z=1';
/** Tal como sale en el HTML: Eta escapa el `&`. */
const MAP_URL_HTML = MAP_URL.replace('&', '&amp;');
const OPERATOR_URL = 'https://otra.example.com/sitio';

const pollUrl = (html: string): string => {
  const match = /hx-get="(\/admin\/playground\/messages\?after=[^"]*)"/.exec(html);
  if (!match?.[1]) throw new Error('El fragmento no trae el indicador de sondeo');
  return match[1];
};

describe('Probar el bot (/admin/playground)', () => {
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

  /** Guarda la cookie que devuelva el servidor: la sesión lleva el `playgroundId`. */
  const keep = (res: LightMyRequestResponse): LightMyRequestResponse => {
    const cookie = cookieHeader(res);
    if (cookie) session = { ...session, cookie };
    return res;
  };

  /** Bot con el modelo falso, sesión de operador y la página abierta (crea el `playgroundId`). */
  async function start(opts: { activate?: boolean } = {}): Promise<TestBot> {
    bot = await createTestBot(t, opts);
    app = bot.app;
    session = await login(app);
    const page = keep(await get(app, session, '/admin/playground'));
    session = { ...session, csrf: csrfFrom(page.body) };
    return bot;
  }

  const send = async (text: string, headers: Record<string, string> = {}) =>
    keep(await postForm(app, session, '/admin/playground/messages', { text }, headers));

  const outbound = () => t.db.select().from(message);

  it('sin sesión las cuatro rutas redirigen al login y no se guarda nada (US1-7)', async () => {
    const b = await createTestBot(t);
    bot = b;
    const anon = { cookie: '', csrf: 'x' };
    const routes: Array<[string, string]> = [
      ['GET', '/admin/playground'],
      ['GET', '/admin/playground/messages?after='],
      ['POST', '/admin/playground/messages'],
      ['POST', '/admin/playground/reset'],
    ];
    for (const [method, url] of routes) {
      const res = await b.app.inject({
        method: method as 'GET' | 'POST',
        url,
        ...(method === 'POST'
          ? {
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              payload: encodeForm({ _csrf: anon.csrf, text: 'Hola' }),
            }
          : {}),
      });
      expect([url, res.statusCode, res.headers.location]).toEqual([url, 302, '/admin/login']);
    }
    // Con htmx, 401 + HX-Redirect en lugar de la redirección.
    const htmx = await b.app.inject({ method: 'GET', url: '/admin/playground', headers: HTMX });
    expect(htmx.statusCode).toBe(401);
    expect(htmx.headers['hx-redirect']).toBe('/admin/login');
    expect(await outbound()).toHaveLength(0);
  });

  it('POST sin token CSRF → 403 y no guarda (FR-013)', async () => {
    await start();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/playground/messages',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: encodeForm({ text: 'Hola' }),
    });
    expect(res.statusCode).toBe(403);
    expect(await outbound()).toHaveLength(0);
  });

  it('texto vacío o de más de 1 000 caracteres → 422 sin guardar', async () => {
    await start();
    const empty = await send('   ');
    expect(empty.statusCode).toBe(422);
    expect(empty.body).toContain('Escribe un mensaje');
    const long = await send('a'.repeat(1001));
    expect(long.statusCode).toBe(422);
    expect(long.body).toContain('El mensaje no puede pasar de 1 000 caracteres');
    expect(await outbound()).toHaveLength(0);
    // Justo en el límite sí se acepta.
    expect((await send('a'.repeat(1000))).statusCode).toBe(303);
  });

  it('con htmx devuelve el mensaje y el indicador; sin htmx, 303', async () => {
    const b = await start();
    const res = await send('¿A qué hora abrís?', HTMX);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('¿A qué hora abrís?');
    expect(res.body).toContain('hx-trigger="every 1s"');
    expect(pollUrl(res.body)).toMatch(/^\/admin\/playground\/messages\?after=.+/);

    const plain = await send('¿Y los sábados?');
    expect(plain.statusCode).toBe(303);
    expect(plain.headers.location).toBe('/admin/playground');
    await b.settle();
  });

  it('GET messages devuelve 204 hasta que llega la respuesta y luego el fragmento sin sondeo', async () => {
    const b = await start();
    b.model.queue(reply('Abrimos de martes a sábado.'));
    const posted = await send('¿A qué hora abrís?', HTMX);
    const poll = pollUrl(posted.body);

    const waiting = keep(await get(app, session, poll, HTMX));
    expect(waiting.statusCode).toBe(204);
    expect(waiting.body).toBe('');

    await b.settle();
    const arrived = keep(await get(app, session, poll, HTMX));
    expect(arrived.statusCode).toBe(200);
    expect(arrived.body).toContain('Abrimos de martes a sábado.');
    expect(arrived.body).not.toContain('hx-trigger');
    // La información técnica acompaña a la respuesta (FR-009).
    expect(arrived.body).toContain('Saludo añadido');
    expect(arrived.body).toContain('Sin rechazos');
    expect(arrived.body).toMatch(/Respondió en \d+,\d s/);
  });

  it('el enlace https:// de la respuesta se puede pulsar; el del operador, no (FR-020a)', async () => {
    const b = await start();
    // El verificador solo deja pasar enlaces registrados: se guarda el enlace a mapa (003).
    await t.db.update(business).set({ mapUrl: MAP_URL });
    b.model.queue(reply(`Estamos en Calle Mayor 1. Ubicación: ${MAP_URL}.`));
    const posted = await send(`¿Es aquí? ${OPERATOR_URL}`, HTMX);
    await b.settle();
    const arrived = keep(await get(app, session, pollUrl(posted.body), HTMX));
    expect(arrived.statusCode).toBe(200);
    expect(arrived.body).toContain(
      `<a href="${MAP_URL_HTML}" target="_blank" rel="noopener noreferrer nofollow">${MAP_URL_HTML}</a>.`,
    );

    const page = keep(await get(app, session, '/admin/playground'));
    expect(page.body).toContain(`¿Es aquí? ${OPERATOR_URL}`);
    expect(page.body).not.toContain(`href="${OPERATOR_URL}"`);
  });

  it('cursor no emitido por el servidor → 400', async () => {
    await start();
    const res = await get(app, session, '/admin/playground/messages?after=no-es-un-cursor', HTMX);
    expect(res.statusCode).toBe(400);
  });

  it('"Nueva conversación" vacía la página (FR-010)', async () => {
    const b = await start();
    b.model.queue(reply('Abrimos de martes a sábado.'));
    await send('¿A qué hora abrís?', HTMX);
    await b.settle();
    expect(keep(await get(app, session, '/admin/playground')).body).toContain(
      'Abrimos de martes a sábado.',
    );

    const res = keep(await postForm(app, session, '/admin/playground/reset'));
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/admin/playground');
    const page = keep(await get(app, session, '/admin/playground'));
    expect(page.body).not.toContain('Abrimos de martes a sábado.');
  });

  it('negocio en preparación: aviso fijo y el formulario sigue activo (FR-011)', async () => {
    await start({ activate: false });
    const page = keep(await get(app, session, '/admin/playground'));
    expect(page.body).toContain(
      'El negocio está en preparación: los clientes reales no reciben respuesta hasta que lo ' +
        'actives. Aquí puedes probarlo igualmente.',
    );
    expect(page.body).not.toContain('disabled');
    expect((await send('¿Abrís hoy?')).statusCode).toBe(303);
  });

  it('sin bot: aviso de clave ausente, formulario deshabilitado y las escrituras no guardan', async () => {
    bot = await createTestBot(t);
    const noBot = await buildTestApp(t.db, undefined, null);
    try {
      let noBotSession = await login(noBot);
      const page = await get(noBot, noBotSession, '/admin/playground');
      const cookie = cookieHeader(page);
      noBotSession = {
        cookie: cookie ?? noBotSession.cookie,
        csrf: csrfFrom(page.body),
      };
      expect(page.body).toContain(
        'Falta la clave del modelo de lenguaje (ANTHROPIC_API_KEY) en la configuración de la instancia',
      );
      expect(page.body).toContain('disabled');
      const res = await postForm(noBot, noBotSession, '/admin/playground/messages', {
        text: 'Hola',
      });
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('Falta la clave del modelo de lenguaje');
      expect(await outbound()).toHaveLength(0);
    } finally {
      await noBot.close();
    }
  });

  it('la información técnica no muestra los valores rechazados por el verificador (garantía 6)', async () => {
    const b = await start();
    // El primer borrador trae una hora que no está registrada: el verificador lo rechaza.
    b.model.queue(reply('Abrimos a las 7:45.'), reply('Te lo confirma el equipo.'));
    await send('¿A qué hora abrís?', HTMX);
    await b.settle();
    const page = keep(await get(app, session, '/admin/playground')).body;
    expect(page).toContain('El verificador rechazó 1 borrador');
    expect(page).toContain('Te lo confirma el equipo.');
    expect(page).not.toContain('7:45');
  });

  /** Deriva la conversación de prueba: pide los datos y luego los recibe (005). */
  async function derive(b: TestBot) {
    b.model.queue(
      reply('De acuerdo.', { handoffRequested: true }),
      reply('Gracias.', { contactName: 'Operador', contactPhone: '612 345 678' }),
    );
    b.summarizer.queue({ summary: 'Quiere hablar con una persona.' });
    await send('Quiero hablar con una persona', HTMX);
    await b.settle();
    await send('Operador, 612 345 678', HTMX);
    await b.settle();
  }

  it('la respuesta que inicia la derivación muestra "Derivación iniciada (simulada)" y el aviso plegable (005)', async () => {
    const b = await start();
    await derive(b);
    const page = keep(await get(app, session, '/admin/playground')).body;
    expect(page).toContain(
      'Derivación iniciada (simulada) · quiere hablar con una persona · vías: simulada enviada',
    );
    expect(page).toMatch(
      /<details class="handoff-notice">\s*<summary>Aviso al negocio \(simulado\)<\/summary>\s*<pre>Derivación: Operador \(quiere hablar con una persona\)/,
    );
    expect(page).toContain('Pide los datos de contacto');
  });

  it('con la conversación derivada: aviso fijo, sin "escribiendo" y reenvío simulado (005, US3)', async () => {
    const b = await start();
    await derive(b);
    const sent = await send('Una cosa más: llego tarde', HTMX);
    // Sin indicador de sondeo: no hay respuesta que esperar mientras dura la derivación.
    expect(sent.body).not.toContain('playground-poll');
    await b.settle();

    const page = keep(await get(app, session, '/admin/playground')).body;
    expect(page).toContain('id="playground-handoff"');
    expect(page).toContain('el negocio contactará en el teléfono dado (+34 612 34 56 78)');
    expect(page).toMatch(
      /Una cosa más: llego tarde<\/p>\s*<details class="handoff-notice">\s*<summary>Reenviado al negocio \(simulado\)<\/summary>/,
    );
    // El bot no ha contestado al mensaje reenviado.
    expect(b.model.calls).toHaveLength(2);
  });
});
