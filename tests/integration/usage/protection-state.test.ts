/**
 * Estado de protección (012, R1 – R5; contracts/protection-conversation.md): una sola consulta sin
 * caché con ajustes, gasto del mes, precios de LLM_MODEL y STT_MODEL y respuestas de WhatsApp del
 * día local; falla cerrado (`spend_unreadable`) si la consulta falla o tarda más de 2 s, sin lanzar,
 * y registra `protection_read_failed` como mucho una vez por minuto.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DbOrTx } from '../../../src/conversation/repositories/customer.js';
import {
  modelPrice,
  modelUsage,
  transcriptionPrice,
  usageSettings,
  whatsappUsageDay,
} from '../../../src/db/schema.js';
import {
  checkProtection,
  protectionState,
  type ProtectionInput,
} from '../../../src/usage/protection.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';
import { RecordingActivityLog } from '../../helpers/fakes.js';

const CENT = 10_000_000_000n;
const NOW = new Date('2026-09-24T08:00:00Z');
const TZ = 'Europe/Madrid';
const LLM = 'modelo-x';
const STT = 'stt-x';

describe('estado de protección', () => {
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

  const input = (over: Partial<ProtectionInput> = {}): ProtectionInput => ({
    production: true,
    llmModel: LLM,
    sttModel: STT,
    now: NOW,
    timezone: TZ,
    ...over,
  });
  const priceLlm = () =>
    t.db.insert(modelPrice).values({
      model: LLM,
      inputMicrosPerMtok: 1n,
      outputMicrosPerMtok: 1n,
      cacheWriteMicrosPerMtok: 0n,
      cacheReadMicrosPerMtok: 0n,
    });
  const priceStt = () =>
    t.db.insert(transcriptionPrice).values({ model: STT, microsPerMinute: 6000n });
  const spend = (cents: bigint, day = '2026-09-24') =>
    t.db.insert(modelUsage).values({
      at: NOW,
      day,
      channel: 'whatsapp',
      purpose: 'reply',
      model: LLM,
      calls: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      costPico: cents * CENT,
      currency: 'USD',
    });

  /** Ejecutor que cuenta todas las llamadas que recibe y las pasa a la BD real. */
  function counting(): { tx: DbOrTx; calls: string[] } {
    const calls: string[] = [];
    const tx = new Proxy(t.db, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push(String(prop));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as DbOrTx;
    return { tx, calls };
  }

  it('lee todo en una sola consulta', async () => {
    await priceLlm();
    await priceStt();
    await t.db.update(usageSettings).set({ capEnabled: true, monthlyCapCents: 1000 });
    await spend(300n);
    await spend(5000n, '2026-08-31');
    await t.db.insert(whatsappUsageDay).values([
      { day: '2026-09-24', replies: 7 },
      { day: '2026-09-23', replies: 199 },
    ]);
    const { tx, calls } = counting();
    const state = await protectionState(tx, input());
    expect(calls).toEqual(['execute']);
    expect(state).toMatchObject({
      production: true,
      contactOnly: [],
      spendCap: { level: 'normal', spentPico: 300n * CENT, capCents: 1000, percent: 30 },
      whatsapp: { today: 7, cap: 200, reached: false },
      handoffs: {
        started: 0,
        refused: 0,
        notices: 0,
        held: 0,
        limits: { dailyMax: 20, forwardIntervalMinutes: 15, noticesDailyMax: 60 },
      },
      unpricedModels: { llm: null, stt: null },
      readFailure: null,
    });
  });

  it('en producción: sin tope, sin precio del modelo ni de la transcripción', async () => {
    const state = await protectionState(t.db, input());
    expect(state.contactOnly).toEqual(['cap_disabled', 'model_unpriced', 'stt_unpriced']);
    expect(state.unpricedModels).toEqual({ llm: LLM, stt: STT });
  });

  it('sin audios no exige el precio de la transcripción', async () => {
    await priceLlm();
    await t.db.update(usageSettings).set({ capEnabled: true, monthlyCapCents: 1000 });
    const state = await protectionState(t.db, input({ sttModel: null }));
    expect(state.contactOnly).toEqual([]);
    expect(state.unpricedModels).toEqual({ llm: null, stt: null });
  });

  it('fuera de producción no hay motivos de solo contacto', async () => {
    expect((await protectionState(t.db, input({ production: false }))).contactOnly).toEqual([]);
  });

  it('el día de WhatsApp es el local del negocio', async () => {
    await t.db.insert(whatsappUsageDay).values({ day: '2026-10-01', replies: 200 });
    // 22:30 UTC del 30/09 = 00:30 del 01/10 en Madrid.
    const late = new Date('2026-09-30T22:30:00Z');
    expect((await protectionState(t.db, input({ now: late }))).whatsapp).toEqual({
      today: 200,
      cap: 200,
      reached: true,
    });
    expect((await protectionState(t.db, input({ now: late, timezone: 'UTC' }))).whatsapp).toEqual({
      today: 0,
      cap: 200,
      reached: false,
    });
  });

  const failingTx = (error: Error): DbOrTx =>
    ({ execute: () => Promise.reject(error) }) as unknown as DbOrTx;
  const slowTx = (ms: number): DbOrTx =>
    ({
      execute: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            resolve({ rows: [] });
          }, ms),
        ),
    }) as unknown as DbOrTx;
  const UNREADABLE = {
    contactOnly: ['spend_unreadable'],
    spendCap: null,
    whatsapp: null,
    handoffs: null,
    unpricedModels: { llm: null, stt: null },
  };

  it('consulta fallida: spend_unreadable sin lanzar', async () => {
    const state = await protectionState(failingTx(new TypeError('x')), input());
    expect(state).toMatchObject({ ...UNREADABLE, readFailure: 'TypeError' });
  });

  it('sin la fila de ajustes: spend_unreadable', async () => {
    await t.db.delete(usageSettings);
    expect(await protectionState(t.db, input())).toMatchObject(UNREADABLE);
  });

  it('más de 2 s: spend_unreadable por plazo', async () => {
    const started = Date.now();
    const state = await protectionState(slowTx(2_600), input());
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(state).toMatchObject({ ...UNREADABLE, readFailure: 'TimeoutError' });
  });

  it('con pg_sleep real también vence el plazo', async () => {
    const tx = {
      execute: () => t.db.execute(sql`select pg_sleep(1)`),
    } as unknown as DbOrTx;
    const state = await protectionState(tx, input({ readTimeoutMs: 100 }));
    expect(state.readFailure).toBe('TimeoutError');
  });

  it('protection_read_failed como mucho una vez por minuto', async () => {
    const log = new RecordingActivityLog();
    const tx = failingTx(new Error('caída'));
    await checkProtection(tx, input(), log);
    await checkProtection(tx, input({ now: new Date(NOW.getTime() + 30_000) }), log);
    expect(log.named('protection_read_failed')).toEqual([
      { event: 'protection_read_failed', errorClass: 'Error' },
    ]);
    await checkProtection(tx, input({ now: new Date(NOW.getTime() + 60_000) }), log);
    expect(log.named('protection_read_failed')).toHaveLength(2);
  });

  it('whatsapp_quota_reached una vez por día local', async () => {
    const log = new RecordingActivityLog();
    await t.db.update(usageSettings).set({ whatsappDailyCap: 5 });
    await t.db.insert(whatsappUsageDay).values([
      { day: '2026-09-24', replies: 5 },
      { day: '2026-09-25', replies: 5 },
    ]);
    await checkProtection(t.db, input(), log);
    await checkProtection(t.db, input(), log);
    expect(log.named('whatsapp_quota_reached')).toEqual([
      { event: 'whatsapp_quota_reached', cap: 5 },
    ]);
    await checkProtection(t.db, input({ now: new Date('2026-09-25T08:00:00Z') }), log);
    expect(log.named('whatsapp_quota_reached')).toHaveLength(2);
  });
});
