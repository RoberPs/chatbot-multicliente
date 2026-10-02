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
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestBot, type TestBot } from '../helpers/bot.js';
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
