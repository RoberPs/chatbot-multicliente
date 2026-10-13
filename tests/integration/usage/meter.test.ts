/**
 * `UsageMeter.record` (010, contracts/usage-recording.md; FR-001 – FR-005, FR-011, FR-012, R5,
 * R6): una fila por llamada a `record`, valorada con el precio vigente y la moneda de
 * `usage_settings` en el mismo `INSERT … SELECT`; sin precio, coste y moneda nulos para siempre.
 */
import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, createDb } from '../../../src/db/client.js';
import { modelPrice, modelUsage, usageSettings } from '../../../src/db/schema.js';
import { createUsageMeter } from '../../../src/usage/meter.js';
import { costPico } from '../../../src/usage/money.js';
import type { ModelPrice, UsageRecordInput } from '../../../src/usage/types.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';
import { RecordingActivityLog, tokens } from '../../helpers/fakes.js';

const MODEL = 'modelo-de-prueba';

/** 3 / 15 / 3,75 / 0,30 por millón de tokens, en millonésimas. */
const PRICE: ModelPrice = {
  model: MODEL,
  inputMicros: 3_000_000n,
  outputMicros: 15_000_000n,
  cacheWriteMicros: 3_750_000n,
  cacheReadMicros: 300_000n,
};

const input = (overrides: Partial<UsageRecordInput> = {}): UsageRecordInput => ({
  channel: 'whatsapp',
  purpose: 'reply',
  model: MODEL,
  usage: { calls: 1, unmeasuredCalls: 0, tokens: tokens(1200, 300, 500, 2000) },
  at: new Date('2026-09-24T08:00:00Z'),
  timezone: 'Europe/Madrid',
  ...overrides,
});

describe('UsageMeter.record', () => {
  let t: TestDatabase;
  let log: RecordingActivityLog;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDb(t.db);
    log = new RecordingActivityLog();
  });

  const meter = () => createUsageMeter({ db: t.db, activityLog: log });
  const rows = () => t.db.select().from(modelUsage).orderBy(asc(modelUsage.at));
  const setPrice = (price: ModelPrice) =>
    t.db
      .insert(modelPrice)
      .values({
        model: price.model,
        inputMicrosPerMtok: price.inputMicros,
        outputMicrosPerMtok: price.outputMicros,
        cacheWriteMicrosPerMtok: price.cacheWriteMicros,
        cacheReadMicrosPerMtok: price.cacheReadMicros,
      })
      .onConflictDoUpdate({
        target: modelPrice.model,
        set: {
          inputMicrosPerMtok: price.inputMicros,
          outputMicrosPerMtok: price.outputMicros,
          cacheWriteMicrosPerMtok: price.cacheWriteMicros,
          cacheReadMicrosPerMtok: price.cacheReadMicros,
        },
      });

  it('con precio: coste = costPico y moneda de usage_settings', async () => {
    await setPrice(PRICE);
    const record = input({ usage: { calls: 2, unmeasuredCalls: 0, tokens: tokens(1200, 300, 500, 2000) } });
    await meter().record(record);

    const [row] = await rows();
    expect(row).toMatchObject({
      at: record.at,
      day: '2026-09-24',
      channel: 'whatsapp',
      purpose: 'reply',
      model: MODEL,
      calls: 2,
      inputTokens: 1200,
      outputTokens: 300,
      cacheWriteTokens: 500,
      cacheReadTokens: 2000,
      currency: 'USD',
    });
    expect(row?.costPico).toBe(costPico(record.usage.tokens, PRICE));
    expect(log.events).toEqual([]);
  });

  it('usa la moneda vigente al registrar', async () => {
    await t.db.update(usageSettings).set({ currency: 'EUR' });
    await setPrice(PRICE);
    await meter().record(input());
    expect((await rows())[0]?.currency).toBe('EUR');
  });

  it('sin precio del modelo: coste y moneda nulos (FR-012)', async () => {
    await setPrice({ ...PRICE, model: 'otro-modelo' });
    await meter().record(input({ purpose: 'handoff_summary', channel: 'playground' }));
    const [row] = await rows();
    expect(row).toMatchObject({
      purpose: 'handoff_summary',
      channel: 'playground',
      costPico: null,
      currency: null,
    });
  });

  it('cambiar el precio después no altera las filas anteriores ni las sin precio (FR-011)', async () => {
    const m = meter();
    await m.record(input({ at: new Date('2026-09-24T08:00:00Z') }));
    await setPrice(PRICE);
    await m.record(input({ at: new Date('2026-09-24T09:00:00Z') }));
    await setPrice({ ...PRICE, inputMicros: 6_000_000n, outputMicros: 30_000_000n });
    await m.record(input({ at: new Date('2026-09-24T10:00:00Z') }));

    const [unpriced, first, second] = await rows();
    expect(unpriced).toMatchObject({ costPico: null, currency: null });
    expect(first?.costPico).toBe(costPico(input().usage.tokens, PRICE));
    expect(second?.costPico).toBe(
      costPico(input().usage.tokens, {
        ...PRICE,
        inputMicros: 6_000_000n,
        outputMicros: 30_000_000n,
      }),
    );
  });

  it('day es el día local de la zona dada cerca de medianoche (R6)', async () => {
    const m = meter();
    // 22:30 UTC del 30/09 = 00:30 del 01/10 en Madrid.
    const at = new Date('2026-09-30T22:30:00Z');
    await m.record(input({ at, timezone: 'Europe/Madrid' }));
    await m.record(input({ at, timezone: 'UTC' }));
    await m.record(input({ at, timezone: 'America/New_York' }));
    expect((await rows()).map((r) => r.day)).toEqual(['2026-10-01', '2026-09-30', '2026-09-30']);
  });

  it('si la inserción falla no lanza y registra usage_record_failed (FR-005)', async () => {
    const broken = createDb(t.url);
    await closeDb(broken);
    const failing = createUsageMeter({ db: broken, activityLog: log });

    await expect(
      failing.record(input({ purpose: 'handoff_summary' }), {
        channel: 'whatsapp',
        customerKey: '+34600111222',
        conversationId: '00000000-0000-4000-8000-0000000000c1',
      }),
    ).resolves.toBeUndefined();
    expect(log.named('usage_record_failed')).toEqual([
      expect.objectContaining({ purpose: 'handoff_summary' }),
    ]);
    // El contexto va al registro de actividad, nunca a model_usage.
    expect(log.events[0]).toMatchObject({
      via: 'whatsapp',
      conversationId: '00000000-0000-4000-8000-0000000000c1',
    });
    expect(await rows()).toEqual([]);
  });

  it('sin la fila de usage_settings no inserta nada y lo trata como fallo', async () => {
    await t.db.delete(usageSettings);
    await meter().record(input());
    expect(await rows()).toEqual([]);
    expect(log.named('usage_record_failed')).toHaveLength(1);
  });
});
