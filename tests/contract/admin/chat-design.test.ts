/**
 * Contrato de la sección "Diseño del chat" del panel (011, contracts/admin-chat-design.md):
 * sesión y CSRF, formulario, guardado todo o nada, vista previa y sus cabeceras.
 */
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chatDesign } from '../../../src/db/schema.js';
import { readWebChatSettings } from '../../../src/webchat/settings.js';
import {
  cookieHeader,
  encodeForm,
  get,
  hasFieldError,
  login,
  postForm,
  type Session,
} from '../../helpers/app.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import {
  designForm,
  designImages,
  designRow,
  GREEN_FORM,
  GREEN_PALETTE,
  loadImageFixture,
  postDesign,
  seedChatDesign,
} from '../../helpers/chat-design.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const ORIGIN = 'https://negocio.example';
const WEB_ON = { enabled: true, allowedOrigins: [ORIGIN], privacyUrl: `${ORIGIN}/privacidad` };

const PREVIEW_CSP =
  "default-src 'none'; style-src 'self'; img-src 'self' blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

describe('Diseño del chat (/admin/chat-design)', () => {
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

  async function start(opts: Parameters<typeof createTestBot>[1] = {}): Promise<TestBot> {
    bot = await createTestBot(t, opts);
    app = bot.app;
    session = await login(app);
    return bot;
  }

  /** La cookie nueva lleva el aviso del guardado. */
  const keepCookie = (res: { headers: Record<string, unknown> }) => {
    const cookie = cookieHeader(res as never);
    if (cookie) session = { ...session, cookie };
  };

  describe('sesión y CSRF', () => {
    it('sin sesión: 302 al login (o 401 + HX-Redirect) y no guarda nada (US1-8)', async () => {
      await start();
      for (const url of ['/admin/chat-design', '/admin/chat-design/preview', '/admin/chat-design/preview.css']) {
        const res = await app.inject({ method: 'GET', url });
        expect([url, res.statusCode, res.headers.location]).toEqual([url, 302, '/admin/login']);
      }
      const htmx = await app.inject({
        method: 'GET',
        url: '/admin/chat-design',
        headers: { 'hx-request': 'true' },
      });
      expect(htmx.statusCode).toBe(401);
      expect(htmx.headers['hx-redirect']).toBe('/admin/login');

      const post = await app.inject({
        method: 'POST',
        url: '/admin/chat-design',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: encodeForm(designForm(GREEN_FORM)),
      });
      expect(post.statusCode).toBe(302);
      expect(await designRow(t.db)).toBeUndefined();
    });

    it('POST sin CSRF → 403 y nada guardado', async () => {
      await start();
      const res = await app.inject({
        method: 'POST',
        url: '/admin/chat-design',
        headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: encodeForm(designForm(GREEN_FORM)),
      });
      expect(res.statusCode).toBe(403);
      const multipart = await postDesign(app, { ...session, csrf: 'no-vale' }, designForm(GREEN_FORM));
      expect(multipart.statusCode).toBe(403);
      expect(await designRow(t.db)).toBeUndefined();
    });
  });

  describe('página', () => {
    it('sin diseño: los valores originales y "El chat usa el aspecto original" (US1-1)', async () => {
      await start();
      const res = await get(app, session, '/admin/chat-design');
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('value="#1f5fbf"');
      expect(res.body).toContain('El chat usa el aspecto original');
      expect(res.body).toMatch(/name="shape" value="round"[^>]*checked/);
      expect(res.body).toContain('data-default="Asistente de Peluquería Tijeras"');
      // Responsabilidad del operador, junto a los textos (Principio IV).
      expect(res.body).toContain('el asistente no los usa para responder');
      // Sin campos para el aviso ni la privacidad (US2-5).
      expect(res.body).not.toMatch(/name="privacy/);
    });

    it('con diseño: los valores guardados', async () => {
      await start();
      await seedChatDesign(t.db, { ...GREEN_PALETTE, shape: 'soft', chatName: 'Recepción' });
      const res = await get(app, session, '/admin/chat-design');
      expect(res.body).toContain('value="#0b6e4f"');
      expect(res.body).toMatch(/name="shape" value="soft"[^>]*checked/);
      expect(res.body).toContain('value="Recepción"');
      expect(res.body).not.toContain('El chat usa el aspecto original');
    });

    it('"Diseño del chat" aparece en la navegación justo después de "Chat web"', async () => {
      await start();
      const res = await get(app, session, '/admin');
      expect(res.body).toMatch(
        /<a href="\/admin\/web-chat"[^>]*>Chat web<\/a>\s*<a href="\/admin\/chat-design"[^>]*>Diseño del chat<\/a>/,
      );
    });

    it('avisa de los campos guardados que ya no se admiten (R13)', async () => {
      await start();
      await t.db.insert(chatDesign).values({
        ...GREEN_PALETTE,
        shape: 'round',
        position: 'right',
        size: 'huge',
      });
      const res = await get(app, session, '/admin/chat-design');
      expect(res.body).toContain('El tamaño guardado ya no se admite; el chat usa el original');
      expect(res.body.indexOf('ya no se admite')).toBeLessThan(res.body.indexOf('id="chat-design-form"'));
    });
  });

  describe('guardar', () => {
    it('urlencoded válido → 303 con el aviso y lo guardado', async () => {
      await start();
      const res = await postForm(
        app,
        session,
        '/admin/chat-design',
        designForm({ ...GREEN_FORM, chat_name: 'Recepción', welcome_text: 'Hola\r\nQué tal' }),
      );
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/admin/chat-design');
      keepCookie(res);
      const page = await get(app, session, '/admin/chat-design');
      expect(page.body).toContain('Diseño del chat guardado');
      expect(await designRow(t.db)).toMatchObject({
        primaryColor: '#0b6e4f',
        chatName: 'Recepción',
        welcomeText: 'Hola\nQué tal',
      });
    });

    it('multipart sin ficheros → 303; con htmx → 200 + HX-Location', async () => {
      await start();
      const res = await postDesign(app, session, designForm({ shape: 'square' }));
      expect(res.statusCode).toBe(303);
      expect((await designRow(t.db))?.shape).toBe('square');
      const htmx = await postDesign(app, session, designForm({ shape: 'soft' }), [], {
        headers: { 'hx-request': 'true' },
      });
      expect(htmx.statusCode).toBe(200);
      expect(htmx.headers['hx-location']).toBe('/admin/chat-design');
      expect((await designRow(t.db))?.shape).toBe('soft');
    });

    it('con un texto demasiado largo y una opción no válida → 422 con ambos errores y lo escrito', async () => {
      await start();
      const res = await postDesign(
        app,
        session,
        designForm({ ...GREEN_FORM, chat_name: 'x'.repeat(41), size: 'huge', placeholder: 'Pregunta' }),
      );
      expect(res.statusCode).toBe(422);
      expect(hasFieldError(res.body, 'Máximo 40 caracteres')).toBe(true);
      expect(hasFieldError(res.body, 'Opción no válida')).toBe(true);
      expect(res.body).toContain(`value="${'x'.repeat(41)}"`);
      expect(res.body).toContain('value="Pregunta"');
      expect(res.body).toContain('value="#0b6e4f"');
      expect(await designRow(t.db)).toBeUndefined();
    });

    it('guardar no cambia la configuración del chat web (FR-014)', async () => {
      await start({ webChat: WEB_ON, activate: false });
      const before = await readWebChatSettings(t.db);
      const res = await postDesign(app, session, designForm(GREEN_FORM));
      expect(res.statusCode).toBe(303);
      expect(await readWebChatSettings(t.db)).toEqual(before);
    });
  });

  describe('contraste (US2)', () => {
    it('POST con contraste insuficiente → 422 con la pareja, la razón y el mínimo; nada cambia', async () => {
      await start();
      await seedChatDesign(t.db, { ...GREEN_PALETTE, chatName: 'Antes' });
      const before = await designRow(t.db);
      const res = await postDesign(
        app,
        session,
        designForm({ ...GREEN_FORM, text_color: '#aaaaaa', chat_name: 'Después' }),
      );
      expect(res.statusCode).toBe(422);
      expect(res.body).toMatch(
        /El texto del chat sobre el fondo tiene un contraste de \d,\d{2}:1; el mínimo es 4,5:1/,
      );
      expect(await designRow(t.db)).toEqual(before);
    });

    it('sin JavaScript también: un urlencoded con contraste insuficiente se rechaza (US2-3)', async () => {
      await start();
      const res = await postForm(app, session, '/admin/chat-design', designForm({ primary_color: '#ff8800' }));
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('El color principal frente al fondo del chat tiene un contraste de');
      expect(await designRow(t.db)).toBeUndefined();
    });

    it('POST /check: un contenedor por control, vacío si cumple, sin guardar', async () => {
      await start();
      const ok = await postForm(app, session, '/admin/chat-design/check', designForm(GREEN_FORM));
      expect(ok.statusCode).toBe(200);
      for (const field of ['primary_color', 'on_primary_color', 'background_color', 'text_color', 'bot_bubble_color']) {
        expect(ok.body).toMatch(new RegExp(`<span id="contrast-${field}" class="contrast-issues" hx-swap-oob="true" role="status"></span>`));
      }
      const bad = await postForm(
        app,
        session,
        '/admin/chat-design/check',
        designForm({ text_color: '#aaaaaa', primary_color: 'azul' }),
      );
      expect(bad.statusCode).toBe(200);
      expect(bad.body).toMatch(/id="contrast-text_color"[^>]*>El texto del chat sobre el fondo tiene un contraste de 2,\d{2}:1; el mínimo es 4,5:1/);
      expect(bad.body).toMatch(/id="contrast-primary_color"[^>]*>Indica un color opaco en formato #RRGGBB/);
      expect(await designRow(t.db)).toBeUndefined();
    });

    it('POST /check multipart con un fichero responde igual y no guarda la imagen', async () => {
      await start();
      const res = await postDesign(
        app,
        session,
        designForm({ text_color: '#aaaaaa' }),
        [{ name: 'logo', bytes: loadImageFixture('valid.png') }],
        { url: '/admin/chat-design/check' },
      );
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('El texto del chat sobre el fondo tiene un contraste de');
      expect(await designRow(t.db)).toBeUndefined();
      expect(await designImages(t.db)).toEqual({});
    });

    it('campos inventados para el aviso o la privacidad no tienen efecto (US2-5)', async () => {
      await start({ webChat: WEB_ON });
      const res = await postDesign(
        app,
        session,
        designForm({ ...GREEN_FORM, privacy_notice: '', hide_privacy: '1', notice_text: 'Nada' }),
      );
      expect(res.statusCode).toBe(303);
      const frame = await app.inject({ method: 'GET', url: '/chat/frame' });
      expect(frame.body).toContain('Estás hablando con el asistente automático de Peluquería Tijeras');
      expect(frame.body).toContain('Política de privacidad');
      expect(frame.body).not.toContain('Nada');
    });
  });

  describe('vista previa', () => {
    const counts = async () => {
      const rows = await t.db.execute<{ n: string }>(sql`
        select (select count(*) from conversation) + (select count(*) from customer)
             + (select count(*) from message) + (select count(*) from model_usage)
             + (select count(*) from web_usage_day) as n`);
      return Number(rows.rows[0]?.n);
    };

    it('abierta: las mismas parciales que el frame, conversación de ejemplo, sin scripts', async () => {
      await start({ webChat: WEB_ON });
      await seedChatDesign(t.db, { ...GREEN_PALETTE, welcomeText: 'Bienvenida' });
      const before = await counts();
      const res = await get(app, session, '/admin/chat-design/preview?view=open');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-security-policy']).toBe(PREVIEW_CSP);
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain('/chat/assets/frame.css');
      expect(res.body).toContain('id="chat-design-css"');
      expect(res.body).toContain('class="panel-head"');
      expect(res.body).toContain('Estás hablando con el asistente automático de Peluquería Tijeras');
      expect(res.body).toContain('<li class="welcome">Bienvenida</li>');
      expect(res.body).toContain('Conversación de ejemplo');
      expect(res.body).toContain('data-sample');
      expect(res.body).toContain('id="chat-text"');
      expect(res.body).not.toContain('<script');
      expect(res.body).not.toContain('/chat/api');
      expect(await counts()).toBe(before);
    });

    it('cerrada: solo el botón flotante; un view desconocido es "open"', async () => {
      await start({ webChat: WEB_ON });
      const closed = await get(app, session, '/admin/chat-design/preview?view=closed');
      expect(closed.body).toContain('id="chat-toggle"');
      expect(closed.body).not.toContain('class="panel-head"');
      const other = await get(app, session, '/admin/chat-design/preview?view=otro');
      expect(other.body).toContain('class="panel-head"');
    });

    it('funciona con el chat desactivado y el negocio en preparación (FR-010)', async () => {
      await start({ activate: false });
      const res = await get(app, session, '/admin/chat-design/preview?view=open');
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Conversación de ejemplo');
      expect(res.body).not.toContain('no está disponible');
    });

    it('preview.css usa las opciones de la consulta y el original si no valen', async () => {
      await start();
      const res = await get(
        app,
        session,
        '/admin/chat-design/preview.css?primary_color=%23ff0000&shape=soft',
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/css; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain('--chat-accent: #ff0000;');
      expect(res.body).toContain('--chat-radius-panel: 6px;');
      const bad = await get(app, session, '/admin/chat-design/preview.css?primary_color=rojo&shape=x');
      expect(bad.statusCode).toBe(200);
      expect(bad.body).toBe('');
    });
  });
});
