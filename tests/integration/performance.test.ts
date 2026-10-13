/**
 * Objetivos de rendimiento del plan: snapshot p95 < 50 ms y guardado de formulario p95 < 300 ms.
 * 010: lo que la medición añade a cada respuesta < 100 ms (SC-006) y `/admin/usage` < 500 ms con
 * 50 000 registros en el mes.
 */
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import { createUsageMeter } from '../../src/usage/meter.js';
import { checkSpendCap } from '../../src/usage/spend-cap.js';
import { buildTestApp, get, login, postForm, type Session } from '../helpers/app.js';
import { createTestBot, TEST_LLM_MODEL, type TestBot } from '../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { RecordingActivityLog, tokens } from '../helpers/fakes.js';

const p95 = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
};

const median = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Infinity;
};

async function time(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

describe('rendimiento con 100 servicios, 20 recursos y 100 FAQ', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;
  let serviceId = '';

  beforeAll(async () => {
    t = await createTestDatabase();
    // Carga masiva directa en SQL: el objetivo es medir la lectura y el guardado, no la carga.
    await t.db.execute(sql`
      insert into service (name, price_type, price_cents, duration_minutes, bookable, sort_order)
      select 'Servicio ' || g, 'fixed', 1000 + g, 30, true, g from generate_series(1, 100) g`);
    await t.db.execute(sql`
      insert into resource (name, sort_order) select 'Recurso ' || g, g from generate_series(1, 20) g`);
    await t.db.execute(sql`
      insert into resource_service (resource_id, service_id)
      select r.id, s.id from resource r cross join service s where (s.sort_order + r.sort_order) % 4 = 0`);
    await t.db.execute(sql`
      insert into resource_hours (resource_id, weekday, start_time, end_time)
      select r.id, d, '09:00', '14:00' from resource r cross join generate_series(1, 5) d`);
    await t.db.execute(sql`
      insert into business_hours (weekday, start_time, end_time)
      select d, '09:00', '20:00' from generate_series(1, 6) d`);
    await t.db.execute(sql`
      insert into faq (question, answer, sort_order)
      select 'Pregunta ' || g, repeat('Respuesta larga. ', 20), g from generate_series(1, 100) g`);
    await t.db.execute(sql`update business set name = 'Negocio', phone = '+34600123456'`);
    const rows = await t.db.execute<{ id: string }>(
      sql`select id from service order by sort_order limit 1`,
    );
    serviceId = rows.rows[0]?.id ?? '';
    app = await buildTestApp(t.db);
    session = await login(app);
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it('getSnapshot() p95 < 50 ms', async () => {
    const reader = createKnowledgeReader(t.db);
    for (let i = 0; i < 5; i++) await reader.getSnapshot();
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) samples.push(await time(() => reader.getSnapshot()));
    const snap = await reader.getSnapshot();
    expect(snap.services).toHaveLength(100);
    expect(snap.faqs).toHaveLength(100);
    process.stderr.write(`getSnapshot p95 = ${p95(samples).toFixed(1)} ms\n`);
    expect(p95(samples), `p95 = ${p95(samples).toFixed(1)} ms`).toBeLessThan(50);
  });

  it('POST /admin/services/:id p95 < 300 ms', async () => {
    const save = (i: number) =>
      postForm(app, session, `/admin/services/${serviceId}`, {
        name: 'Servicio 1',
        price_type: 'fixed',
        price: String(10 + (i % 5)),
        duration: '30',
        bookable: true,
        active: true,
      });
    for (let i = 0; i < 3; i++) await save(i);
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      samples.push(
        await time(async () => {
          expect((await save(i)).statusCode).toBe(303);
        }),
      );
    }
    process.stderr.write(`POST /admin/services/:id p95 = ${p95(samples).toFixed(1)} ms\n`);
    expect(p95(samples), `p95 = ${p95(samples).toFixed(1)} ms`).toBeLessThan(300);
  });
});

describe('consumo (010) con 50 000 registros en el mes', () => {
  let t: TestDatabase;
  let bot: TestBot;
  let session: Session;

  beforeAll(async () => {
    t = await createTestDatabase();
    bot = await createTestBot(t);
    session = await login(bot.app);
    await t.db.execute(sql`
      insert into model_price (model, input_micros_per_mtok, output_micros_per_mtok,
                               cache_write_micros_per_mtok, cache_read_micros_per_mtok)
      values (${TEST_LLM_MODEL}, 3000000, 15000000, 3750000, 300000)`);
    await t.db.execute(sql`
      update usage_settings set cap_enabled = true, monthly_cap_cents = 100000000`);
    // Carga masiva directa en SQL, repartida por los días del mes y los tres canales.
    await t.db.execute(sql`
      insert into model_usage (at, day, channel, purpose, model, calls, input_tokens,
                               output_tokens, cache_write_tokens, cache_read_tokens,
                               cost_pico, currency)
      select timestamptz '2026-09-01 08:00+00' + (g % 24) * interval '1 day',
             date '2026-09-01' + (g % 24),
             (array['whatsapp', 'web', 'playground'])[1 + g % 3]::customer_channel,
             (case when g % 10 = 0 then 'handoff_summary' else 'reply' end)::usage_purpose,
             ${TEST_LLM_MODEL}, 1, 1200, 300, 0, 800, 8340000000, 'USD'
      from generate_series(1, 50000) g`);
  }, 120_000);
  afterAll(async () => {
    await bot.close();
    await t.close();
  });

  it('lo que la medición añade a una respuesta: mediana < 100 ms (SC-006)', async () => {
    const log = new RecordingActivityLog();
    const meter = createUsageMeter({ db: t.db, activityLog: log });
    // Antes del modelo: el tope; después: el registro (contracts/usage-recording.md, R3).
    const overhead = async () => {
      const now = bot.clock.now();
      await checkSpendCap(t.db, now, 'Europe/Madrid', log);
      await meter.record({
        channel: 'whatsapp',
        purpose: 'reply',
        model: TEST_LLM_MODEL,
        usage: { calls: 1, unmeasuredCalls: 0, tokens: tokens(1200, 300, 0, 800) },
        at: now,
        timezone: 'Europe/Madrid',
      });
    };
    for (let i = 0; i < 5; i++) await overhead();
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) samples.push(await time(overhead));
    expect(log.named('usage_record_failed')).toEqual([]);
    process.stderr.write(`medición por respuesta, mediana = ${median(samples).toFixed(1)} ms\n`);
    expect(median(samples), `mediana = ${median(samples).toFixed(1)} ms`).toBeLessThan(100);
  });

  it('GET /admin/usage < 500 ms', async () => {
    for (let i = 0; i < 2; i++) await get(bot.app, session, '/admin/usage');
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      samples.push(
        await time(async () => {
          expect((await get(bot.app, session, '/admin/usage')).statusCode).toBe(200);
        }),
      );
    }
    process.stderr.write(`GET /admin/usage mediana = ${median(samples).toFixed(1)} ms\n`);
    expect(median(samples), `mediana = ${median(samples).toFixed(1)} ms`).toBeLessThan(500);
  });
});
