/** Formulario de los límites de derivación (012, data-model §1.6 y §2.3). */
import { describe, expect, it } from 'vitest';
import { handoffLimitsSchema } from '../../../src/handoff/limits.js';

const valid = { dailyMax: '20', forwardIntervalMinutes: '15', noticesDailyMax: '60' };

describe('handoffLimitsSchema', () => {
  it('acepta enteros en el rango (también en los bordes)', () => {
    expect(handoffLimitsSchema.parse(valid)).toEqual({
      dailyMax: 20,
      forwardIntervalMinutes: 15,
      noticesDailyMax: 60,
    });
    expect(
      handoffLimitsSchema.parse({ dailyMax: '1', forwardIntervalMinutes: '5', noticesDailyMax: 10 }),
    ).toEqual({ dailyMax: 1, forwardIntervalMinutes: 5, noticesDailyMax: 10 });
    expect(
      handoffLimitsSchema.parse({
        dailyMax: '200',
        forwardIntervalMinutes: '240',
        noticesDailyMax: '500',
      }),
    ).toEqual({ dailyMax: 200, forwardIntervalMinutes: 240, noticesDailyMax: 500 });
  });

  it.each([
    ['dailyMax', '0', 'entre 1 y 200'],
    ['dailyMax', '201', 'entre 1 y 200'],
    ['forwardIntervalMinutes', '4', 'entre 5 y 240'],
    ['forwardIntervalMinutes', '241', 'entre 5 y 240'],
    ['noticesDailyMax', '9', 'entre 10 y 500'],
    ['noticesDailyMax', '501', 'entre 10 y 500'],
    ['dailyMax', '2,5', 'entre 1 y 200'],
    ['dailyMax', '-1', 'entre 1 y 200'],
    ['dailyMax', '', 'entre 1 y 200'],
  ])('%s = %s → un error con el rango', (field, value, range) => {
    const result = handoffLimitsSchema.safeParse({ ...valid, [field]: value });
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    expect(issues.map((i) => i.path.join('.'))).toEqual([field]);
    expect(issues[0]?.message).toContain(range);
  });

  it('todos los errores a la vez, uno por campo', () => {
    const result = handoffLimitsSchema.safeParse({});
    expect(result.error?.issues.map((i) => i.path.join('.')).sort()).toEqual([
      'dailyMax',
      'forwardIntervalMinutes',
      'noticesDailyMax',
    ]);
  });
});
