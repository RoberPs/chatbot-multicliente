import { describe, expect, it } from 'vitest';
import { policiesSchema, splitMinutes } from '../../../src/knowledge/schemas/policies.js';
import { errorsOf, parseOk } from '../../helpers/schema.js';

describe('policiesSchema', () => {
  it('convierte minutos, horas y días a minutos', () => {
    expect(
      parseOk(policiesSchema, {
        cancellation_text: 'Avisa con antelación',
        cancellation_notice: '24',
        cancellation_notice_unit: 'hours',
        min_advance: '120',
        min_advance_unit: 'minutes',
        max_advance: '30',
        max_advance_unit: 'days',
        payment_methods: ['Efectivo', 'Tarjeta'],
      }),
    ).toEqual({
      cancellationText: 'Avisa con antelación',
      cancellationNoticeMinutes: 1440,
      minAdvanceMinutes: 120,
      maxAdvanceMinutes: 43200,
      paymentMethods: ['Efectivo', 'Tarjeta'],
    });
  });

  it('antelación mínima 31 días y máxima 30 días → error en min_advance (FR-016)', () => {
    expect(
      errorsOf(policiesSchema, {
        min_advance: '31',
        min_advance_unit: 'days',
        max_advance: '30',
        max_advance_unit: 'days',
      }),
    ).toEqual({ min_advance: 'La antelación mínima no puede ser mayor que la máxima' });
  });

  it('rechaza valores negativos', () => {
    expect(errorsOf(policiesSchema, { min_advance: '-1' })).toHaveProperty('min_advance');
    expect(errorsOf(policiesSchema, { cancellation_notice: '-2' })).toHaveProperty(
      'cancellation_notice',
    );
    expect(errorsOf(policiesSchema, { max_advance: '0' })).toHaveProperty('max_advance');
  });

  it('todo vacío es válido', () => {
    expect(parseOk(policiesSchema, {})).toEqual({
      cancellationText: null,
      cancellationNoticeMinutes: null,
      minAdvanceMinutes: null,
      maxAdvanceMinutes: null,
      paymentMethods: [],
    });
  });

  it('formas de pago recortadas, sin vacías ni duplicadas', () => {
    expect(
      parseOk(policiesSchema, { payment_methods: [' Efectivo ', '', 'efectivo', 'Bizum'] })
        .paymentMethods,
    ).toEqual(['Efectivo', 'Bizum']);
  });

  it('muestra un plazo con la mayor unidad exacta', () => {
    expect(splitMinutes(43200)).toEqual({ value: '30', unit: 'days' });
    expect(splitMinutes(120)).toEqual({ value: '2', unit: 'hours' });
    expect(splitMinutes(90)).toEqual({ value: '90', unit: 'minutes' });
    expect(splitMinutes(0)).toEqual({ value: '0', unit: 'minutes' });
    expect(splitMinutes(null)).toEqual({ value: '', unit: 'hours' });
  });
});
