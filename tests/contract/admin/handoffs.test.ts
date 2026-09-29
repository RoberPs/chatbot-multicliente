/** Página "Derivaciones" del panel: destinos de los avisos al negocio (005, FR-020, R16). */
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handoff } from '../../../src/db/schema.js';
import { readHandoffAlerts } from '../../../src/handoff/settings.js';
import {
  buildTestApp,
  cookieHeader,
  get,
  hasFieldError,
  login,
  postForm,
  type Session,
} from '../../helpers/app.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import {
  createTestDatabase,
  resetDb,
  setHandoffAlerts,
  type TestDatabase,
} from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';

const SMTP_ENV = {
  SMTP_URL: 'smtps://usuario:clave@smtp.ejemplo.com:465',
  SMTP_FROM: 'bot@ejemplo.com',
  PUBLIC_BASE_URL: 'https://bot.ejemplo.com',
};

const codesIn = (html: string) => [...html.matchAll(/data-code="([A-Z_]+)"/g)].map((m) => m[1]);
const routeState = (html: string, label: string) =>
  new RegExp(`data-route="${label}" data-state="([a-z]+)"`).exec(html)?.[1];

describe('GET/POST /admin/handoffs (destinos de avisos)', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;

  beforeAll(async () => {
    t = await createTestDatabase();
    // Instancia con SMTP y URL pública, pero sin canal de WhatsApp.
    app = await buildTestApp(t.db, undefined, null, SMTP_ENV);
    session = await login(app);
  });
  beforeEach(async () => {
    await resetDb(t.db);
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it('exige sesión', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/handoffs' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/admin/login');
  });

  it('sin destinos: las dos vías sin configurar y HANDOFF_ALERTS_NONE', async () => {
    const res = await get(app, session, '/admin/handoffs');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Avisos al negocio');
    expect(routeState(res.body, 'WhatsApp')).toBe('none');
    expect(routeState(res.body, 'Email')).toBe('none');
    expect(codesIn(res.body)).toContain('HANDOFF_ALERTS_NONE');
    // Enlace en la navegación, después de "Derivación", y marcado como actual.
    expect(res.body).toMatch(
      /href="\/admin\/handoff">Derivación<\/a>\s*<a href="\/admin\/handoffs" aria-current="page">Derivaciones<\/a>/,
    );
  });

  it('WhatsApp sin canal en la instancia → "Configurado, pero…" con lo que falta; email disponible → SINGLE', async () => {
    await setHandoffAlerts(t.db, { whatsapp: '+34611000111', email: 'avisos@negocio.es' });
    const res = await get(app, session, '/admin/handoffs');
    expect(routeState(res.body, 'WhatsApp')).toBe('blocked');
    expect(res.body).toContain('Configurado, pero esta instancia no puede enviar por esta vía');
    expect(res.body).toContain('WHATSAPP_*');
    expect(routeState(res.body, 'Email')).toBe('ok');
    expect(codesIn(res.body)).toEqual(expect.arrayContaining(['HANDOFF_ALERTS_SINGLE']));
  });

  it('POST sin CSRF → rechazado y sin cambios', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/handoffs/alerts',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=avisos%40negocio.es',
    });
    expect(res.statusCode).toBe(403);
    expect(await readHandoffAlerts(t.db)).toEqual({ whatsapp: null, email: null });
  });

  it('POST válido → 303 y guardado normalizado', async () => {
    const res = await postForm(app, session, '/admin/handoffs/alerts', {
      whatsapp: '611 000 111',
      email: '  Avisos@Negocio.ES ',
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/admin/handoffs');
    expect(await readHandoffAlerts(t.db)).toEqual({
      whatsapp: '+34611000111',
      email: 'avisos@negocio.es',
    });
  });

  it('teléfono o email no válidos → 422 con errores por campo y la BD sin cambios', async () => {
    await setHandoffAlerts(t.db, { email: 'antes@negocio.es' });
    const res = await postForm(app, session, '/admin/handoffs/alerts', {
      whatsapp: '123',
      email: 'no-es-un-email',
    });
    expect(res.statusCode).toBe(422);
    expect(
      hasFieldError(res.body, 'Indica un teléfono válido, con prefijo si no es de España'),
    ).toBe(true);
    expect(hasFieldError(res.body, 'Indica un email válido')).toBe(true);
    // Se vuelven a pintar los valores introducidos.
    expect(res.body).toContain('value="no-es-un-email"');
    expect(await readHandoffAlerts(t.db)).toEqual({ whatsapp: null, email: 'antes@negocio.es' });
  });
});

describe('Derivaciones activas (US4, FR-016a)', () => {
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

  /** Una derivación de WhatsApp (motivo con una palabra marcada) y otra del playground. */
  async function withHandoffs(): Promise<{ b: TestBot; session: Session }> {
    const b = (bot = await createTestBot(t, {
      handoffAlerts: { whatsapp: '+34611000111', email: 'avisos@negocio.es' },
    }));
    b.model.queue(
      reply('De acuerdo.', { handoffRequested: true }),
      reply('De acuerdo.', { handoffRequested: true }),
      reply('Gracias.', { contactName: 'Operador', contactPhone: '612 345 678' }),
    );
    b.summarizer.queue({ summary: 'Pregunta por MARCADOSECRETO.' });
    await b.send('Quiero hablar con una persona');
    await b.settle();
    await b.sendVia('playground', 'Quiero hablar con una persona');
    await b.settle();
    await b.sendVia('playground', 'Operador, 612 345 678');
    await b.settle();
    expect(await t.db.select().from(handoff)).toHaveLength(2);
    return { b, session: await login(b.app) };
  }

  const activeIds = (html: string) =>
    [...html.matchAll(/data-handoff="([0-9a-f-]+)"/g)].map((m) => m[1] ?? '');

  it('tabla sin el motivo y sin las del playground; la portada cuenta las activas', async () => {
    const { b, session } = await withHandoffs();
    const page = await get(b.app, session, '/admin/handoffs');
    expect(activeIds(page.body)).toHaveLength(1);
    expect(page.body).toContain('Cliente (+34 600 11 12 22)');
    expect(page.body).toContain('WhatsApp');
    expect(page.body).toContain('quiere hablar con una persona');
    expect(page.body).not.toContain('MARCADOSECRETO');
    expect(page.body).not.toContain('Operador');
    const home = await get(b.app, session, '/admin');
    expect(home.body).toContain('Derivaciones activas: 1');
  });

  it('POST end con CSRF termina; la segunda vez "ya había terminado"; id inexistente → 404', async () => {
    const { b, session } = await withHandoffs();
    const [id] = activeIds((await get(b.app, session, '/admin/handoffs')).body);
    const url = `/admin/handoffs/${id}/end`;

    const noCsrf = await b.app.inject({
      method: 'POST',
      url,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(noCsrf.statusCode).toBe(403);

    /** El flash viaja en la cookie de sesión: se usa la que devuelve cada respuesta. */
    const keep = (res: { headers: Record<string, unknown> }) => {
      const cookie = cookieHeader(res as Parameters<typeof cookieHeader>[0]);
      if (cookie) session.cookie = cookie;
    };
    const res = await postForm(b.app, session, url);
    expect(res.statusCode).toBe(303);
    keep(res);
    const after = await get(b.app, session, '/admin/handoffs');
    expect(after.body).toContain(
      'Derivación terminada; el asistente vuelve a atender a Cliente.',
    );
    expect(activeIds(after.body)).toEqual([]);
    expect(b.log.named('handoff_ended')).toEqual([
      expect.objectContaining({ cause: 'operator', confirmed: false }),
    ]);
    // Ningún mensaje al cliente (FR-018).
    expect(b.sender.sent).toHaveLength(1);

    keep(after);
    keep(await postForm(b.app, session, url));
    expect((await get(b.app, session, '/admin/handoffs')).body).toContain(
      'Esa derivación ya había terminado.',
    );
    const missing = await postForm(
      b.app,
      session,
      '/admin/handoffs/00000000-0000-4000-8000-000000000000/end',
    );
    expect(missing.statusCode).toBe(404);
  });

  it('con htmx la respuesta sustituye la fila (vacía)', async () => {
    const { b, session } = await withHandoffs();
    const [id] = activeIds((await get(b.app, session, '/admin/handoffs')).body);
    const res = await postForm(b.app, session, `/admin/handoffs/${id}/end`, {}, {
      'hx-request': 'true',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
  });
});
