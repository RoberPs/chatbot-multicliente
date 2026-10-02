/**
 * Contrato del diseño en el chat web público (011, contracts/chat-design-http.md).
 *
 * No regresión (FR-015, SC-006): sin diseño guardado, `GET /chat/frame` es el HTML de la 004,
 * capturado antes de esta feature en `tests/fixtures/web-chat/frame-004.html` (chat disponible) y
 * `frame-004-unavailable.html` (chat desactivado), con el negocio y la configuración de
 * `web-chat-frame.test.ts`. El frame no tiene partes variables (ni token de sesión, ni fechas, ni
 * nonce): solo se normaliza el espacio en blanco, que cambia al pintarlo con parciales
 * (`normalize`: sin espacios entre etiquetas y cada racha de espacios reducida a uno).
 */
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { modelPrice, modelUsage, usageSettings, webUsageDay } from '../../src/db/schema.js';
import { createTestBot, TEST_LLM_MODEL, type TestBot } from '../helpers/bot.js';
import { GREEN_PALETTE, seedChatDesign } from '../helpers/chat-design.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const ORIGIN = 'https://negocio.example';
const WEB_ON = {
  enabled: true,
  allowedOrigins: [ORIGIN],
  privacyUrl: `${ORIGIN}/privacidad`,
};

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/web-chat/${name}`, import.meta.url), 'utf8');

/** Espacio en blanco normalizado (ver la cabecera del fichero). */
const normalize = (html: string): string =>
  html
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();

describe('diseño del chat web: frame sin diseño', () => {
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

  const frame = (app: FastifyInstance) => app.inject({ method: 'GET', url: '/chat/frame' });

  it('sin fila en chat_design el frame es idéntico al de la 004 (disponible)', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    const res = await frame(bot.app);
    expect(res.statusCode).toBe(200);
    expect(normalize(res.body)).toBe(normalize(fixture('frame-004.html')));
    expect(res.body).not.toContain('design.css');
    expect(res.body).not.toMatch(/<html[^>]*data-/);
    expect(res.body).not.toContain('class="design-');
  });

  it('sin fila en chat_design el frame "no disponible" es idéntico al de la 004', async () => {
    bot = await createTestBot(t);
    const res = await frame(bot.app);
    expect(normalize(res.body)).toBe(normalize(fixture('frame-004-unavailable.html')));
    expect(res.body).not.toContain('design.css');
  });
});

describe('diseño del chat web: frame con diseño (US1)', () => {
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

  const frame = (app: FastifyInstance) => app.inject({ method: 'GET', url: '/chat/frame' });

  it('aplica colores, nombre, bienvenida, ayuda y Enviar (US1-2, US1-3)', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    await seedChatDesign(t.db, {
      ...GREEN_PALETTE,
      chatName: 'Atención al cliente',
      welcomeText: 'Pregúntame por horarios.\nTe respondo al momento.',
      placeholder: '¿En qué te ayudo?',
      sendLabel: 'Mandar',
    });
    const res = await frame(bot.app);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/<html lang="es" data-palette="custom">/);
    const css = res.body.indexOf('<link rel="stylesheet" href="/chat/design.css?v=');
    expect(css).toBeGreaterThan(res.body.indexOf('/chat/assets/frame.css'));
    expect(res.body).toContain('<h1>Atención al cliente</h1>');
    // La bienvenida es el primer elemento de la lista, con sus saltos de línea.
    expect(res.body).toMatch(
      /<ul id="chat-messages" class="messages" aria-live="polite">\s*<li class="welcome">Pregúntame por horarios.\nTe respondo al momento.<\/li>/,
    );
    expect(res.body).toContain('placeholder="¿En qué te ayudo?"');
    expect(res.body).toMatch(/<button type="submit">Mandar<\/button>/);
    // El aviso y la privacidad no cambian (FR-021).
    expect(res.body).toContain('Estás hablando con el asistente automático de Peluquería Tijeras');
    expect(res.body).toContain(`${ORIGIN}/privacidad`);
  });

  it('los textos del operador salen escapados (US1-6)', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    await seedChatDesign(t.db, {
      chatName: '<b>hola</b> {{ x }}',
      welcomeText: '<script>alert(1)</script>',
      placeholder: '"><img src=x onerror=alert(1)>',
      sendLabel: '<i>Ir</i>',
    });
    const res = await frame(bot.app);
    expect(res.body).toContain('<h1>&lt;b&gt;hola&lt;/b&gt; {{ x }}</h1>');
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.body).not.toContain('<script>alert(1)');
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('&lt;i&gt;Ir&lt;/i&gt;');
  });

  it('con los textos vacíos, los valores por defecto (US1-4)', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    await seedChatDesign(t.db, GREEN_PALETTE);
    const res = await frame(bot.app);
    expect(res.body).toContain('<h1>Asistente de Peluquería Tijeras</h1>');
    expect(res.body).toContain('placeholder="Escribe tu mensaje"');
    expect(res.body).toMatch(/<button type="submit">Enviar<\/button>/);
    expect(res.body).not.toContain('class="welcome"');
  });

  it('la CSP y Cache-Control del frame no cambian con diseño', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    const before = await frame(bot.app);
    await seedChatDesign(t.db, { ...GREEN_PALETTE, shape: 'square' });
    const after = await frame(bot.app);
    expect(after.headers['content-security-policy']).toBe(before.headers['content-security-policy']);
    expect(after.headers['cache-control']).toBe('no-store');
    expect(after.headers['x-frame-options']).toBeUndefined();
  });

  it('GET /chat/design.css: vacío sin diseño y con los tokens con diseño, sin caché', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    const empty = await bot.app.inject({ method: 'GET', url: '/chat/design.css?v=abc' });
    expect(empty.statusCode).toBe(200);
    expect(empty.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(empty.headers['cache-control']).toBe('no-store');
    expect(empty.body).toBe('');

    await seedChatDesign(t.db, { ...GREEN_PALETTE, shape: 'soft' });
    const full = await bot.app.inject({ method: 'GET', url: '/chat/design.css' });
    expect(full.body).toContain('--chat-accent: #0b6e4f;');
    expect(full.body).toContain('--chat-radius-panel: 6px;');
    expect(full.headers['cache-control']).toBe('no-store');
  });

  it('con el chat desactivado sigue saliendo "no disponible", con el nombre como título', async () => {
    bot = await createTestBot(t);
    await seedChatDesign(t.db, { ...GREEN_PALETTE, chatName: 'Recepción' });
    const res = await frame(bot.app);
    expect(res.body).toContain('Ahora mismo el chat no está disponible.');
    expect(res.body).toContain('<h1>Recepción</h1>');
  });

  it('si leer el diseño falla, el frame sale como el original (FR-018)', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    await seedChatDesign(t.db, { ...GREEN_PALETTE, chatName: 'Recepción' });
    await t.db.execute(sql`alter table chat_design rename to chat_design_roto`);
    try {
      const res = await frame(bot.app);
      expect(res.statusCode).toBe(200);
      expect(normalize(res.body)).toBe(normalize(fixture('frame-004.html')));
      const css = await bot.app.inject({ method: 'GET', url: '/chat/design.css' });
      expect(css.statusCode).toBe(200);
      expect(css.body).toBe('');
    } finally {
      await t.db.execute(sql`alter table chat_design_roto rename to chat_design`);
    }
  });
});

describe('diseño del chat web: elementos obligatorios con cualquier diseño (US2, Principios IV y V)', () => {
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

  /** El diseño más exigente: nombre y bienvenida al máximo, forma redondeada y paleta propia. */
  const EXTREME = {
    ...GREEN_PALETTE,
    shape: 'round' as const,
    chatName: 'N'.repeat(40),
    welcomeText: `${'Bienvenida larga. '.repeat(15)}\nSegunda línea\nTercera línea`.slice(0, 280),
    sendLabel: 'E'.repeat(20),
  };

  const frame = (app: FastifyInstance) => app.inject({ method: 'GET', url: '/chat/frame' });

  /** Aviso, privacidad (antes del primer mensaje), campo, Enviar y cerrar. */
  function expectRequiredElements(body: string) {
    const notice = body.indexOf('Estás hablando con el asistente automático de Peluquería Tijeras');
    const privacy = body.indexOf('>Política de privacidad</a>');
    const firstMessage = body.indexOf('<li class=');
    expect(notice).toBeGreaterThan(-1);
    expect(privacy).toBeGreaterThan(-1);
    expect(firstMessage).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(firstMessage);
    expect(privacy).toBeLessThan(firstMessage);
    expect(body).toContain('se borran a los 30 días');
    expect(body).toMatch(/<textarea id="chat-text"/);
    expect(body).toMatch(/<button type="submit">[^<\s][^<]*<\/button>/);
    expect(body).toContain('id="chat-close"');
    expect(body).toContain('aria-label="Cerrar el chat"');
    expect(body).toContain('id="chat-toggle"');
    expect(body).toContain('Abrir el chat');
    // Franja de derivación de la 005.
    expect(body).toContain('<p id="chat-handoff" class="handoff" role="status" hidden></p>');
  }

  it('con los valores más extremos siguen el aviso, la privacidad, el campo, Enviar y cerrar (US2-4, US2-6)', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    await seedChatDesign(t.db, EXTREME);
    const res = await frame(bot.app);
    expectRequiredElements(res.body);
    expect(res.body).toContain(`<h1>${'N'.repeat(40)}</h1>`);
  });

  it('la franja de derivación sigue en frame.js y frame.css', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    const js = await bot.app.inject({ method: 'GET', url: '/chat/assets/frame.js' });
    const css = await bot.app.inject({ method: 'GET', url: '/chat/assets/frame.css' });
    expect(js.body).toContain('handoffBar.textContent');
    expect(css.body).toContain('.handoff {');
    expect(css.body).toContain('#fff6d6');
  });

  const UNAVAILABLE = 'Ahora mismo el chat no está disponible.';
  const CONTACT = 'Para hablar con una persona de Peluquería Tijeras';

  it('no disponible con diseño: desactivado, en preparación, tope de uso y tope de gasto (US2-7)', async () => {
    const cases: Array<{ name: string; opts: Parameters<typeof createTestBot>[1]; reach?: (b: TestBot) => Promise<void> }> = [
      { name: 'desactivado', opts: {} },
      { name: 'en preparación', opts: { webChat: WEB_ON, activate: false } },
      {
        name: 'tope de uso',
        opts: { webChat: WEB_ON },
        reach: async (b) => {
          await t.db.insert(webUsageDay).values({ day: '2026-09-24', replies: 200 });
          await b.setWebChat({ dailyCap: 200 });
        },
      },
      {
        name: 'tope de gasto',
        opts: { webChat: WEB_ON },
        reach: async () => {
          await t.db.insert(modelPrice).values({
            model: TEST_LLM_MODEL,
            inputMicrosPerMtok: 3_000_000n,
            outputMicrosPerMtok: 0n,
            cacheWriteMicrosPerMtok: 0n,
            cacheReadMicrosPerMtok: 0n,
          });
          await t.db.update(usageSettings).set({ capEnabled: true, monthlyCapCents: 1 });
          await t.db.insert(modelUsage).values({
            at: new Date('2026-09-24T08:00:00Z'),
            day: '2026-09-24',
            channel: 'playground',
            purpose: 'reply',
            model: TEST_LLM_MODEL,
            calls: 1,
            inputTokens: 1,
            outputTokens: 1,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            costPico: 10_000_000_000n,
            currency: 'USD',
          });
        },
      },
    ];
    for (const c of cases) {
      const b = await createTestBot(t, c.opts);
      bot = b;
      await seedChatDesign(t.db, EXTREME);
      await c.reach?.(b);
      const res = await frame(b.app);
      expect([c.name, res.body.includes(UNAVAILABLE)]).toEqual([c.name, true]);
      expect([c.name, res.body.includes(CONTACT)]).toEqual([c.name, true]);
      expect([c.name, res.body.includes('id="chat-close"')]).toEqual([c.name, true]);
      expect(res.body).toContain('data-palette="custom"');
      await b.close();
      bot = null;
    }
  });
});
