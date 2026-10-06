/**
 * Ataque al login del operador (012, US4, SC-005). Versión reducida: 40 fallos desde 10
 * direcciones en paralelo, con una cola pequeña y el retardo dividido por 100 para que la prueba
 * dure segundos (la regla del retardo la cubre la unitaria). El operador entra con su navegador
 * conocido aunque la cola esté llena; desde uno nuevo entra con la cola por debajo de su capacidad
 * y con ella llena recibe 429 sin que cuente como fallo; el bot sigue respondiendo.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createLoginThrottle } from '../../src/admin/auth/login-throttle.js';
import {
  cookieHeader,
  csrfFrom,
  encodeForm,
  OPERATOR_PASSWORD,
  OPERATOR_USER,
} from '../helpers/app.js';
import { buildTestApp } from '../helpers/app.js';
import { createTestBot, type TestBot } from '../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { reply } from '../helpers/fakes.js';
import type { FastifyInstance } from 'fastify';

const ATTACKS = 40;
const ADDRESSES = 10;

describe('ataque al login (SC-005)', () => {
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

  let n = 0;
  async function attempt(app: FastifyInstance, password: string, extraCookie = '') {
    n += 1;
    // 4 intentos por dirección: por debajo del límite de 5 por minuto.
    const remoteAddress = `10.9.${String(Math.floor(n / ADDRESSES) % 250)}.${String((n % ADDRESSES) + 1)}`;
    const page = await app.inject({ method: 'GET', url: '/admin/login' });
    const cookie = [cookieHeader(page) ?? '', extraCookie].filter(Boolean).join('; ');
    return app.inject({
      method: 'POST',
      url: '/admin/login',
      remoteAddress,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: encodeForm({ _csrf: csrfFrom(page.body), user: OPERATOR_USER, password }),
    });
  }

  it('el operador entra durante el ataque y el bot sigue atendiendo', async () => {
    const throttle = createLoginThrottle({
      queueMax: 5,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms / 100)),
    });
    const app = await buildTestApp(t.db, undefined, null, {}, undefined, {
      loginThrottle: throttle,
    });

    // Primer acceso del operador: su navegador queda conocido.
    const first = await attempt(app, OPERATOR_PASSWORD);
    expect(first.statusCode).toBe(303);
    const raw = first.headers['set-cookie'];
    const device = ((Array.isArray(raw) ? raw : [raw]) as string[])
      .find((c) => c.startsWith('__Host-chatbot-device='))
      ?.split(';')[0];
    expect(device).toBeDefined();

    // El ataque en paralelo; durante él, el operador con su navegador conocido.
    const attack = Promise.all(Array.from({ length: ATTACKS }, () => attempt(app, 'mala')));
    const known = await attempt(app, OPERATOR_PASSWORD, device);
    expect(known.statusCode).toBe(303);
    const codes = (await attack).map((r) => r.statusCode);
    expect(codes.every((c) => c === 401 || c === 429)).toBe(true);
    // Con la cola de 5 llena, parte del ataque se rechaza sin verificar ni contar.
    const rejected = codes.filter((c) => c === 429).length;
    expect(rejected).toBeGreaterThan(0);
    expect(throttle.stats().rejected).toBe(rejected);

    // Desde un navegador nuevo, con la cola libre, entra tras el retardo (< 30 s reales).
    const started = Date.now();
    const fresh = await attempt(app, OPERATOR_PASSWORD);
    expect(fresh.statusCode).toBe(303);
    expect(Date.now() - started).toBeLessThan(30_000);
    await app.close();

    // El bot no comparte nada con el login: responde con normalidad.
    const b = (bot = await createTestBot(t));
    b.model.queue(reply('Abrimos a las diez.'));
    await b.send('¿A qué hora abrís?');
    await b.settle();
    expect(b.sender.sent.at(-1)?.body).toContain('Abrimos a las diez.');
  });
});
