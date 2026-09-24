import { describe, expect, it } from 'vitest';
import { closureSchema } from '../../../src/knowledge/schemas/closure.js';
import { dateRangeBlockSchema } from '../../../src/knowledge/schemas/date-range-block.js';
import { errorsOf, parseOk } from '../../helpers/schema.js';

describe('dateRangeBlockSchema', () => {
  it('acepta un día completo', () => {
    expect(
      parseOk(dateRangeBlockSchema, { start_date: '2026-12-25', end_date: '2026-12-25' }),
    ).toEqual({
      startDate: '2026-12-25',
      endDate: '2026-12-25',
      startTime: null,
      endTime: null,
    });
  });

  it('rechaza fecha de fin anterior a la de inicio', () => {
    expect(
      errorsOf(dateRangeBlockSchema, { start_date: '2026-08-10', end_date: '2026-08-01' }),
    ).toHaveProperty('end_date');
  });

  it('rechaza un cierre con una sola hora', () => {
    expect(
      errorsOf(dateRangeBlockSchema, {
        start_date: '2026-12-24',
        end_date: '2026-12-24',
        start_time: '14:00',
        end_time: '',
      }),
    ).toHaveProperty('end_time');
    expect(
      errorsOf(dateRangeBlockSchema, {
        start_date: '2026-12-24',
        end_date: '2026-12-24',
        start_time: '',
        end_time: '20:00',
      }),
    ).toHaveProperty('start_time');
  });

  it('rechaza hora de fin no posterior a la de inicio', () => {
    expect(
      errorsOf(dateRangeBlockSchema, {
        start_date: '2026-12-24',
        end_date: '2026-12-24',
        start_time: '20:00',
        end_time: '14:00',
      }),
    ).toEqual({ end_time: 'La hora de fin debe ser posterior a la de inicio' });
  });

  it('el cierre añade un motivo opcional', () => {
    expect(
      parseOk(closureSchema, {
        start_date: '2026-12-24',
        end_date: '2026-12-24',
        start_time: '14:00',
        end_time: '20:00',
        reason: ' Nochebuena ',
      }),
    ).toMatchObject({ startTime: '14:00', endTime: '20:00', reason: 'Nochebuena' });
  });
});
