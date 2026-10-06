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
