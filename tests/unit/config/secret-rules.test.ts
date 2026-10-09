/**
 * Reglas de los secretos (012, US8, SC-010; contracts/logging-and-startup.md) con la batería de
 * `tests/fixtures/secrets/battery.ts`: una incidencia por variable, sin el valor en ningún texto.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkSecrets,
  EXAMPLE_VALUES,
  secretFindingText,
  secretRule,
  urlPassword,
} from '../../../src/config/secret-rules.js';
import { secretCases } from '../../fixtures/secrets/battery.js';

const ENV_EXAMPLE = new URL('../../../.env.example', import.meta.url);

describe('checkSecrets', () => {
  it.each(secretCases().map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(checkSecrets(c.env)).toEqual(c.expected);
  });

  it('ningún texto de una incidencia contiene el valor examinado', () => {
    for (const c of secretCases()) {
      for (const finding of checkSecrets(c.env)) {
        const text = `${finding.variable}: ${secretFindingText(finding)}`;
        const raw = c.env[finding.variable] ?? '';
        const secret = urlPassword(raw) ?? raw;
        if (secret.length >= 6) expect(text).not.toContain(secret);
      }
    }
  });

  it('la lista de valores de ejemplo incluye los de .env.example', () => {
    const example = readFileSync(ENV_EXAMPLE, 'utf8');
    const values = example
      .split('\n')
      .filter((line) => /^[A-Z_]+=.+/.test(line))
      .flatMap((line) => {
        const value = line.slice(line.indexOf('=') + 1).trim();
        const password = urlPassword(value);
        return password === null ? [] : [password];
      });
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(EXAMPLE_VALUES.has(value.toLowerCase())).toBe(true);
  });

  it('un mensaje por regla, en español', () => {
    expect(
      secretFindingText({
        variable: 'HEALTH_SECRET',
        rule: 'reused',
        otherVariable: 'SESSION_SECRET',
      }),
    ).toBe('coincide con SESSION_SECRET');
    expect(secretFindingText({ variable: 'HEALTH_SECRET', rule: 'health_secret_required' })).toBe(
      'es obligatoria en producción',
    );
  });
});

/**
 * 016 (T038, FR-007): con la forma de dirección del despliegue real, `urlPassword` devolvía
 * `null` porque usaba `new URL`, así que **la regla de calidad de la contraseña de la base de
 * datos no se aplicaba en producción**. Una contraseña trivial pasaba sin aviso.
 */
describe('urlPassword con direcciones sin nombre de servidor (016)', () => {
  it('devuelve la contraseña con ruta de socket Unix y con autoridad vacía', () => {
    expect(urlPassword('postgres://chatbot:s3cr3ta@/chatbot?host=/var/run/postgresql')).toBe(
      's3cr3ta',
    );
    expect(urlPassword('postgres://chatbot:s3cr3ta@/chatbot?host=db.interna&port=6543')).toBe(
      's3cr3ta',
    );
  });

  it('la decodifica, como con nombre de servidor', () => {
    expect(urlPassword('postgres://u:cl%40ve%2Fx@/base?host=/tmp')).toBe('cl@ve/x');
  });

  it('y por tanto la regla de calidad sí se aplica con la forma de producción', () => {
    const trivial = urlPassword('postgres://chatbot:password@/chatbot?host=/var/run/postgresql');
    expect(trivial).toBe('password');
    expect(secretRule('DATABASE_URL', trivial ?? '')).not.toBeNull();
  });

  it('sin contraseña o sin URL sigue dando null', () => {
    expect(urlPassword('postgres://chatbot@/chatbot?host=/tmp')).toBeNull();
    expect(urlPassword('no es una url')).toBeNull();
    expect(urlPassword(undefined)).toBeNull();
  });
});
