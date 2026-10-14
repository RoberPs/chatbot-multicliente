/**
 * Contrato de la pantalla "Consumo" (010 US2 y US3, contracts/admin-usage-screen.md): consumo de
 * hoy y del mes por canal, meses conservados, precios por modelo, moneda y tope mensual.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  business,
  handoffDay,
  modelPrice,
  modelUsage,
  transcriptionPrice,
  usageSettings,
  whatsappUsageDay,
} from '../../../src/db/schema.js';
import { defaultHandoffLimits, readHandoffLimits } from '../../../src/handoff/limits.js';
import { PRICE_IN_USE_MESSAGE, WHATSAPP_CAP_MESSAGE } from '../../../src/usage/schemas.js';
import { readUsageSettings, readWhatsappCap } from '../../../src/usage/settings.js';
import type { UsagePurpose } from '../../../src/usage/types.js';
import {
  buildTestApp,
  cookieHeader,
  encodeForm,
  fieldErrorsIn,
  get,
  login,
  postForm,
  type FormFields,
  type Session,
} from '../../helpers/app.js';
import {
  createTestBot,
  TEST_LLM_MODEL,
  TEST_STT_MODEL,
  type TestBot,
  type TestBotOptions,
} from '../../helpers/bot.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';
import { FakeMediaFetcher, FakeSpeechToText } from '../../helpers/fakes.js';

const ESTIMATE =
  'Coste estimado con los precios configurados aquí. No es la factura del proveedor. Importes ' +
  'redondeados a 4 decimales. Los importes menores de 0,0001 se muestran como «&lt; 0,0001».';
/** Billonésimas por céntimo. */
const CENT = 10_000_000_000n;

const price = (over: FormFields = {}): FormFields => ({
  model: TEST_LLM_MODEL,
  input: '3',
  output: '15',
  cacheWrite: '3,75',
  cacheRead: '0,30',
  ...over,
});

describe('Consumo (/admin/usage)', () => {
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

  async function start(): Promise<TestBot> {
    bot = await createTestBot(t);
    app = bot.app;
    session = await login(app);
    return bot;
  }

  /** Envía un formulario y se queda con la cookie nueva (el aviso viaja en la sesión). */
  async function post(url: string, fields: FormFields) {
    const res = await postForm(app, session, url, fields);
    const cookie = cookieHeader(res);
    if (cookie) session = { ...session, cookie };
    return res;
  }

  const page = async (url = '/admin/usage') => {
    const res = await get(app, session, url);
    expect(res.statusCode).toBe(200);
    return res.body;
  };

  const seed = (
    rows: Array<{
      day?: string;
      channel: 'whatsapp' | 'web' | 'playground';
      purpose?: UsagePurpose;
      model?: string;
      cost?: bigint | null;
    }>,
  ) =>
    t.db.insert(modelUsage).values(
      rows.map((r) => {
        const cost = r.cost === undefined ? 1_234_560_000_000n : r.cost;
        return {
          at: new Date('2026-09-24T08:00:00Z'),
          day: r.day ?? '2026-09-24',
          channel: r.channel,
          purpose: r.purpose ?? 'reply',
          model: r.model ?? TEST_LLM_MODEL,
          calls: 1,
          inputTokens: 1200,
          outputTokens: 300,
          cacheWriteTokens: 0,
          cacheReadTokens: 800,
          costPico: cost,
          currency: cost === null ? null : 'USD',
        };
      }),
    );

  /** Celdas de la fila de la tabla `table` cuya etiqueta es `label`. */
  function rowCells(html: string, table: string, label: string): string[] {
    const section = html.split(`data-usage-table="${table}"`)[1]?.split('</table>')[0] ?? '';
    const row = section.split('<tr').find((r) => r.includes(`<th scope="row">${label}</th>`));
    return [...(row ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      (m[1] ?? '')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }

  it('sin sesión redirige al login; los POST sin CSRF dan 403', async () => {
    const b = await start();
    const anon = await b.app.inject({ method: 'GET', url: '/admin/usage' });
    expect(anon.statusCode).toBe(302);
    expect(anon.headers.location).toBe('/admin/login');
    for (const url of [
      '/admin/usage/prices',
      '/admin/usage/prices/delete',
      '/admin/usage/settings',
    ]) {
      const res = await b.app.inject({
        method: 'POST',
        url,
        headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: encodeForm(price()),
      });
      expect([url, res.statusCode]).toEqual([url, 403]);
    }
    expect(await t.db.select().from(modelPrice)).toEqual([]);
  });

  it('muestra el aviso de estimación y las tablas de hoy y del mes con ceros', async () => {
    await start();
    await seed([{ channel: 'whatsapp', cost: 1_234_560_000_000n }]);
    const html = await page();
    expect(html).toContain(ESTIMATE);
    expect(html).toContain('<h2>Hoy');
    expect(html).toContain('<h2>Este mes');
    // Respuestas, resúmenes, 4 tokens y coste.
    expect(rowCells(html, 'today', 'WhatsApp')).toEqual([
      '1',
      '0',
      '1200',
      '300',
      '0',
      '800',
      '1,2346 USD',
    ]);
    expect(rowCells(html, 'today', 'Chat web')).toEqual([
      '0',
      '0',
      '0',
      '0',
      '0',
      '0',
      '0,0000 USD',
    ]);
    expect(rowCells(html, 'month', 'Probar el bot')[0]).toBe('0');
    expect(rowCells(html, 'month', 'Clientes finales')[0]).toBe('1');
    expect(rowCells(html, 'month', 'Instancia')[6]).toBe('1,2346 USD');
  });

  it('coste muy pequeño «< 0,0001», «sin precio» y aviso con el modelo', async () => {
    await start();
    await seed([
      { channel: 'web', cost: 1n },
      { channel: 'whatsapp', model: 'modelo-sin-precio', cost: null },
      { channel: 'playground', cost: 2n * CENT },
    ]);
    const html = await page();
    expect(rowCells(html, 'today', 'Chat web')[6]).toBe('&lt; 0,0001 USD');
    expect(rowCells(html, 'today', 'WhatsApp')[6]).toBe('sin precio');
    expect(rowCells(html, 'today', 'Clientes finales')[6]).toBe(
      '&lt; 0,0001 USD (hay consumo sin precio)',
    );
    expect(rowCells(html, 'today', 'Instancia')[6]).toBe('0,0200 USD (hay consumo sin precio)');
    expect(html).toContain(
      'Consumo sin precio del modelo «modelo-sin-precio»: sus tokens se muestran pero no tienen coste.',
    );
  });

  it('marca el modelo actual y ofrece añadir su precio con el nombre puesto', async () => {
    await start();
    const html = await page();
    expect(html).toContain(`El modelo actual «${TEST_LLM_MODEL}» no tiene precio.`);
    expect(html).toContain(`name="model" type="text" value="${TEST_LLM_MODEL}"`);

    expect((await post('/admin/usage/prices', price())).statusCode).toBe(303);
    const after = await page();
    expect(after).toContain('Guardado');
    expect(after).toContain(`${TEST_LLM_MODEL} <span class="badge badge-ok">modelo actual</span>`);
    expect(after).not.toContain('no tiene precio.');
  });

  it('precio: 422 por campo, alta, cambio y borrado (303 o 404)', async () => {
    await start();
    const bad = await post('/admin/usage/prices', price({ model: '', output: '-1' }));
    expect(bad.statusCode).toBe(422);
    expect(fieldErrorsIn(bad.body).sort()).toEqual(['model', 'output']);
    expect(await t.db.select().from(modelPrice)).toEqual([]);

    const saved = await post('/admin/usage/prices', price());
    expect(saved.statusCode).toBe(303);
    expect(saved.headers.location).toBe('/admin/usage');
    await post('/admin/usage/prices', price({ input: '6' }));
    const [row] = await t.db.select().from(modelPrice);
    expect(row).toMatchObject({
      inputMicrosPerMtok: 6_000_000n,
      cacheWriteMicrosPerMtok: 3_750_000n,
    });
    expect(await page()).toContain('<td>6</td>');

    const missing = await post('/admin/usage/prices/delete', { model: 'no-existe' });
    expect(missing.statusCode).toBe(404);
    const deleted = await post('/admin/usage/prices/delete', { model: TEST_LLM_MODEL });
    expect(deleted.statusCode).toBe(303);
    expect(await t.db.select().from(modelPrice)).toEqual([]);
  });

  it('cambiar la moneda con precios da 422; sin precios se guarda', async () => {
    await start();
    expect((await post('/admin/usage/settings', { currency: 'EUR' })).statusCode).toBe(303);
    expect((await readUsageSettings(t.db)).currency).toBe('EUR');
    await post('/admin/usage/prices', price());
    const res = await post('/admin/usage/settings', { currency: 'USD' });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Para cambiar la moneda, borra antes los precios: están en EUR.');
    expect(fieldErrorsIn(res.body)).toEqual(['currency']);
    expect((await readUsageSettings(t.db)).currency).toBe('EUR');
    // Los precios se muestran en la moneda de coste.
    expect(await page()).toContain('Precios por millón de tokens, en EUR');
  });

  it('?month válido muestra el mes por canal y por día; si no, "Mes no disponible"', async () => {
    await start();
    await seed([
      { day: '2026-08-03', channel: 'whatsapp' },
      { day: '2026-08-20', channel: 'web' },
      { day: '2026-09-24', channel: 'web' },
    ]);
    const html = await page('/admin/usage?month=2026-08');
    expect(html).toContain('<h2>Agosto de 2026');
    expect(rowCells(html, 'month', 'WhatsApp')[0]).toBe('1');
    expect(rowCells(html, 'month', 'Chat web')[0]).toBe('1');
    expect(rowCells(html, 'days', '03/08/2026')[0]).toBe('1');
    expect(rowCells(html, 'days', '20/08/2026')[0]).toBe('1');
    expect(html).not.toContain('<h2>Hoy');
    // El selector lista los meses conservados con consumo.
    expect(html).toContain('<option value="2026-09"');
    expect(html).toContain('<option value="2026-08" selected');

    for (const month of ['2026-13', 'agosto', '2025-01', '2026-07']) {
      const other = await page(`/admin/usage?month=${month}`);
      expect([month, other.includes('Mes no disponible')]).toEqual([month, true]);
      expect(other).toContain('<h2>Hoy');
    }
  });

  it('la página no muestra identificadores de conversación ni de cliente', async () => {
    const b = await start();
    b.model.reportUsage({ input: 10, output: 5, cacheWrite: 0, cacheRead: 0 });
    await b.send('¿Abrís el sábado?');
    await b.settle();
    const [conversationRow] = await b.messages();
    const html = await page();
    expect(rowCells(html, 'today', 'WhatsApp')[0]).toBe('1');
    expect(html).not.toContain('+34600111222');
    expect(html).not.toContain('600111222');
    expect(html).not.toContain(conversationRow?.conversationId ?? 'sin-conversacion');
  });

  describe('tope mensual (US3)', () => {
    it('activar sin precio del modelo actual da 422 con su nombre', async () => {
      await start();
      const res = await post('/admin/usage/settings', {
        currency: 'USD',
        capEnabled: 'on',
        monthlyCap: '10',
      });
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain(
        `No se puede activar el tope: el modelo «${TEST_LLM_MODEL}» no tiene precio.`,
      );
      expect(fieldErrorsIn(res.body)).toEqual(['capEnabled']);
      expect((await readUsageSettings(t.db)).capEnabled).toBe(false);
    });

    it('tope 0 da 422; con precio se activa (303) y un tope menor que el gasto se acepta', async () => {
      await start();
      await post('/admin/usage/prices', price());
      const zero = await post('/admin/usage/settings', {
        currency: 'USD',
        capEnabled: 'on',
        monthlyCap: '0',
      });
      expect(zero.statusCode).toBe(422);
      expect(fieldErrorsIn(zero.body)).toEqual(['monthlyCap']);

      await seed([{ channel: 'whatsapp', cost: 1234n * CENT }]); // 12,34 gastados
      const ok = await post('/admin/usage/settings', {
        currency: 'USD',
        capEnabled: 'on',
        monthlyCap: '10',
      });
      expect(ok.statusCode).toBe(303);
      expect(await readUsageSettings(t.db)).toEqual({
        currency: 'USD',
        capEnabled: true,
        monthlyCapCents: 1000,
      });
      const html = await page();
      expect(html).toContain('data-cap-level="reached"');
      expect(html).toContain('Gasto del mes: 12,3400 USD');
      expect(html).toContain('Tope: 10,00 USD');
      expect(html).toContain('123 %');
    });

    it('desactivar conserva el importe y la pantalla dice "Sin tope"', async () => {
      await start();
      await post('/admin/usage/prices', price());
      await post('/admin/usage/settings', {
        currency: 'USD',
        capEnabled: 'on',
        monthlyCap: '25,5',
      });
      expect(
        (await post('/admin/usage/settings', { currency: 'USD', monthlyCap: '25,50' })).statusCode,
      ).toBe(303);
      expect(await readUsageSettings(t.db)).toEqual({
        currency: 'USD',
        capEnabled: false,
        monthlyCapCents: 2550,
      });
      const html = await page();
      expect(html).toContain('data-cap-level="none"');
      expect(html).toContain('name="monthlyCap" type="text" inputmode="decimal" value="25,50"');
    });

    it('borrar el precio del modelo actual con el tope activo se permite', async () => {
      await start();
      await post('/admin/usage/prices', price());
      await post('/admin/usage/settings', { currency: 'USD', capEnabled: 'on', monthlyCap: '10' });
      const res = await post('/admin/usage/prices/delete', { model: TEST_LLM_MODEL });
      expect(res.statusCode).toBe(303);
      expect((await readUsageSettings(t.db)).capEnabled).toBe(true);
    });
  });

  describe('012: tope diario de WhatsApp y precios de transcripción', () => {
    const STT = TEST_STT_MODEL;
    const audio = () => ({ stt: new FakeSpeechToText(), media: new FakeMediaFetcher() });

    async function startWith(opts: TestBotOptions): Promise<TestBot> {
      bot = await createTestBot(t, opts);
      app = bot.app;
      session = await login(app);
      return bot;
    }

    it('los POST nuevos sin CSRF dan 403', async () => {
      const b = await start();
      for (const url of [
        '/admin/usage/whatsapp-cap',
        '/admin/usage/transcription-prices',
        `/admin/usage/transcription-prices/${STT}/delete`,
      ]) {
        const res = await b.app.inject({
          method: 'POST',
          url,
          headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
          payload: encodeForm({ whatsappDailyCap: '5', model: STT, perMinute: '1' }),
        });
        expect([url, res.statusCode]).toEqual([url, 403]);
      }
    });

    it('con WhatsApp: «Tope diario de WhatsApp» con hoy / tope; sin audios no hay precios de transcripción', async () => {
      await start();
      await t.db.insert(whatsappUsageDay).values({ day: '2026-09-24', replies: 7 });
      const html = await page();
      expect(html).toContain('<h2>Tope diario de WhatsApp</h2>');
      expect(html).toContain('Respuestas con el modelo hoy: 7 / 200');
      expect(html).not.toContain('Precios de transcripción');
      expect(html).toContain('En producción el tope de gasto es obligatorio');
    });

    it('sin WhatsApp, la sección solo aparece si ya hay datos', async () => {
      await startWith({ whatsapp: false });
      expect(await page()).not.toContain('Tope diario de WhatsApp');
      await t.db.insert(whatsappUsageDay).values({ day: '2026-09-20', replies: 3 });
      expect(await page()).toContain('Tope diario de WhatsApp');
    });

    it('tope diario: 303 y 422 por rango con el mensaje', async () => {
      await start();
      for (const value of ['0', '10001', 'abc', '1,5', '']) {
        const res = await post('/admin/usage/whatsapp-cap', { whatsappDailyCap: value });
        expect([value, res.statusCode]).toEqual([value, 422]);
        expect(fieldErrorsIn(res.body)).toEqual(['whatsappDailyCap']);
        expect(res.body).toContain(WHATSAPP_CAP_MESSAGE);
      }
      expect(await readWhatsappCap(t.db)).toBe(200);
      const ok = await post('/admin/usage/whatsapp-cap', { whatsappDailyCap: '50' });
      expect(ok.statusCode).toBe(303);
      expect(ok.headers.location).toBe('/admin/usage');
      expect(await readWhatsappCap(t.db)).toBe(50);
      expect(await page()).toContain('Respuestas con el modelo hoy: 0 / 50');
    });

    it('con audios: aviso del modelo sin precio, alta, cambio y borrado (303 / 404 / 422)', async () => {
      await startWith({ audio: audio() });
      const html = await page();
      expect(html).toContain('<h2>Precios de transcripción</h2>');
      expect(html).toContain(`El modelo de transcripción «${STT}» no tiene precio.`);
      expect(html).toContain(`id="transcriptionModel" name="model" type="text" value="${STT}"`);

      const bad = await post('/admin/usage/transcription-prices', { model: ' ', perMinute: '-1' });
      expect(bad.statusCode).toBe(422);
      expect(fieldErrorsIn(bad.body).sort()).toEqual(['perMinute', 'transcriptionModel']);
      expect(await t.db.select().from(transcriptionPrice)).toEqual([]);

      expect(
        (await post('/admin/usage/transcription-prices', { model: STT, perMinute: '0,006' }))
          .statusCode,
      ).toBe(303);
      await post('/admin/usage/transcription-prices', { model: STT, perMinute: '0.01' });
      const [row] = await t.db.select().from(transcriptionPrice);
      expect(row).toMatchObject({ model: STT, microsPerMinute: 10_000n });
      const after = await page();
      expect(after).toContain(`${STT} <span class="badge badge-ok">modelo actual</span>`);
      expect(after).not.toContain(`El modelo de transcripción «${STT}» no tiene precio.`);

      const missing = await post('/admin/usage/transcription-prices/no-existe/delete', {});
      expect(missing.statusCode).toBe(404);
      const deleted = await post(`/admin/usage/transcription-prices/${STT}/delete`, {});
      expect(deleted.statusCode).toBe(303);
      expect(await t.db.select().from(transcriptionPrice)).toEqual([]);
    });

    it('sin audios, la sección aparece si ya hay precios (para poder borrarlos)', async () => {
      await start();
      await t.db.insert(transcriptionPrice).values({ model: 'antiguo', microsPerMinute: 1n });
      expect(await page()).toContain('<h2>Precios de transcripción</h2>');
      expect((await post('/admin/usage/transcription-prices/antiguo/delete', {})).statusCode).toBe(
        303,
      );
    });

    it('cambiar la moneda exige también la tabla de transcripción vacía', async () => {
      await start();
      await t.db.insert(transcriptionPrice).values({ model: STT, microsPerMinute: 1n });
      const res = await post('/admin/usage/settings', { currency: 'EUR' });
      expect(res.statusCode).toBe(422);
      expect(fieldErrorsIn(res.body)).toEqual(['currency']);
    });

    describe('en producción con el negocio activo (FR-003)', () => {
      async function production(): Promise<TestBot> {
        const b = await startWith({ production: true, audio: audio() });
        await post('/admin/usage/prices', price());
        await post('/admin/usage/transcription-prices', { model: STT, perMinute: '0,006' });
        await post('/admin/usage/settings', {
          currency: 'USD',
          capEnabled: 'on',
          monthlyCap: '10',
        });
        expect((await readUsageSettings(t.db)).capEnabled).toBe(true);
        return b;
      }

      it('desactivar el tope da 422 en capEnabled', async () => {
        await production();
        const res = await post('/admin/usage/settings', { currency: 'USD', monthlyCap: '10' });
        expect(res.statusCode).toBe(422);
        expect(fieldErrorsIn(res.body)).toEqual(['capEnabled']);
        expect(res.body).toContain(
          'En producción el tope de gasto es obligatorio mientras el negocio está activo.',
        );
        expect((await readUsageSettings(t.db)).capEnabled).toBe(true);
      });

      it('borrar el precio de LLM_MODEL o de STT_MODEL da 422; otros se borran', async () => {
        await production();
        const llm = await post('/admin/usage/prices/delete', { model: TEST_LLM_MODEL });
        expect(llm.statusCode).toBe(422);
        expect(llm.body).toContain(PRICE_IN_USE_MESSAGE);
        const stt = await post(`/admin/usage/transcription-prices/${STT}/delete`, {});
        expect(stt.statusCode).toBe(422);
        expect(stt.body).toContain(PRICE_IN_USE_MESSAGE);
        expect(await t.db.select().from(modelPrice)).toHaveLength(1);
        expect(await t.db.select().from(transcriptionPrice)).toHaveLength(1);

        await post('/admin/usage/prices', price({ model: 'otro-modelo' }));
        expect(
          (await post('/admin/usage/prices/delete', { model: 'otro-modelo' })).statusCode,
        ).toBe(303);
      });

      it('con el negocio desactivado se permite', async () => {
        await production();
        await t.db.update(business).set({ status: 'draft' });
        expect(
          (await post('/admin/usage/prices/delete', { model: TEST_LLM_MODEL })).statusCode,
        ).toBe(303);
        expect((await post(`/admin/usage/transcription-prices/${STT}/delete`, {})).statusCode).toBe(
          303,
        );
        expect(
          (await post('/admin/usage/settings', { currency: 'USD', monthlyCap: '10' })).statusCode,
        ).toBe(303);
      });

      it('el tope diario del chat web no baja de 1 (FR-011)', async () => {
        await production();
        const res = await post('/admin/web-chat', {
          allowed_origins: 'https://negocio.example',
          privacy_url: 'https://negocio.example/privacidad',
          daily_cap: '0',
          monthly_cap: '3000',
        });
        expect(res.statusCode).toBe(422);
        expect(fieldErrorsIn(res.body)).toContain('daily_cap');
      });
    });
  });

  describe('012: límites de derivación (US2)', () => {
    const LIMITS = { dailyMax: '5', forwardIntervalMinutes: '30', noticesDailyMax: '40' };

    it('POST sin CSRF da 403', async () => {
      const b = await start();
      const res = await b.app.inject({
        method: 'POST',
        url: '/admin/usage/handoff-limits',
        headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: encodeForm(LIMITS),
      });
      expect(res.statusCode).toBe(403);
      expect(await readHandoffLimits(t.db)).toEqual(defaultHandoffLimits);
    });

    it('muestra los límites y los contadores de hoy', async () => {
      await start();
      await t.db
        .insert(handoffDay)
        .values({ day: '2026-09-24', started: 3, refused: 2, notices: 7, noticesHeld: 1 });
      const html = await page();
      expect(html).toContain('<h2>Límites de derivación</h2>');
      expect(html).toMatch(/name="dailyMax"[^>]*value="20"/);
      expect(html).toMatch(/name="forwardIntervalMinutes"[^>]*value="15"/);
      expect(html).toMatch(/name="noticesDailyMax"[^>]*value="60"/);
      expect(html).toContain('Derivaciones nuevas hoy: 3 / 20');
      expect(html).toContain('Peticiones sin aviso hoy: 2');
      expect(html).toContain('Avisos al negocio hoy: 7 / 60');
      expect(html).toContain('Avisos retenidos hoy: 1');
    });

    it('422 con un error por campo y su rango; 303 guarda', async () => {
      await start();
      const bad = await post('/admin/usage/handoff-limits', {
        dailyMax: '0',
        forwardIntervalMinutes: '241',
        noticesDailyMax: 'muchos',
      });
      expect(bad.statusCode).toBe(422);
      expect(fieldErrorsIn(bad.body).sort()).toEqual([
        'dailyMax',
        'forwardIntervalMinutes',
        'noticesDailyMax',
      ]);
      expect(bad.body).toContain('Indica un número entero entre 1 y 200');
      expect(bad.body).toContain('Indica un número entero entre 5 y 240');
      expect(bad.body).toContain('Indica un número entero entre 10 y 500');
      // El formulario se repinta con lo enviado.
      expect(bad.body).toMatch(/name="noticesDailyMax"[^>]*value="muchos"/);
      expect(await readHandoffLimits(t.db)).toEqual(defaultHandoffLimits);

      const ok = await post('/admin/usage/handoff-limits', LIMITS);
      expect(ok.statusCode).toBe(303);
      expect(ok.headers.location).toBe('/admin/usage');
      expect(await readHandoffLimits(t.db)).toEqual({
        dailyMax: 5,
        forwardIntervalMinutes: 30,
        noticesDailyMax: 40,
      });
      expect(await page()).toContain('Derivaciones nuevas hoy: 0 / 5');
    });
  });

  // 017: «sin bot» es «sin la credencial del proveedor declarado», no la de uno concreto.
  describe('sin bot (sin credencial del modelo)', () => {
    it('tablas vacías con el aviso, y precios y ajustes siguen editables', async () => {
      await resetDb(t.db);
      app = await buildTestApp(t.db, undefined, null, { LLM_MODEL: TEST_LLM_MODEL });
      try {
        session = await login(app);
        const html = await page();
        expect(html).toContain('Esta instancia no tiene bot: no hay consumo.');
        expect(html).toContain('action="/admin/usage/prices"');
        expect((await post('/admin/usage/prices', price())).statusCode).toBe(303);
        await t.db.update(usageSettings).set({ currency: 'USD' });
        expect(
          (
            await post('/admin/usage/settings', {
              currency: 'USD',
              capEnabled: 'on',
              monthlyCap: '5',
            })
          ).statusCode,
        ).toBe(303);
      } finally {
        await app.close();
      }
    });
  });
});
