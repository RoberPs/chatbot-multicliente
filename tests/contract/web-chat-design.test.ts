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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { modelPrice, modelUsage, usageSettings, webUsageDay } from '../../src/db/schema.js';
import { readDesignImageBytes } from '../../src/webchat/design/store.js';
import { get, login } from '../helpers/app.js';
import { createTestBot, TEST_LLM_MODEL, type TestBot } from '../helpers/bot.js';
import {
  clearChatDesign,
  designForm,
  designRow,
  GREEN_PALETTE,
  imageUrl,
  postDesign,
  seedChatDesign,
  seedChatDesignWithImages,
} from '../helpers/chat-design.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

// Espía de la lectura de los bytes (012, US3): la imagen se comprueba antes por sus metadatos.
vi.mock('../../src/webchat/design/store.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/webchat/design/store.js')>();
  return { ...original, readDesignImageBytes: vi.fn(original.readDesignImageBytes) };
});

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
  html.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

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
    expect(after.headers['content-security-policy']).toBe(
      before.headers['content-security-policy'],
    );
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
    const cases: Array<{
      name: string;
      opts: Parameters<typeof createTestBot>[1];
      reach?: (b: TestBot) => Promise<void>;
    }> = [
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

describe('diseño del chat web: imágenes (US3)', () => {
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

  /** Imagen de un hueco que el test acaba de guardar. */
  const must = <T>(value: T | undefined): T => {
    if (value === undefined) throw new Error('Falta la imagen');
    return value;
  };

  it('icono dentro del botón y logo a la izquierda del título (FR-030a, FR-030b)', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    const images = await seedChatDesignWithImages(t.db, { logo: 'valid.png', icon: 'valid.webp' });
    const res = await frame(bot.app);
    const icon = imageUrl('icon', must(images.icon));
    const logo = imageUrl('logo', must(images.logo));
    // El botón conserva aria-expanded y su etiqueta; el emoji sigue en el HTML (oculto por CSS).
    const toggle = res.body.slice(
      res.body.indexOf('<button id="chat-toggle"'),
      res.body.indexOf('</button>'),
    );
    expect(toggle).toContain('aria-expanded="false"');
    expect(toggle).toContain(`<img class="design-icon" src="${icon}" alt="">`);
    expect(toggle.indexOf('design-icon')).toBeLessThan(
      toggle.indexOf('<span aria-hidden="true">💬</span>'),
    );
    expect(toggle).toContain('<span class="sr-only">Abrir el chat</span>');
    const head = res.body.slice(
      res.body.indexOf('<header class="panel-head">'),
      res.body.indexOf('</header>'),
    );
    expect(head).toContain(`<img class="design-logo" src="${logo}" alt="">`);
    expect(head.indexOf('design-logo')).toBeLessThan(head.indexOf('<h1>'));
  });

  it('avatar: data-avatar y --chat-avatar en design.css', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    const images = await seedChatDesignWithImages(t.db, { avatar: 'valid.jpg' });
    const res = await frame(bot.app);
    expect(res.body).toContain('data-avatar="on"');
    const css = await bot.app.inject({ method: 'GET', url: '/chat/design.css' });
    expect(css.body).toContain(`--chat-avatar: url(${imageUrl('avatar', must(images.avatar))});`);
  });

  it('GET /chat/design/:slot/:file con la huella vigente: bytes y cabeceras (FR-032)', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    const images = await seedChatDesignWithImages(t.db, {
      logo: 'metadata.png',
      avatar: 'valid.jpg',
      icon: 'valid.webp',
    });
    const types = { logo: 'image/png', avatar: 'image/jpeg', icon: 'image/webp' } as const;
    for (const slot of ['logo', 'avatar', 'icon'] as const) {
      const image = must(images[slot]);
      const res = await bot.app.inject({ method: 'GET', url: imageUrl(slot, image) });
      expect([slot, res.statusCode]).toEqual([slot, 200]);
      expect(res.rawPayload.equals(image.bytes)).toBe(true);
      expect(res.headers['content-type']).toBe(types[slot]);
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.headers['content-disposition']).toBe('inline');
      expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    // Lo servido ya no lleva los metadatos.
    const logo = await bot.app.inject({ method: 'GET', url: imageUrl('logo', must(images.logo)) });
    expect(logo.rawPayload.includes(Buffer.from('tEXt'))).toBe(false);
  });

  it('huella antigua, hueco desconocido, extensión distinta o sin diseño → 404 (FR-031)', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    const images = await seedChatDesignWithImages(t.db, { logo: 'valid.png' });
    const logo = must(images.logo);
    const hash = logo.sha256.slice(0, 16);
    const urls = [
      `/chat/design/logo/${'0'.repeat(16)}.png`,
      `/chat/design/banner/${hash}.png`,
      `/chat/design/logo/${hash}.jpg`,
      `/chat/design/logo/${hash}.svg`,
      `/chat/design/icon/${hash}.png`,
      `/chat/design/logo/${hash}`,
    ];
    for (const url of urls) {
      const res = await bot.app.inject({ method: 'GET', url });
      expect([url, res.statusCode]).toEqual([url, 404]);
    }
    await clearChatDesign(t.db);
    const gone = await bot.app.inject({ method: 'GET', url: imageUrl('logo', logo) });
    expect(gone.statusCode).toBe(404);
  });

  it('012: con otra huella, otra extensión o sin imagen, 404 sin leer los bytes; con la vigente, sí', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    const images = await seedChatDesignWithImages(t.db, { logo: 'valid.png' });
    const logo = must(images.logo);
    const hash = logo.sha256.slice(0, 16);
    const bytesRead = vi.mocked(readDesignImageBytes);
    bytesRead.mockClear();
    for (const url of [
      `/chat/design/logo/${'0'.repeat(16)}.png`,
      `/chat/design/logo/${hash}.jpg`,
      `/chat/design/avatar/${hash}.png`,
    ]) {
      const res = await bot.app.inject({ method: 'GET', url });
      expect([url, res.statusCode, res.body]).toEqual([url, 404, 'No encontrado']);
    }
    expect(bytesRead).not.toHaveBeenCalled();
    const ok = await bot.app.inject({ method: 'GET', url: imageUrl('logo', logo) });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(bytesRead).toHaveBeenCalledTimes(1);
  });

  it('una imagen guardada cuyos bytes ya no valen no se sirve (R13)', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    const images = await seedChatDesignWithImages(t.db, { logo: 'valid.png' });
    await t.db.execute(sql`update chat_design_image set bytes = ${Buffer.from('<svg/>')}`);
    const res = await bot.app.inject({ method: 'GET', url: imageUrl('logo', must(images.logo)) });
    expect(res.statusCode).toBe(404);
  });

  it('ninguna URL del frame ni de design.css apunta a otro origen (FR-041)', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    await seedChatDesignWithImages(
      t.db,
      { logo: 'valid.png', avatar: 'valid.png', icon: 'valid.png' },
      { ...GREEN_PALETTE, shape: 'soft' },
    );
    const res = await frame(bot.app);
    const css = await bot.app.inject({ method: 'GET', url: '/chat/design.css' });
    for (const body of [res.body, css.body]) {
      const urls = [...body.matchAll(/(?:src|href)="([^"]+)"|url\(([^)]+)\)/g)].map(
        (m) => m[1] ?? m[2] ?? '',
      );
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) {
        // Solo rutas propias, y el enlace de privacidad que configura el operador.
        expect([url, url.startsWith('/') || url === `${ORIGIN}/privacidad`]).toEqual([url, true]);
      }
    }
  });

  it('elementos obligatorios con las tres imágenes y los textos al máximo (US2-6, SC-004)', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    await seedChatDesignWithImages(
      t.db,
      { logo: 'valid.png', avatar: 'valid.jpg', icon: 'valid.webp' },
      {
        ...GREEN_PALETTE,
        shape: 'round',
        chatName: 'N'.repeat(40),
        welcomeText: `${'Bienvenida larga. '.repeat(15)}\nSegunda línea`.slice(0, 280),
      },
    );
    const res = await frame(bot.app);
    const notice = res.body.indexOf(
      'Estás hablando con el asistente automático de Peluquería Tijeras',
    );
    const privacy = res.body.indexOf('>Política de privacidad</a>');
    const welcome = res.body.indexOf('<li class="welcome">');
    expect(notice).toBeGreaterThan(-1);
    expect(privacy).toBeGreaterThan(notice);
    expect(welcome).toBeGreaterThan(privacy);
    expect(res.body).toContain(`<h1>${'N'.repeat(40)}</h1>`);
    expect(res.body).toMatch(/<textarea id="chat-text"/);
    expect(res.body).toMatch(/<button type="submit">Enviar<\/button>/);
    expect(res.body).toContain('id="chat-close"');
    expect(res.body).toContain('Abrir el chat');

    // Y con el chat desactivado, el contacto de no disponible.
    await bot.setWebChat({ enabled: false });
    const off = await frame(bot.app);
    expect(off.body).toContain('Para hablar con una persona de Peluquería Tijeras');
    expect(off.body).toContain('class="design-logo"');
  });
});

describe('diseño del chat web: posición y tamaño (US4)', () => {
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

  it('el frame lleva data-position y data-size solo si difieren del original', async () => {
    bot = await createTestBot(t, { webChat: WEB_ON });
    await seedChatDesign(t.db, { position: 'left', size: 'large' });
    const res = await bot.app.inject({ method: 'GET', url: '/chat/frame' });
    expect(res.body).toMatch(/<html lang="es" data-position="left" data-size="large">/);

    await seedChatDesign(t.db, { position: 'right', size: 'medium', chatName: 'Solo el nombre' });
    const original = await bot.app.inject({ method: 'GET', url: '/chat/frame' });
    expect(original.body).toContain('<html lang="es">');
  });

  it('el panel muestra los radios de posición y tamaño y guarda sus valores', async () => {
    bot = await createTestBot(t);
    const session = await login(bot.app);
    const page = await get(bot.app, session, '/admin/chat-design');
    for (const label of [
      'Abajo a la derecha',
      'Abajo a la izquierda',
      'Pequeño',
      'Mediano',
      'Grande',
    ]) {
      expect(page.body).toContain(label);
    }
    expect(page.body).toMatch(/name="position" value="right"[^>]*checked/);
    expect(page.body).toMatch(/name="size" value="medium"[^>]*checked/);
    const res = await postDesign(bot.app, session, designForm({ position: 'left', size: 'small' }));
    expect(res.statusCode).toBe(303);
    expect(await designRow(t.db)).toMatchObject({ position: 'left', size: 'small' });
  });
});
