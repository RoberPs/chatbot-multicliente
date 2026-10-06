import { describe, expect, it } from 'vitest';
import { businessSchema } from '../../../src/knowledge/schemas/business.js';
import { errorsOf, parseOk } from '../../helpers/schema.js';

const schema = businessSchema('ES');
const valid = {
  name: 'Mi negocio',
  address: 'Calle Mayor 1',
  directions: '',
  phone: '600 123 456',
  email: 'Info@Ejemplo.es',
  timezone: 'Europe/Madrid',
  currency: 'EUR',
};

describe('businessSchema', () => {
  it('normaliza teléfono y email y convierte vacíos en null', () => {
    expect(parseOk(schema, valid)).toEqual({
      name: 'Mi negocio',
      address: 'Calle Mayor 1',
      directions: null,
      map_url: null,
      phone: '+34600123456',
      email: 'info@ejemplo.es',
      timezone: 'Europe/Madrid',
      currency: 'EUR',
    });
  });

  it('el nombre es obligatorio y como mucho 200 caracteres', () => {
    expect(errorsOf(schema, { ...valid, name: '  ' })).toHaveProperty('name');
    expect(errorsOf(schema, { ...valid, name: 'x'.repeat(201) })).toHaveProperty('name');
  });

  it('limita dirección a 500 e indicaciones a 2000 caracteres', () => {
    expect(errorsOf(schema, { ...valid, address: 'x'.repeat(501) })).toHaveProperty('address');
    expect(errorsOf(schema, { ...valid, directions: 'x'.repeat(2001) })).toHaveProperty(
      'directions',
    );
    expect(errorsOf(schema, { ...valid, directions: 'x'.repeat(2000) })).toEqual({});
  });

  it('rechaza email, teléfono, zona horaria y moneda no válidos en su campo', () => {
    expect(
      Object.keys(
        errorsOf(schema, {
          ...valid,
          email: 'foo@',
          phone: 'abc',
          timezone: 'Mars/Base',
          currency: 'X',
        }),
      ).sort(),
    ).toEqual(['currency', 'email', 'phone', 'timezone']);
  });

  it('teléfono y email son opcionales', () => {
    expect(parseOk(schema, { ...valid, phone: '', email: '' })).toMatchObject({
      phone: null,
      email: null,
    });
  });
});

describe('businessSchema: map_url (003)', () => {
  const schema = businessSchema('ES');
  const base = { name: 'Negocio', timezone: 'Europe/Madrid', currency: 'EUR' };

  it('válido, vacío → null e inválido → error en map_url', () => {
    expect(
      parseOk(schema, {
        ...base,
        map_url: ' https://maps.example.com/@40.41,-3.70,17z?q=Plaza+Mayor ',
      }).map_url,
    ).toBe('https://maps.example.com/@40.41,-3.70,17z?q=Plaza+Mayor');
    expect(parseOk(schema, { ...base, map_url: '' }).map_url).toBeNull();
    expect(parseOk(schema, base).map_url).toBeNull();
    expect(errorsOf(schema, { ...base, map_url: 'maps.example.com/abc' })).toEqual({
      map_url: 'Escribe el enlace completo, empezando por https://',
    });
  });
});
