/**
 * «Sin dato» no se parece a un cero en la pantalla de consumo (017, FR-024, FR-008, SC-012;
 * contracts/usage-unmeasured.md §4).
 *
 * El fallo que esto impide es silencioso y caro: el operador mira la columna de escritura en caché,
 * ve `0`, y concluye que su modelo no escribe caché. Lo que pasa en realidad es que el proveedor no
 * informa de ese dato, y el coste estimado no lo valora. Las dos cosas se ven igual si nadie las
 * distingue en la pantalla.
 *
 * Y lo que la nota **no** puede decir: quién es el proveedor (FR-008). El panel lo deduce de lo
 * registrado, nunca de su nombre.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { modelUsage } from '../../../src/db/schema.js';
import { LLM_PROVIDERS } from '../../../src/llm/provider.js';
import type { UsagePurpose } from '../../../src/usage/types.js';
import { get, login, type Session } from '../../helpers/app.js';
import { createTestBot, TEST_LLM_MODEL, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const DAY = '2026-09-24';

describe('Consumo: «sin dato» frente a cero (/admin/usage)', () => {
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

  /** Fila de consumo; `cacheWriteTokens: null` es «el proveedor no informa del concepto». */
  const seed = (
    rows: Array<{
      cacheWriteTokens?: number | null;
      cacheReadTokens?: number | null;
      unmeasuredCalls?: number;
      calls?: number;
      purpose?: UsagePurpose;
      channel?: 'whatsapp' | 'web' | 'playground';
    }>,
  ) =>
    t.db.insert(modelUsage).values(
      rows.map((r) => ({
        at: new Date('2026-09-24T08:00:00Z'),
        day: DAY,
        channel: r.channel ?? ('whatsapp' as const),
        purpose: r.purpose ?? ('reply' as const),
        model: TEST_LLM_MODEL,
        calls: r.calls ?? 1,
        unmeasuredCalls: r.unmeasuredCalls ?? 0,
        inputTokens: 1200,
        outputTokens: 300,
        cacheWriteTokens: r.cacheWriteTokens === undefined ? 0 : r.cacheWriteTokens,
        cacheReadTokens: r.cacheReadTokens === undefined ? 800 : r.cacheReadTokens,
        costPico: 1_234_560_000_000n,
        currency: 'USD',
      })),
    );

  const page = async () => {
    const res = await get(app, session, '/admin/usage');
    expect(res.statusCode).toBe(200);
    return res.body;
  };

  /** Celdas de la fila `label` de la tabla `table`, sin etiquetas. */
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

  /** Bloque de la nota genérica, si está. */
  const noteOf = (html: string) =>
    html.includes('data-usage-no-data')
      ? (html.split('data-usage-no-data')[1]?.split('</div>')[0] ?? '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      : null;

  it('un concepto que el modelo no informa sale «sin dato», no 0', async () => {
    await start();
    await seed([{ cacheWriteTokens: null }, { cacheWriteTokens: null }]);
    const html = await page();
    const cells = rowCells(html, 'today', 'WhatsApp');
    // 4 = escritura en caché, 5 = lectura de caché.
    expect(cells[4]).toBe('sin dato');
    expect(cells[5]).toBe('1600');
  });

  it('un cero medido sigue saliendo 0, que es lo que se midió', async () => {
    await start();
    await seed([{ cacheWriteTokens: 0 }]);
    const html = await page();
    expect(rowCells(html, 'today', 'WhatsApp')[4]).toBe('0');
    expect(noteOf(html)).toBeNull();
  });

  it('un periodo parcial muestra lo medido y se marca como incompleto', async () => {
    await start();
    await seed([{ cacheWriteTokens: 500 }, { cacheWriteTokens: null }]);
    const html = await page();
    expect(rowCells(html, 'today', 'WhatsApp')[4]).toBe('500 (parcial)');
    expect(noteOf(html)).toContain('escritura en caché');
  });

  it('la nota dice «el modelo configurado» y no nombra a ningún proveedor', async () => {
    await start();
    await seed([{ cacheWriteTokens: null, cacheReadTokens: null }]);
    const html = await page();
    const note = noteOf(html);
    expect(note).toContain('El modelo configurado no informa de');
    expect(note).toContain('la escritura en caché');
    expect(note).toContain('la lectura de caché');
    // FR-008: ni el nombre del proveedor ni el de su variable de credencial, en toda la página.
    for (const provider of LLM_PROVIDERS) {
      expect(html.toLowerCase()).not.toContain(provider);
    }
    expect(html).not.toContain('API_KEY');
  });

  it('las respuestas no medidas se ven junto a las respuestas con modelo, y en una nota', async () => {
    await start();
    await seed([{ calls: 2, unmeasuredCalls: 2 }, { calls: 1, unmeasuredCalls: 0 }]);
    const html = await page();
    expect(rowCells(html, 'today', 'WhatsApp')[0]).toBe('2 (2 llamadas sin medir)');
    expect(noteOf(html)).toContain('no informaron');
  });

  it('sin respuestas no medidas y con todo informado no hay nota ninguna', async () => {
    await start();
    await seed([{ cacheWriteTokens: 300, cacheReadTokens: 800 }]);
    const html = await page();
    expect(noteOf(html)).toBeNull();
    expect(rowCells(html, 'today', 'WhatsApp')[0]).toBe('1');
  });

  // Una transcripción guarda 0 en los conceptos de caché porque no tiene caché. Si contara, la
  // pantalla pasaría de «sin dato» a «parcial» por haber transcrito un audio.
  it('una transcripción no convierte un «sin dato» en parcial', async () => {
    await start();
    await seed([
      { cacheWriteTokens: null },
      { purpose: 'transcription', cacheWriteTokens: 0, cacheReadTokens: 0 },
    ]);
    const html = await page();
    expect(rowCells(html, 'today', 'WhatsApp')[4]).toBe('sin dato');
  });
});
