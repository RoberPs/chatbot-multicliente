/**
 * Resumen del consumo para el panel (010 US2; FR-007 – FR-010, FR-012, SC-002): por canal,
 * «Clientes finales» (WhatsApp + web) e «Instancia», con coste exacto por moneda (sumado antes de
 * redondear), modelos sin precio, desglose por día y meses conservados.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { modelUsage } from '../../../src/db/schema.js';
import {
  currentPeriods,
  retainedMonths,
  summarizeDays,
  summarizePeriod,
} from '../../../src/usage/summary.js';
import type { UsagePurpose } from '../../../src/usage/types.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';
import { tokens } from '../../helpers/fakes.js';

type Seed = {
  day: string;
  channel: 'whatsapp' | 'web' | 'playground';
  purpose?: UsagePurpose;
  model?: string;
  calls?: number;
  t?: [number, number, number, number];
  cost?: bigint | null;
  currency?: string | null;
};

describe('resumen del consumo', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDb(t.db);
  });

  const seed = (rows: Seed[]) =>
    t.db.insert(modelUsage).values(
      rows.map((r) => {
        const [input, output, cacheWrite, cacheRead] = r.t ?? [100, 10, 0, 0];
        const cost = r.cost === undefined ? 1_000_000_000n : r.cost;
        return {
          at: new Date(`${r.day}T12:00:00Z`),
          day: r.day,
          channel: r.channel,
          purpose: r.purpose ?? 'reply',
          model: r.model ?? 'modelo-x',
          calls: r.calls ?? 1,
          inputTokens: input,
          outputTokens: output,
          cacheWriteTokens: cacheWrite,
          cacheReadTokens: cacheRead,
          costPico: cost,
          currency: cost === null ? null : (r.currency ?? 'USD'),
        };
      }),
    );

  it('agrupa por canal, clientes finales e instancia con coste exacto', async () => {
    await seed([
      { day: '2026-09-10', channel: 'whatsapp', t: [1000, 200, 0, 500], cost: 6_000_000_000n },
      { day: '2026-09-11', channel: 'whatsapp', calls: 2, t: [2000, 300, 100, 0], cost: 1n },
      { day: '2026-09-11', channel: 'whatsapp', purpose: 'handoff_summary', t: [300, 50, 0, 0] },
      { day: '2026-09-12', channel: 'web', t: [500, 100, 0, 0], cost: 49_999_999n },
      { day: '2026-09-12', channel: 'playground', t: [700, 70, 0, 0], cost: 2_000_000_000n },
      // Fuera del periodo.
      { day: '2026-08-31', channel: 'whatsapp', cost: 999_000_000_000n },
      { day: '2026-10-01', channel: 'web', cost: 999_000_000_000n },
    ]);

    const s = await summarizePeriod(t.db, { first: '2026-09-01', last: '2026-09-30' });
    expect(s.period).toEqual({ first: '2026-09-01', last: '2026-09-30' });
    expect(s.byChannel.whatsapp).toMatchObject({
      calls: 4,
      replies: 2,
      summaries: 1,
      tokens: tokens(3300, 550, 100, 500),
      unpricedModels: [],
    });
    expect(s.byChannel.whatsapp.cost).toEqual(new Map([['USD', 7_000_000_001n]]));
    expect(s.byChannel.web).toMatchObject({ replies: 1, summaries: 0, tokens: tokens(500, 100) });
    expect(s.byChannel.web.cost).toEqual(new Map([['USD', 49_999_999n]]));
    expect(s.customers).toMatchObject({
      replies: 3,
      summaries: 1,
      tokens: tokens(3800, 650, 100, 500),
    });
    // Suma exacta antes de redondear (SC-002).
    expect(s.customers.cost).toEqual(new Map([['USD', 7_049_999_999n + 1n]]));
    expect(s.instance).toMatchObject({
      replies: 4,
      summaries: 1,
      tokens: tokens(4500, 720, 100, 500),
    });
    expect(s.instance.cost).toEqual(new Map([['USD', 9_050_000_000n]]));
  });

  it('un canal sin consumo sale a cero', async () => {
    await seed([{ day: '2026-09-10', channel: 'whatsapp' }]);
    const s = await summarizePeriod(t.db, { first: '2026-09-01', last: '2026-09-30' });
    expect(s.byChannel.web).toEqual({
      calls: 0,
      // 017: sin consumo no hay nada que no se haya medido, y ningún concepto queda «sin dato»:
      // un canal sin llamadas no afirma que el modelo no informe de nada.
      unmeasuredCalls: 0,
      replies: 0,
      summaries: 0,
      tokens: tokens(0, 0),
      cache: { write: 'reported', read: 'reported' },
      cost: new Map(),
      unpricedModels: [],
    });
  });

  it('lista los modelos sin precio y separa el coste por moneda', async () => {
    await seed([
      { day: '2026-09-10', channel: 'whatsapp', cost: 5n, currency: 'USD' },
      { day: '2026-09-10', channel: 'whatsapp', cost: 7n, currency: 'EUR' },
      { day: '2026-09-10', channel: 'whatsapp', model: 'sin-precio', cost: null },
      { day: '2026-09-10', channel: 'playground', model: 'otro-sin-precio', cost: null },
    ]);
    const s = await summarizePeriod(t.db, { first: '2026-09-01', last: '2026-09-30' });
    expect(s.byChannel.whatsapp.cost).toEqual(
      new Map([
        ['EUR', 7n],
        ['USD', 5n],
      ]),
    );
    expect(s.byChannel.whatsapp.unpricedModels).toEqual(['sin-precio']);
    expect(s.byChannel.whatsapp.replies).toBe(3);
    expect(s.customers.unpricedModels).toEqual(['sin-precio']);
    expect(s.instance.unpricedModels).toEqual(['otro-sin-precio', 'sin-precio']);
  });

  it('los periodos de hoy y del mes son los de la zona del negocio (US2-6)', () => {
    // 12:30 UTC del 30/09 = 01:30 del 01/10 en Auckland (NZDT, UTC+13).
    const now = new Date('2026-09-30T12:30:00Z');
    expect(currentPeriods(now, 'Pacific/Auckland')).toEqual({
      today: { first: '2026-10-01', last: '2026-10-01' },
      month: { first: '2026-10-01', last: '2026-10-31' },
    });
    expect(currentPeriods(now, 'UTC')).toEqual({
      today: { first: '2026-09-30', last: '2026-09-30' },
      month: { first: '2026-09-01', last: '2026-09-30' },
    });
  });

  it('el desglose por día solo trae los días del mes con consumo', async () => {
    await seed([
      { day: '2026-09-03', channel: 'whatsapp', cost: 1n },
      { day: '2026-09-03', channel: 'web', cost: 2n },
      { day: '2026-09-20', channel: 'playground', cost: 4n },
      { day: '2026-10-01', channel: 'web', cost: 8n },
    ]);
    const days = await summarizeDays(t.db, '2026-09');
    expect(days.map((d) => d.day)).toEqual(['2026-09-03', '2026-09-20']);
    expect(days[0]?.row).toMatchObject({ replies: 2, cost: new Map([['USD', 3n]]) });
    expect(days[1]?.row).toMatchObject({ replies: 1, cost: new Map([['USD', 4n]]) });
  });

  it('meses conservados con consumo, del más reciente al más antiguo (FR-009)', async () => {
    await seed([
      { day: '2025-08-31', channel: 'whatsapp' }, // anterior al corte de retención
      { day: '2025-09-01', channel: 'whatsapp' },
      { day: '2026-02-14', channel: 'web' },
      { day: '2026-02-15', channel: 'web' },
      { day: '2026-09-24', channel: 'playground' },
    ]);
    expect(await retainedMonths(t.db, new Date('2026-09-24T08:00:00Z'), 'Europe/Madrid')).toEqual([
      '2026-09',
      '2026-02',
      '2025-09',
    ]);
  });
});
