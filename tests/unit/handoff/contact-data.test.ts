/** Datos de contacto de la derivación (005, FR-004, FR-005; contracts/handoff-flow.md § Datos). */
import { describe, expect, it } from 'vitest';
import { missingContact, normalizeName, resolvePhone } from '../../../src/handoff/contact-data.js';

describe('normalizeName', () => {
  it('recorta, quita saltos y espacios repetidos', () => {
    expect(normalizeName('  Ana\n  María \t López ')).toBe('Ana María López');
  });

  it('1–80 caracteres; vacío o nulo → null', () => {
    expect(normalizeName('x'.repeat(90))).toBe('x'.repeat(80));
    expect(normalizeName('   ')).toBeNull();
    expect(normalizeName(null)).toBeNull();
  });
});

describe('resolvePhone', () => {
  it('el que copió el modelo, en E.164', () => {
    expect(resolvePhone('611 22 23 33', [], 'ES')).toEqual({
      status: 'valid',
      phone: '+34611222333',
    });
    expect(resolvePhone('+52 55 1234 5678', [], 'ES')).toEqual({
      status: 'valid',
      phone: '+525512345678',
    });
  });

  it('el del modelo no válido → invalid', () => {
    expect(resolvePhone('12345', [], 'ES')).toEqual({ status: 'invalid' });
  });

  it('si el modelo no lo copió, el primero válido de los textos', () => {
    expect(
      resolvePhone(null, ['me llamo Ana', 'mi móvil es el 611 22 23 33 o el 699 000 111'], 'ES'),
    ).toEqual({ status: 'valid', phone: '+34611222333' });
  });

  it('sin teléfono en ningún sitio → missing; con una cifra que lo intenta → invalid', () => {
    expect(resolvePhone(null, ['soy Ana'], 'ES')).toEqual({ status: 'missing' });
    expect(resolvePhone(null, ['es el 12 34 56'], 'ES')).toEqual({ status: 'invalid' });
  });
});

describe('missingContact', () => {
  it('WhatsApp: el teléfono lo da el canal; falta el nombre solo sin perfil', () => {
    expect(missingContact(true, { name: 'Lucía', phone: null })).toEqual([]);
    expect(missingContact(true, { name: null, phone: null })).toEqual(['name']);
  });

  it('web y playground: nombre y teléfono salvo los ya dados', () => {
    expect(missingContact(false, { name: null, phone: null })).toEqual(['name', 'phone']);
    expect(missingContact(false, { name: 'Lucía', phone: null })).toEqual(['phone']);
    expect(missingContact(false, { name: null, phone: '+34611222333' })).toEqual(['name']);
    expect(missingContact(false, { name: 'Lucía', phone: '+34611222333' })).toEqual([]);
  });
});
