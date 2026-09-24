/** Objetivos de rendimiento del plan: snapshot p95 < 50 ms y guardado de formulario p95 < 300 ms. */
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import { buildTestApp, login, postForm, type Session } from '../helpers/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';

const p95 = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Infinity;
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
