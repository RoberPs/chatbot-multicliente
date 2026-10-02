/**
 * Retención del consumo (010, FR-006, R14): la pasada horaria borra los registros con `day`
 * anterior al primer día del mes local de hace 12 meses (zona del negocio; UTC sin negocio) y
 * conserva ese mes, los 11 siguientes y el actual. Precios y ajustes no caducan.
 */
import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRetention } from '../../../src/conversation/retention.js';
import { business, modelPrice, modelUsage, usageSettings } from '../../../src/db/schema.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';
import { ManualClock, RecordingActivityLog } from '../../helpers/fakes.js';

const DAYS = [
  '2025-07-15',
  '2025-08-31',
  '2025-09-01',
  '2025-12-31',
  '2026-08-31',
  '2026-09-01',
  '2026-09-24',
];

describe('retención de model_usage', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDb(t.db);
    await t.db.insert(modelUsage).values(
      DAYS.map((day) => ({
        at: new Date(`${day}T12:00:00Z`),
        day,
        channel: 'whatsapp' as const,
        purpose: 'reply' as const,
        model: 'modelo-de-prueba',
        calls: 1,
        inputTokens: 100,
        outputTokens: 10,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
      })),
    );
    await t.db.insert(modelPrice).values({
      model: 'modelo-de-prueba',
      inputMicrosPerMtok: 3_000_000n,
      outputMicrosPerMtok: 15_000_000n,
      cacheWriteMicrosPerMtok: 0n,
      cacheReadMicrosPerMtok: 0n,
    });
  });

  const purgeAt = (iso: string) =>
    createRetention({
      db: t.db,
      clock: new ManualClock(iso),
      activityLog: new RecordingActivityLog(),
    }).purge();
  const days = async () =>
    (await t.db.select({ day: modelUsage.day }).from(modelUsage).orderBy(asc(modelUsage.day))).map(
      (r) => r.day,
    );

  it('conserva el mes de hace 12 meses, los 11 siguientes y el actual', async () => {
    await purgeAt('2026-09-24T08:00:00Z');
    expect(await days()).toEqual(DAYS.slice(2));
  });

  it('el corte de mes es el local del negocio', async () => {
    // 22:30 UTC del 31/08 = 00:30 del 01/09 en Madrid: ya es septiembre.
    await purgeAt('2026-08-31T22:30:00Z');
    expect(await days()).toEqual(DAYS.slice(2));
  });

  it('sin negocio usa UTC', async () => {
    await t.db.delete(business);
    // En UTC sigue siendo agosto: el corte es el 01/08/2025.
    await purgeAt('2026-08-31T22:30:00Z');
    expect(await days()).toEqual(DAYS.slice(1));
  });

  it('no toca model_price ni usage_settings', async () => {
    await purgeAt('2027-12-01T08:00:00Z');
    expect(await days()).toEqual([]);
    expect(await t.db.select().from(modelPrice)).toHaveLength(1);
    expect(await t.db.select().from(usageSettings)).toHaveLength(1);
  });
});
