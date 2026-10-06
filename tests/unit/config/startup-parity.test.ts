/**
 * Paridad entre el arranque y `pnpm instance:check` (012, US8, SC-010, FR-035): con la batería
 * de secretos, `checkEnv` en producción y `instance:check` con perfil `production` dan las mismas
 * incidencias de secretos y el mismo veredicto; con perfil `testing`, las mismas como avisos y la
 * instancia apta. Fuera de producción, el arranque no falla por calidad.
 */
import { describe, expect, it } from 'vitest';
import { checkEnv } from '../../../src/config/env.js';
import { validate, type Finding } from '../../../src/provisioning/check.js';
import { createInventory, type InventoryAccess } from '../../../src/provisioning/inventory.js';
import { secretCases } from '../../fixtures/secrets/battery.js';
import { instanceFromEnv, TEST_INVENTORY_KEY, TODAY } from '../../helpers/provisioning.js';

const SECRET_RULES = new Set([
  'too_short',
  'example_value',
  'trivial',
  'reused',
  'health_secret_required',
]);
const CHECK_TO_RULE: Record<string, string> = {
  secret_too_short: 'too_short',
  secret_example_value: 'example_value',
  secret_trivial: 'trivial',
  secret_reused: 'reused',
};

/** Incidencias de secretos del arranque, como `VARIABLE:regla[:otra]`. */
const startupSecrets = (env: Record<string, string>) =>
  checkEnv(env)
    .filter((i) => SECRET_RULES.has(i.rule))
    .map((i) => `${String(i.variable)}:${i.rule}${i.otherVariable ? `:${i.otherVariable}` : ''}`)
    .sort();

/** Lo mismo desde `instance:check` (la falta de HEALTH_SECRET es `missing`, como en la 009). */
const checkSecretsOf = (findings: Finding[]) =>
  findings
    .flatMap((f) => {
      if (f.code === 'missing' && f.variable === 'HEALTH_SECRET') {
        return ['HEALTH_SECRET:health_secret_required'];
      }
      const rule = CHECK_TO_RULE[f.code];
      if (rule === undefined) return [];
      return [`${String(f.variable)}:${rule}${f.otherVariable ? `:${f.otherVariable}` : ''}`];
    })
    .sort();

const noInventory: InventoryAccess = { kind: 'absent', path: '/inv/inventory.json' };

function testingAccess(env: Record<string, string>): InventoryAccess {
  const inventory = createInventory(TEST_INVENTORY_KEY, TODAY);
  inventory.instances.push(instanceFromEnv(env, { status: 'testing' }));
  return { kind: 'ok', path: '/inv/inventory.json', inventory, key: TEST_INVENTORY_KEY };
}

describe('paridad arranque ↔ instance:check (SC-010)', () => {
  it.each(secretCases().map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const startup = startupSecrets(c.env);
    const production = validate(c.env, noInventory);
    expect(checkSecretsOf(production.errors)).toEqual(startup);
    // Mismo veredicto por los secretos: con alguna incidencia, ni arranca ni es apto.
    if (startup.length > 0) expect(production.ok).toBe(false);
    if (c.name === 'entorno válido') {
      expect(checkEnv(c.env)).toEqual([]);
      expect(production.errors).toEqual([]);
    }

    // Perfil testing: las mismas como avisos (salvo la falta de HEALTH_SECRET, que la 009 exige).
    const testing = validate(c.env, testingAccess(c.env));
    expect(testing.profile).toBe('testing');
    expect(checkSecretsOf([...testing.errors, ...testing.warnings])).toEqual(startup);
    const blocking = testing.errors.filter((e) => CHECK_TO_RULE[e.code] !== undefined);
    expect(blocking).toEqual([]);

    // Fuera de producción el arranque no falla por calidad.
    expect(startupSecrets({ ...c.env, NODE_ENV: 'development' })).toEqual([]);
  });
});
