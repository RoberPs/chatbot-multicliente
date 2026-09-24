import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const base = {
  DATABASE_URL: 'postgres://x',
  OPERATOR_USER: 'operador',
  OPERATOR_PASSWORD_HASH: '$argon2id$v=19$m=65536,t=3,p=4$abc$def',
  SESSION_SECRET: '3f9a1c7e5b2d4086a1e3c5f7092b4d6e8a0c2e4f6183a5c7e9b1d3f5a7c9e0b2',
  NODE_ENV: 'production',
};

describe('variables de la instancia', () => {
  it('acepta una configuración válida con valores por defecto', () => {
    expect(loadEnv(base)).toMatchObject({
      DEFAULT_PHONE_REGION: 'ES',
      DEFAULT_TIMEZONE: 'Europe/Madrid',
      DEFAULT_CURRENCY: 'EUR',
      PORT: 3000,
      TRUST_PROXY: false,
    });
  });

  it.each([
    ['el valor de ejemplo antiguo', 'cambia-esto-por-un-secreto-largo-de-al-menos-32-bytes'],
    ['vacío', ''],
    ['hex demasiado corto', 'abcdef0123456789'],
    ['hex repetitivo', 'a'.repeat(64)],
  ])('rechaza SESSION_SECRET %s', (_name, secret) => {
    expect(() => loadEnv({ ...base, SESSION_SECRET: secret })).toThrow(/SESSION_SECRET/);
  });

  it('NODE_ENV es obligatoria', () => {
    const { NODE_ENV: _omit, ...rest } = base;
    expect(() => loadEnv(rest)).toThrow(/NODE_ENV/);
  });

  it('TRUST_PROXY: saltos o IP/CIDR, nunca true', () => {
    expect(loadEnv({ ...base, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
    expect(loadEnv({ ...base, TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).TRUST_PROXY).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
    ]);
    expect(() => loadEnv({ ...base, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
  });

  it('rechaza un hash que no es Argon2id', () => {
    expect(() => loadEnv({ ...base, OPERATOR_PASSWORD_HASH: 'plano' })).toThrow(/Argon2id/);
  });
});
