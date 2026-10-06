/**
 * Límites por dirección de las rutas públicas del chat web (012, US3, FR-018 – FR-020;
 * contracts/public-routes-and-login.md): el frame, la hoja del diseño y sus imágenes rechazan con
 * 429 de texto **antes** de tocar la base de datos; direcciones del mismo /64 comparten límite y
 * el rechazo se registra sin la dirección.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FRAME_FALLBACK_CSP } from '../../src/channels/web/routes.js';
import { createTestBot, type TestBot } from '../helpers/bot.js';
import { imageUrl, seedChatDesignWithImages } from '../helpers/chat-design.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const ORIGIN = 'https://negocio.example';
const WEB_ON = { enabled: true, allowedOrigins: [ORIGIN], privacyUrl: `${ORIGIN}/privacidad` };
const IP = '198.51.100.7';
const OTHER_IP = '198.51.100.8';
const SAME_64 = ['2001:db8:1:2::1', '2001:db8:1:2:ffff:ffff:ffff:fffe'];
const OTHER_64 = '2001:db8:1:3::1';

type Route = 'frame' | 'hoja' | 'imagen';
const LIMITS: Record<Route, number> = { frame: 60, hoja: 120, imagen: 120 };

describe('límites por dirección de las rutas públicas del chat', () => {
  let t: TestDatabase;
  let bot: TestBot | null = null;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await bot?.close();
    bot = null;
  });

  /** Bot con el chat activado y un diseño con logo; devuelve la URL de cada ruta. */
  async function start(): Promise<{ b: TestBot; urls: Record<Route, string> }> {
    const b = (bot = await createTestBot(t, { webChat: WEB_ON }));
    const images = await seedChatDesignWithImages(t.db, { logo: 'valid.webp' });
    const logo = images.logo;
    if (!logo) throw new Error('sin logo');
    return {
      b,
      urls: { frame: '/chat/frame', hoja: '/chat/design.css', imagen: imageUrl('logo', logo) },
    };
  }

  const hit = (b: TestBot, url: string, ip: string) =>
    b.app.inject({ method: 'GET', url, remoteAddress: ip });

  it.each(['frame', 'hoja', 'imagen'] as const)(
    '%s: por encima del límite, 429 de texto sin consultar la BD',
    async (route) => {
      const { b, urls } = await start();
      const url = urls[route];
      for (let i = 0; i < LIMITS[route]; i++) {
        expect([i, (await hit(b, url, IP)).statusCode]).toEqual([i, 200]);
      }
      const connect = vi.spyOn(t.db.$client, 'connect');
      const query = vi.spyOn(t.db.$client, 'query');
      const over = await hit(b, url, IP);
      expect(over.statusCode).toBe(429);
      expect(over.headers['content-type']).toMatch(/^text\/plain/);
      expect(connect).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      if (route === 'frame') {
        expect(over.headers['content-security-policy']).toBe(FRAME_FALLBACK_CSP);
      }
      expect(b.log.named('web_rejected')).toEqual([{ event: 'web_rejected', reason: 'ip_limit' }]);
      expect(JSON.stringify(b.log.events)).not.toContain(IP);
      vi.restoreAllMocks();
      // Otra dirección sigue entrando.
      expect((await hit(b, url, OTHER_IP)).statusCode).toBe(200);
    },
  );

  it('dos direcciones del mismo /64 comparten límite; otro /64 no', async () => {
    const { b } = await start();
    for (let i = 0; i < 60; i++) {
      expect((await hit(b, '/chat/frame', SAME_64[i % 2] ?? '')).statusCode).toBe(200);
    }
    expect((await hit(b, '/chat/frame', SAME_64[0] ?? '')).statusCode).toBe(429);
    expect((await hit(b, '/chat/frame', SAME_64[1] ?? '')).statusCode).toBe(429);
    expect((await hit(b, '/chat/frame', OTHER_64)).statusCode).toBe(200);
  });
});
