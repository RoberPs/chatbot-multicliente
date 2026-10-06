/**
 * Reserva atómica de plazas de derivación y de aviso (012, R7; data-model §1.7): con llamadas en
 * paralelo se reservan exactamente `max`; sin plaza se cuenta la petición o el aviso retenido y el
 * evento sale una vez por día.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handoffDay } from '../../../src/db/schema.js';
import {
  readHandoffDay,
  readHandoffLimits,
  recordNoticeHeld,
  recordRefused,
  reserveHandoffStart,
  reserveNotice,
  saveHandoffLimits,
} from '../../../src/handoff/limits.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';
import { RecordingActivityLog } from '../../helpers/fakes.js';

const DAY = '2026-09-24';

describe('límites de derivación', () => {
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

  it.each([
    ['reserveHandoffStart', reserveHandoffStart, 'started'],
    ['reserveNotice', reserveNotice, 'notices'],
  ] as const)('%s: 50 en paralelo con máximo 7 reservan exactamente 7', async (_n, fn, key) => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => t.db.transaction((tx) => fn(tx, DAY, 7))),
    );
    expect(results.filter(Boolean)).toHaveLength(7);
    expect((await readHandoffDay(t.db, DAY))[key]).toBe(7);
    // Otro día tiene sus propias plazas.
    expect(await fn(t.db, '2026-09-25', 7)).toBe(true);
  });

  it('sin plaza: refused y notices_held suman, y su evento sale una vez al día', async () => {
    const log = new RecordingActivityLog();
    for (let i = 0; i < 3; i++) {
      await recordRefused(t.db, DAY, 20, log);
      await recordNoticeHeld(t.db, DAY, 60, log);
    }
    expect(await readHandoffDay(t.db, DAY)).toEqual({
      started: 0,
      refused: 3,
      notices: 0,
      noticesHeld: 3,
    });
    expect(log.named('handoff_daily_limit')).toEqual([{ event: 'handoff_daily_limit', max: 20 }]);
    expect(log.named('business_notices_held')).toEqual([
      { event: 'business_notices_held', max: 60 },
    ]);
    await recordRefused(t.db, '2026-09-25', 20, log);
    await recordNoticeHeld(t.db, '2026-09-25', 60, log);
    expect(log.named('handoff_daily_limit')).toHaveLength(2);
    expect(log.named('business_notices_held')).toHaveLength(2);
  });

  it('el evento sale una vez aunque haya peticiones en paralelo', async () => {
    const log = new RecordingActivityLog();
    await recordRefused(t.db, DAY, 20, log);
    log.events.length = 0;
    await t.db.update(handoffDay).set({ refusedLogged: false });
    await Promise.all(
      Array.from({ length: 10 }, () => t.db.transaction((tx) => recordRefused(tx, DAY, 20, log))),
    );
    expect(log.named('handoff_daily_limit')).toHaveLength(1);
    expect((await readHandoffDay(t.db, DAY)).refused).toBe(11);
  });

  it('límites: los de la migración y guardado', async () => {
    expect(await readHandoffLimits(t.db)).toEqual({
      dailyMax: 20,
      forwardIntervalMinutes: 15,
      noticesDailyMax: 60,
    });
    await saveHandoffLimits(t.db, {
      dailyMax: '3',
      forwardIntervalMinutes: '30',
      noticesDailyMax: '10',
    });
    expect(await readHandoffLimits(t.db)).toEqual({
      dailyMax: 3,
      forwardIntervalMinutes: 30,
      noticesDailyMax: 10,
    });
  });
});
