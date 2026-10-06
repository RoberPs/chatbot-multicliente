/**
 * Banda común de protección del panel (012, contracts/admin-protection.md; FR-003, R3): en
 * producción sin tope, el aviso aparece en todas las pantallas, encima del aviso de gasto de la
 * 010; los críticos también en la portada y bloquean activar el negocio, pero no el resto de
 * escrituras; «Probar el bot» lo recuerda y sigue funcionando.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { business, faq, handoffDay, modelPrice, usageSettings } from '../../../src/db/schema.js';
import { get, login, postForm, type Session } from '../../helpers/app.js';
import { createTestBot, TEST_LLM_MODEL, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';

const ROUTES_DIR = join(import.meta.dirname, '../../../src/admin/routes');

/** Rutas GET del panel sin parámetros, sacadas de `src/admin/routes/`. */
async function adminGetPaths(): Promise<string[]> {
  const paths = new Set<string>();
  for (const file of await readdir(ROUTES_DIR)) {
    if (!file.endsWith('.ts')) continue;
    const source = await readFile(join(ROUTES_DIR, file), 'utf8');
    for (const m of source.matchAll(/app\.get(?:<[^>]*>)?\(\s*'([^']*)'/g)) {
      const path = m[1] ?? '';
      if (!path.includes(':')) paths.add(`/admin${path === '/' ? '' : path}`);
    }
  }
  return [...paths].sort();
}

describe('banda de protección del panel', () => {
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

  async function start(production = true): Promise<TestBot> {
    bot = await createTestBot(t, { production });
    app = bot.app;
    session = await login(app);
    return bot;
  }
  const price = () =>
    t.db.insert(modelPrice).values({
      model: TEST_LLM_MODEL,
      inputMicrosPerMtok: 3_000_000n,
      outputMicrosPerMtok: 15_000_000n,
      cacheWriteMicrosPerMtok: 0n,
      cacheReadMicrosPerMtok: 0n,
    });

  it('en producción sin tope, la banda sale en todas las pantallas con enlace a «Consumo»', async () => {
    await start();
    await price();
    const paths = await adminGetPaths();
    let pages = 0;
    for (const path of paths) {
      const res = await get(app, session, path);
      // Solo las pantallas con el layout común (la vista previa del chat es una página suelta).
      if (res.statusCode !== 200 || !res.body.includes('<nav class="sections"')) continue;
      pages += 1;
      const banner = res.body.split('data-protection-banner')[1]?.split('</div>')[0] ?? '';
      expect([path, banner.includes('data-protection-warning="SPEND_CAP_REQUIRED"')]).toEqual([
        path,
        true,
      ]);
      expect([path, banner.includes('<a href="/admin/usage">Consumo</a>')]).toEqual([path, true]);
    }
    // Todas las pantallas del menú y alguna más.
    expect(pages).toBeGreaterThanOrEqual(15);
  });

  it('va encima del aviso de gasto de la 010', async () => {
    await start();
    // Tope activo sin precio: la 010 avisa de «sin precio» y la 012 de MODEL_UNPRICED.
    await t.db.update(usageSettings).set({ capEnabled: true, monthlyCapCents: 1000 });
    const html = (await get(app, session, '/admin/faqs')).body;
    const protection = html.indexOf('data-protection-warning="MODEL_UNPRICED"');
    const spend = html.indexOf('data-spend-banner="no_price"');
    expect(protection).toBeGreaterThan(0);
    expect(spend).toBeGreaterThan(protection);
  });

  it('fuera de producción no hay banda', async () => {
    await start(false);
    const html = (await get(app, session, '/admin')).body;
    expect(html).not.toContain('data-protection-banner');
  });

  it('con avisos al negocio retenidos hoy, BUSINESS_NOTICES_HELD como aviso normal (US2)', async () => {
    await start(false);
    await t.db.insert(handoffDay).values({ day: '2026-09-24', notices: 60, noticesHeld: 3 });
    const html = (await get(app, session, '/admin/usage')).body;
    const banner = html.split('data-protection-banner')[1]?.split('</div>')[0] ?? '';
    expect(banner).toContain('data-protection-warning="BUSINESS_NOTICES_HELD"');
    expect(banner).toContain('3 avisos al negocio retenidos hoy por el límite diario de avisos.');
    expect(banner).toMatch(
      /<p class="notice" role="status" data-protection-warning="BUSINESS_NOTICES_HELD"/,
    );
    // Otro día sin retenidos: no sale.
    await t.db.delete(handoffDay);
    await t.db.insert(handoffDay).values({ day: '2026-09-23', noticesHeld: 5 });
    expect((await get(app, session, '/admin/usage')).body).not.toContain('BUSINESS_NOTICES_HELD');
  });

  it('los críticos se listan en la portada', async () => {
    await start();
    const html = (await get(app, session, '/admin')).body;
    const list = html.split('id="warnings-list"')[1]?.split('</ul>')[0] ?? '';
    expect(list).toContain('data-code="SPEND_CAP_REQUIRED"');
    expect(list).toContain('data-code="MODEL_UNPRICED"');
  });

  it('activar el negocio se rechaza con los avisos bloqueantes; con tope y precio se activa', async () => {
    await start();
    await t.db.update(business).set({ status: 'draft' });
    const res = await postForm(app, session, '/admin/status/activate', {});
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('No se puede activar el negocio mientras haya avisos críticos:');
    const blocking = res.body.split('class="general-error"')[1]?.split('</div>\n</div>')[0] ?? '';
    expect(blocking).toContain('data-code="SPEND_CAP_REQUIRED"');
    expect((await t.db.select({ status: business.status }).from(business))[0]?.status).toBe(
      'draft',
    );

    await price();
    await t.db.update(usageSettings).set({ capEnabled: true, monthlyCapCents: 1000 });
    const ok = await postForm(app, session, '/admin/status/activate', {});
    expect(ok.statusCode).toBe(303);
    expect((await t.db.select({ status: business.status }).from(business))[0]?.status).toBe(
      'active',
    );
  });

  it('el resto de escrituras del conocimiento siguen permitidas (R3)', async () => {
    await start();
    const res = await postForm(app, session, '/admin/faqs', {
      question: '¿Hay aparcamiento?',
      answer: 'Sí, gratuito.',
    });
    expect(res.statusCode).toBe(303);
    expect((await t.db.select().from(faq)).some((f) => f.question === '¿Hay aparcamiento?')).toBe(
      true,
    );
  });

  it('«Probar el bot» recuerda el motivo y sigue respondiendo con el modelo', async () => {
    const b = await start();
    const html = (await get(app, session, '/admin/playground')).body;
    expect(html).toContain(
      'En producción, los clientes reciben ahora solo el contacto: el tope de gasto está desactivado; el modelo no tiene precio.',
    );
    b.model.queue(reply('Abrimos el sábado.'));
    await b.sendVia('playground', '¿Abrís el sábado?');
    await b.settle();
    expect(b.model.calls).toHaveLength(1);
  });
});
