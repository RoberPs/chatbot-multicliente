/**
 * Saturación de las rutas públicas del chat (012, US3, SC-004): mientras llueven peticiones al
 * frame y a la hoja del diseño desde una dirección, desde un mismo /64 y repartidas entre varias,
 * el panel y el webhook de WhatsApp siguen respondiendo en menos de 2 s. Versión reducida (1 000
 * peticiones por escenario); la carga de 10 000 se comprueba a mano (quickstart, escenario 4).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { get, login } from '../helpers/app.js';
import { createTestBot, type TestBot } from '../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { postWebhook, textMessage, webhookPayload } from '../helpers/whatsapp.js';

const ORIGIN = 'https://negocio.example';
const WEB_ON = { enabled: true, allowedOrigins: [ORIGIN], privacyUrl: `${ORIGIN}/privacidad` };
const REQUESTS = 1000;
const URLS = ['/chat/frame', '/chat/design.css'];

/** Escenario, direcciones y si el límite por dirección tiene que cortar la mayoría. */
const SCENARIOS: Array<[string, string[], boolean]> = [
  ['una dirección', ['198.51.100.7'], true],
  [
    'un mismo /64',
    Array.from({ length: 20 }, (_, i) => `2001:db8:1:2::${(i + 1).toString(16)}`),
    true,
  ],
  // 50 por dirección: dentro del límite; prueba que el pool aguanta lo que sí se atiende.
  ['20 direcciones', Array.from({ length: 20 }, (_, i) => `203.0.113.${String(i + 1)}`), false],
];

describe('saturación de las rutas públicas (SC-004)', () => {
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

  it.each(SCENARIOS)(
    '%s: el panel y el webhook responden en < 2 s',
    async (_name, ips, limited) => {
      const b = (bot = await createTestBot(t, { webChat: WEB_ON }));
      const session = await login(b.app);
      let done = false;
      const statuses = new Map<number, number>();

      const flood = async () => {
        for (let i = 0; i < REQUESTS; i++) {
          const res = await b.app.inject({
            method: 'GET',
            url: URLS[i % URLS.length] ?? '/chat/frame',
            remoteAddress: ips[i % ips.length] ?? '',
          });
          statuses.set(res.statusCode, (statuses.get(res.statusCode) ?? 0) + 1);
        }
        done = true;
      };

      const timings: number[] = [];
      const measure = async () => {
        let n = 0;
        while (!done) {
          const started = Date.now();
          const admin = await get(b.app, session, '/admin');
          expect(admin.statusCode).toBe(200);
          timings.push(Date.now() - started);

          const sent = Date.now();
          const hook = await postWebhook(
            b.app,
            webhookPayload({
              messages: [textMessage(`hola ${String(n)}`, { id: `wamid.sat.${String(n)}` })],
            }),
          );
          expect(hook.statusCode).toBe(200);
          timings.push(Date.now() - sent);
          n += 1;
          // Deja pasar peticiones del chat entre medida y medida.
          await new Promise((resolve) => setImmediate(resolve));
        }
      };

      await Promise.all([flood(), measure()]);
      expect(timings.length).toBeGreaterThan(0);
      expect(Math.max(...timings)).toBeLessThan(2000);
      // Desde una dirección o un /64, casi todo se rechaza por el límite sin tocar la BD.
      if (limited) expect(statuses.get(429) ?? 0).toBeGreaterThan(REQUESTS / 2);
    },
  );
});
