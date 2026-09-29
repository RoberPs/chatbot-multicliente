/** Página "Derivaciones" del panel: destinos de los avisos al negocio (005, FR-020, R16). */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readHandoffAlerts } from '../../../src/handoff/settings.js';
import { buildTestApp, get, hasFieldError, login, postForm, type Session } from '../../helpers/app.js';
import { createTestDatabase, resetDb, setHandoffAlerts, type TestDatabase } from '../../helpers/db.js';

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
    expect(res.body).toMatch(/href="\/admin\/handoff">Derivación<\/a>\s*<a href="\/admin\/handoffs" aria-current="page">Derivaciones<\/a>/);
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
    expect(hasFieldError(res.body, 'Indica un teléfono válido, con prefijo si no es de España')).toBe(true);
    expect(hasFieldError(res.body, 'Indica un email válido')).toBe(true);
    // Se vuelven a pintar los valores introducidos.
    expect(res.body).toContain('value="no-es-un-email"');
    expect(await readHandoffAlerts(t.db)).toEqual({ whatsapp: null, email: 'antes@negocio.es' });
  });
});
