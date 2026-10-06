/**
 * Estado del tope de gasto (010 US3; data-model.md §3 y §5, R7, R10): una consulta sin caché que
 * da el nivel en los bordes, cuenta playground y resúmenes, ignora lo sin precio y lo de otra
 * moneda, y usa el mes local; el evento del mes se concede una sola vez.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { modelUsage, usageSettings } from '../../../src/db/schema.js';
import { checkSpendCap, markNotified, spendCapState } from '../../../src/usage/spend-cap.js';
import type { UsagePurpose } from '../../../src/usage/types.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';
import { RecordingActivityLog } from '../../helpers/fakes.js';

/** Billonésimas por céntimo. */
const CENT = 10_000_000_000n;
const NOW = new Date('2026-09-24T08:00:00Z');
const TZ = 'Europe/Madrid';

describe('estado del tope de gasto', () => {
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

  const setCap = (cents: number | null, enabled = true) =>
    t.db.update(usageSettings).set({ capEnabled: enabled, monthlyCapCents: cents });
  const spend = (
    cost: bigint | null,
    opts: {
      day?: string;
      currency?: string;
      channel?: 'whatsapp' | 'web' | 'playground';
      purpose?: UsagePurpose;
    } = {},
  ) =>
    t.db.insert(modelUsage).values({
      at: NOW,
      day: opts.day ?? '2026-09-24',
      channel: opts.channel ?? 'whatsapp',
      purpose: opts.purpose ?? 'reply',
      model: 'modelo-x',
      calls: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      costPico: cost,
      currency: cost === null ? null : (opts.currency ?? 'USD'),
    });
  const level = async () => (await spendCapState(t.db, NOW, TZ)).level;

  it('sin tope activo: none, aunque haya importe y gasto', async () => {
    await setCap(100, false);
    await spend(1000n * CENT);
    expect(await spendCapState(t.db, NOW, TZ)).toEqual({
      level: 'none',
      spentPico: 1000n * CENT,
      capCents: 100,
      currency: 'USD',
      percent: null,
    });
  });

  it('bordes: < 80 % normal, 80 % warning, 100 % reached y por encima reached', async () => {
    await setCap(1000); // 10,00
    await spend(799n * CENT);
    expect(await spendCapState(t.db, NOW, TZ)).toMatchObject({ level: 'normal', percent: 79 });
    await spend(1n * CENT);
    expect(await spendCapState(t.db, NOW, TZ)).toMatchObject({ level: 'warning', percent: 80 });
    await spend(199n * CENT + CENT - 1n);
    expect(await spendCapState(t.db, NOW, TZ)).toMatchObject({ level: 'warning', percent: 99 });
    await spend(1n);
    expect(await spendCapState(t.db, NOW, TZ)).toMatchObject({ level: 'reached', percent: 100 });
    await spend(500n * CENT);
    expect(await spendCapState(t.db, NOW, TZ)).toMatchObject({ level: 'reached', percent: 150 });
  });

  it('suma playground y resúmenes; ignora sin precio, otra moneda y otros meses', async () => {
    await setCap(1000);
    await spend(400n * CENT, { channel: 'playground' });
    await spend(400n * CENT, { purpose: 'handoff_summary', channel: 'web' });
    await spend(null);
    await spend(5000n * CENT, { currency: 'EUR' });
    await spend(5000n * CENT, { day: '2026-08-31' });
    await spend(5000n * CENT, { day: '2026-10-01' });
    expect(await spendCapState(t.db, NOW, TZ)).toMatchObject({
      level: 'warning',
      spentPico: 800n * CENT,
      percent: 80,
    });
  });

  it('usa el mes local del negocio', async () => {
    await setCap(1000);
    await spend(2000n * CENT, { day: '2026-09-30' });
    // 22:30 UTC del 30/09 = 00:30 del 01/10 en Madrid: mes nuevo, gasto 0.
    const late = new Date('2026-09-30T22:30:00Z');
    expect((await spendCapState(t.db, late, TZ)).level).toBe('normal');
    expect((await spendCapState(t.db, late, 'UTC')).level).toBe('reached');
  });

  it('usa la moneda actual de los ajustes', async () => {
    await setCap(1000);
    await spend(2000n * CENT, { currency: 'EUR' });
    expect(await level()).toBe('normal');
    await t.db.update(usageSettings).set({ currency: 'EUR' });
    expect(await level()).toBe('reached');
  });

  it('markNotified concede el mes una sola vez, también en paralelo', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => t.db.transaction((tx) => markNotified(tx, '2026-09-01'))),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await markNotified(t.db, '2026-09-01')).toBe(false);
    expect(await markNotified(t.db, '2026-10-01')).toBe(true);
  });

  it('checkSpendCap emite spend_cap_reached una vez por mes y solo con reached', async () => {
    const log = new RecordingActivityLog();
    await setCap(1000);
    await spend(900n * CENT);
    expect((await checkSpendCap(t.db, NOW, TZ, log)).level).toBe('warning');
    expect(log.named('spend_cap_reached')).toEqual([]);

    await spend(100n * CENT);
    expect((await checkSpendCap(t.db, NOW, TZ, log)).level).toBe('reached');
    expect((await checkSpendCap(t.db, NOW, TZ, log)).level).toBe('reached');
    expect(log.named('spend_cap_reached')).toEqual([
      { event: 'spend_cap_reached', month: '2026-09' },
    ]);
  });
});
