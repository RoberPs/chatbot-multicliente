import { describe, expect, it } from 'vitest';
import { absenceSchema, resourceSchema } from '../../../src/knowledge/schemas/resource.js';
import { errorsOf, parseOk } from '../../helpers/schema.js';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

describe('resourceSchema', () => {
  it('nombre obligatorio de 1 a 200 caracteres', () => {
    expect(errorsOf(resourceSchema, { name: '' })).toHaveProperty('name');
    expect(errorsOf(resourceSchema, { name: 'x'.repeat(201) })).toHaveProperty('name');
  });

  it('service_ids acepta un valor suelto o una lista de uuids', () => {
    expect(parseOk(resourceSchema, { name: 'R', service_ids: ID1, active: 'on' })).toEqual({
      name: 'R',
      serviceIds: [ID1],
      active: true,
    });
    expect(parseOk(resourceSchema, { name: 'R', service_ids: [ID1, ID2] }).serviceIds).toEqual([
      ID1,
      ID2,
    ]);
    expect(parseOk(resourceSchema, { name: 'R' }).serviceIds).toEqual([]);
  });

  it('rechaza ids no válidos o duplicados en service_ids', () => {
    expect(errorsOf(resourceSchema, { name: 'R', service_ids: ['nope'] })).toHaveProperty(
      'service_ids',
    );
    expect(errorsOf(resourceSchema, { name: 'R', service_ids: [ID1, ID1] })).toHaveProperty(
      'service_ids',
    );
  });

  it('una ausencia es un bloque de fechas sin motivo', () => {
    const absence = parseOk(absenceSchema, {
      start_date: '2026-08-01',
      end_date: '2026-08-07',
      reason: 'ignorado',
    });
    expect(absence).toEqual({
      startDate: '2026-08-01',
      endDate: '2026-08-07',
      startTime: null,
      endTime: null,
    });
    expect(
      errorsOf(absenceSchema, { start_date: '2026-08-07', end_date: '2026-08-01' }),
    ).toHaveProperty('end_date');
  });
});
