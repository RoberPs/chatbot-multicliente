/**
 * Contrato de la pantalla "Consumo" (010 US2 y US3, contracts/admin-usage-screen.md): consumo de
 * hoy y del mes por canal, meses conservados, precios por modelo, moneda y tope mensual.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { modelPrice, modelUsage, usageSettings } from '../../../src/db/schema.js';
import { readUsageSettings } from '../../../src/usage/settings.js';
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
import { createTestBot, TEST_LLM_MODEL, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

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

  describe('sin bot (sin ANTHROPIC_API_KEY)', () => {
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
