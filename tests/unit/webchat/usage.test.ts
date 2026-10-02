/** Topes del chat web (FR-026, garantía 8). El día y el mes locales se prueban en time/local-date. */
import { describe, expect, it } from 'vitest';
import { capReached } from '../../../src/webchat/usage.js';

describe('capReached', () => {
  const caps = { dailyCap: 200, monthlyCap: 3000 };
  it.each([
    [{ today: 0, month: 0 }, null],
    [{ today: 199, month: 2999 }, null],
    [{ today: 200, month: 900 }, 'day'],
    [{ today: 10, month: 3000 }, 'month'],
    [{ today: 200, month: 3000 }, 'month'],
  ] as const)('%o → %s', (usage, expected) => {
    expect(capReached(usage, caps)).toBe(expected);
  });
});
