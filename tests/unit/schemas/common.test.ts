import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  currency,
  email,
  isoDate,
  localTime,
  optionalHttpsUrl,
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

describe('optionalHttpsUrl (003, R7)', () => {
  const schema = optionalHttpsUrl(500);
  const error = (value: string) => schema.safeParse(value).error?.issues[0]?.message;
  const INVALID = 'Enlace no válido: copia el enlace completo, empezando por https://';

  it('vacío → null', () => {
    expect(schema.parse('')).toBeNull();
    expect(schema.parse('   ')).toBeNull();
    expect(schema.parse(undefined)).toBeNull();
  });

  it('las reglas se aplican en orden', () => {
    expect(error(`https://example.com/${'a'.repeat(481)}`)).toBe('Máximo 500 caracteres');
    expect(error('https://example.com/a b')).toBe(INVALID);
    expect(error('maps.example.com/abc')).toBe(
      'Escribe el enlace completo, empezando por https://',
    );
    expect(error('http://maps.example.com/abc')).toBe(
      'Usa el enlace seguro, que empieza por https://',
    );
    expect(error('HTTP://maps.example.com/abc')).toBe(
      'Usa el enlace seguro, que empieza por https://',
    );
    expect(error('https://localhost/x')).toBe(INVALID);
    expect(error('https://user:pass@example.com')).toBe(INVALID);
    expect(error('ftp://example.com/x')).toBe(INVALID);
    expect(error('https://')).toBe(INVALID);
  });

  it('acepta 500 caracteres justos', () => {
    const url = `https://example.com/${'a'.repeat(480)}`;
    expect(url).toHaveLength(500);
    expect(schema.parse(url)).toBe(url);
  });

  it('acepta @ , + ! y ? y lo devuelve recortado, sin recodificar', () => {
    const url = 'https://maps.example.com/@40.41,-3.70,17z?q=Plaza+Mayor&hl=es';
    expect(schema.parse(`  ${url}  `)).toBe(url);
    const other = 'https://mapas.example.org/#!/lugar/Plaza+Mayor,1?z=17&ñ=1';
    expect(schema.parse(other)).toBe(other);
  });
});
