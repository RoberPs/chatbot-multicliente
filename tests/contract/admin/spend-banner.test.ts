/**
 * Aviso del tope de gasto en todas las pantallas del panel (010 US3; FR-019 – FR-021, R12,
 * contracts/admin-usage-screen.md § Aviso): como mucho uno, el más grave, calculado en cada
 * petición; no cuenta como aviso de la configuración ni impide activar el negocio.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { modelPrice, modelUsage, usageSettings } from '../../../src/db/schema.js';
import { get, login, postForm, type Session } from '../../helpers/app.js';
import { createTestBot, TEST_LLM_MODEL, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const CENT = 10_000_000_000n;
const SCREENS = [
  '/admin',
  '/admin/business',
  '/admin/services',
  '/admin/usage',
  '/admin/playground',
];
const REACHED = 'Tope de gasto alcanzado (';
const NO_PRICE = `El modelo «${TEST_LLM_MODEL}» no tiene precio: su consumo no cuenta para el tope.`;
const PLAYGROUND_REMINDER =
  'Los clientes finales están recibiendo solo el contacto del negocio porque se ha alcanzado el ' +
  'tope de gasto. Lo que pruebes aquí sigue usando el modelo y suma al gasto.';

describe('aviso del tope de gasto en el panel', () => {
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

  async function start(opts: { activate?: boolean } = {}): Promise<void> {
    bot = await createTestBot(t, opts);
    app = bot.app;
    session = await login(app);
  }

  const setPrice = () =>
    t.db.insert(modelPrice).values({
      model: TEST_LLM_MODEL,
      inputMicrosPerMtok: 3_000_000n,
      outputMicrosPerMtok: 15_000_000n,
      cacheWriteMicrosPerMtok: 0n,
      cacheReadMicrosPerMtok: 0n,
    });
  const setCap = (cents: number) =>
    t.db.update(usageSettings).set({ capEnabled: true, monthlyCapCents: cents });
  const spend = (cents: bigint) =>
    t.db.insert(modelUsage).values({
      at: new Date('2026-09-24T08:00:00Z'),
      day: '2026-09-24',
      channel: 'whatsapp',
      purpose: 'reply',
      model: TEST_LLM_MODEL,
      calls: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      costPico: cents * CENT,
      currency: 'USD',
    });

  const banners = (html: string) => html.match(/data-spend-banner=/g)?.length ?? 0;
  const pages = async () =>
    Promise.all(
      SCREENS.map(async (url) => {
        const res = await get(app, session, url);
        expect([url, res.statusCode]).toEqual([url, 200]);
        return { url, html: res.body };
      }),
    );

  it('sin tope no hay aviso', async () => {
    await start();
    for (const { url, html } of await pages()) expect([url, banners(html)]).toEqual([url, 0]);
  });

  it('warning: "Gasto del mes al {p} % del tope." en todas las pantallas', async () => {
    await start();
    await setPrice();
    await setCap(1000);
    await spend(850n);
    for (const { url, html } of await pages()) {
      expect([url, banners(html)]).toEqual([url, 1]);
      expect(html).toContain('Gasto del mes al 85 % del tope.');
      expect(html).toContain('data-spend-banner="warning"');
    }
  });

  it('reached gana a "sin precio": un solo aviso, el más grave', async () => {
    await start();
    await setCap(1000);
    await spend(1200n);
    // Sin precio de LLM_MODEL y con el tope alcanzado por otros registros.
    for (const { url, html } of await pages()) {
      expect([url, banners(html)]).toEqual([url, 1]);
      expect(html).toContain(
        'Tope de gasto alcanzado (120 %): el bot responde solo con el contacto del negocio en WhatsApp y en el chat web.',
      );
      expect(html).not.toContain(NO_PRICE);
    }
  });

  it('tope activo sin precio del modelo actual: aviso crítico que lo nombra', async () => {
    await start();
    await setCap(1000);
    for (const { url, html } of await pages()) {
      expect([url, banners(html)]).toEqual([url, 1]);
      expect(html).toContain(NO_PRICE);
      expect(html).toContain('data-spend-banner="no_price"');
    }
  });

  it('el aviso enlaza a Consumo y no cambia el contador de avisos', async () => {
    await start();
    const before = (await get(app, session, '/admin')).body.match(/Avisos: [^<]*/)?.[0];
    await setPrice();
    await setCap(1000);
    await spend(1000n);
    const html = (await get(app, session, '/admin')).body;
    expect(html).toContain(REACHED);
    expect(html).toMatch(/data-spend-banner="reached"[\s\S]*?href="\/admin\/usage"/);
    expect(html.match(/Avisos: [^<]*/)?.[0]).toBe(before);
  });

  it('no impide activar el negocio', async () => {
    await start({ activate: false });
    await setPrice();
    await setCap(1000);
    await spend(1000n);
    const res = await postForm(app, session, '/admin/status/activate');
    expect(res.statusCode).toBe(303);
  });

  it('"Probar el bot" muestra el recordatorio solo con reached', async () => {
    await start();
    await setPrice();
    await setCap(1000);
    await spend(900n);
    expect((await get(app, session, '/admin/playground')).body).not.toContain(PLAYGROUND_REMINDER);
    await spend(100n);
    expect((await get(app, session, '/admin/playground')).body).toContain(PLAYGROUND_REMINDER);
  });

  it('si la consulta falla, la página se sirve sin aviso', async () => {
    await start();
    await setPrice();
    await setCap(1000);
    await spend(1000n);
    await t.db.execute(sql`alter table usage_settings rename to usage_settings_oculta`);
    try {
      for (const url of ['/admin', '/admin/business', '/admin/playground']) {
        const res = await get(app, session, url);
        expect([url, res.statusCode, banners(res.body)]).toEqual([url, 200, 0]);
      }
    } finally {
      await t.db.execute(sql`alter table usage_settings_oculta rename to usage_settings`);
    }
  });
});
