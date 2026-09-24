import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  currency,
  email,
  isoDate,
  localTime,
  optionalText,
  phone,
  timezone,
  trimmedText,
} from '../../../src/knowledge/schemas/common.js';
import { errorsOf, parseOk } from '../../helpers/schema.js';

describe('esquemas comunes', () => {
  it('normaliza un teléfono nacional a E.164 con la región por defecto', () => {
    expect(parseOk(phone('ES'), '600 123 456')).toBe('+34600123456');
    expect(parseOk(phone('ES'), '+34 600-123-456')).toBe('+34600123456');
  });

  it('rechaza un teléfono no válido', () => {
    expect(errorsOf(z.object({ phone: phone('ES') }), { phone: '12' })).toEqual({
      phone: 'Teléfono no válido',
    });
  });

  it('rechaza un email mal formado y guarda en minúsculas', () => {
    expect(errorsOf(z.object({ email }), { email: 'foo@' })).toHaveProperty('email');
    expect(parseOk(email, ' Hola@Ejemplo.ES ')).toBe('hola@ejemplo.es');
  });

  it('valida zonas horarias IANA', () => {
    expect(parseOk(timezone, 'Europe/Madrid')).toBe('Europe/Madrid');
    expect(parseOk(timezone, 'America/Mexico_City')).toBe('America/Mexico_City');
    expect(errorsOf(z.object({ timezone }), { timezone: 'Mars/Base' })).toHaveProperty('timezone');
  });

  it('valida moneda ISO 4217', () => {
    expect(parseOk(currency, 'eur')).toBe('EUR');
    expect(errorsOf(z.object({ currency }), { currency: 'EURO' })).toHaveProperty('currency');
  });

  it('valida horas y fechas', () => {
    expect(parseOk(localTime, '09:30')).toBe('09:30');
    expect(parseOk(localTime, '09:30:00')).toBe('09:30');
    expect(localTime.safeParse('24:00').success).toBe(false);
    expect(isoDate.safeParse('2026-02-30').success).toBe(false);
    expect(parseOk(isoDate, '2026-12-25')).toBe('2026-12-25');
  });

  it('recorta textos y convierte los opcionales vacíos en null', () => {
    expect(parseOk(trimmedText(1, 10), '  hola ')).toBe('hola');
    expect(trimmedText(1, 10).safeParse('   ').success).toBe(false);
    expect(parseOk(optionalText(10), '   ')).toBeNull();
    expect(parseOk(optionalText(10), undefined)).toBeNull();
  });
});
