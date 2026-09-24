import { describe, expect, it } from 'vitest';
import { centsToInput, formatCents, parseAmountToCents } from '../../../src/knowledge/money.js';
import { serviceSchema } from '../../../src/knowledge/schemas/service.js';
import { errorsOf, parseOk } from '../../helpers/schema.js';

const base = {
  name: 'Servicio A',
  description: '',
  price_type: 'fixed',
  price: '20',
  duration: '30',
  bookable: 'on',
  active: 'on',
};

describe('importes', () => {
  it.each([
    ['20', 2000],
    ['20,50', 2050],
    ['20.50', 2050],
    ['20.5', 2050],
    ['0', 0],
  ])('%s → %i céntimos', (input, cents) => {
    expect(parseAmountToCents(input)).toEqual({ ok: true, cents });
  });

  it('rechaza negativos y más de dos decimales', () => {
    expect(parseAmountToCents('-5')).toEqual({
      ok: false,
      message: 'El importe no puede ser negativo',
    });
    expect(parseAmountToCents('1,234').ok).toBe(false);
    expect(parseAmountToCents('abc').ok).toBe(false);
  });

  it('formatea para listas y formularios', () => {
    expect(formatCents(2050, 'EUR')).toMatch(/20,50\s€/);
    expect(centsToInput(2050)).toBe('20,50');
    expect(centsToInput(2500)).toBe('25');
    expect(centsToInput(null)).toBe('');
  });
});

describe('serviceSchema', () => {
  it('convierte precio y duración', () => {
    expect(parseOk(serviceSchema, base)).toEqual({
      name: 'Servicio A',
      description: null,
      priceType: 'fixed',
      priceCents: 2000,
      durationMinutes: 30,
      bookable: true,
      active: true,
    });
  });

  it('precio -5 → error en price', () => {
    expect(errorsOf(serviceSchema, { ...base, price: '-5' })).toEqual({
      price: 'El importe no puede ser negativo',
    });
  });

  it('"a consultar" nunca guarda importe', () => {
    expect(
      parseOk(serviceSchema, { ...base, price_type: 'on_request', price: '30' }).priceCents,
    ).toBeNull();
  });

  it('fijo o "desde" sin importe se acepta (genera aviso, no error)', () => {
    expect(parseOk(serviceSchema, { ...base, price: '' }).priceCents).toBeNull();
    expect(
      parseOk(serviceSchema, { ...base, price_type: 'from', price: '' }).priceCents,
    ).toBeNull();
  });

  it('duración entre 1 y 1440 minutos; vacía permitida', () => {
    expect(errorsOf(serviceSchema, { ...base, duration: '0' })).toHaveProperty('duration');
    expect(errorsOf(serviceSchema, { ...base, duration: '1441' })).toHaveProperty('duration');
    expect(errorsOf(serviceSchema, { ...base, duration: '10.5' })).toHaveProperty('duration');
    expect(parseOk(serviceSchema, { ...base, duration: '' }).durationMinutes).toBeNull();
    expect(parseOk(serviceSchema, { ...base, duration: '1440' }).durationMinutes).toBe(1440);
  });

  it('reservable y activo llegan como casillas', () => {
    const { bookable, active } = parseOk(serviceSchema, {
      ...base,
      bookable: undefined,
      active: undefined,
    });
    expect({ bookable, active }).toEqual({ bookable: false, active: false });
  });

  it('tipo de precio obligatorio', () => {
    expect(errorsOf(serviceSchema, { ...base, price_type: 'gratis' })).toHaveProperty('price_type');
  });
});
