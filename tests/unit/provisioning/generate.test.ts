import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fingerprint } from '../../../src/provisioning/fingerprint.js';
import {
  buildInstanceEnv,
  checkNotUsed,
  validateMinimalData,
  type MinimalInput,
} from '../../../src/provisioning/generate.js';
import { createInventory } from '../../../src/provisioning/inventory.js';
import { ProvisioningError } from '../../../src/provisioning/messages.js';
import { cryptoRandom, type RandomSource } from '../../../src/provisioning/secrets.js';
import {
  fastHasher,
  instanceFromEnv,
  productionEnv,
  sampleInventory,
  TEST_INVENTORY_KEY,
  TODAY,
} from '../../helpers/provisioning.js';

const input = (overrides: Partial<MinimalInput> = {}): MinimalInput => ({
  id: 'demo-09',
  client: 'Cliente de prueba',
  url: 'https://Demo-09.ejemplo.com/',
  timezone: 'Europe/Madrid',
  region: 'es',
  currency: 'eur',
  emergencyPhone: '600 111 222',
  whatsapp: false,
  ...overrides,
});

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof ProvisioningError ? error.code : 'otro';
  }
};

describe('validateMinimalData (FR-014)', () => {
  it('normaliza la URL a origen, el teléfono a E.164 y los códigos a mayúsculas', () => {
    expect(validateMinimalData(input())).toEqual({
      id: 'demo-09',
      client: 'Cliente de prueba',
      url: 'https://demo-09.ejemplo.com',
      timezone: 'Europe/Madrid',
      region: 'ES',
      currency: 'EUR',
      emergencyPhone: '+34600111222',
      whatsapp: false,
      backupDir: '/var/lib/chatbot/backups',
      // 017 (FR-003, FR-010): sin `--provider`, anthropic, igual que en un entorno ya desplegado.
      provider: 'anthropic',
    });
  });

  it('017: el proveedor declarado se conserva, y uno no elegible se rechaza', () => {
    expect(validateMinimalData({ ...input(), provider: 'gemini' }).provider).toBe('gemini');
    expect(validateMinimalData({ ...input(), provider: ' openai ' }).provider).toBe('openai');
    expect(validateMinimalData({ ...input(), provider: '' }).provider).toBe('anthropic');
    expect(() => validateMinimalData({ ...input(), provider: 'mistral' })).toThrow();
  });

  it.each([
    ['invalid_id', { id: 'Demo_09' }],
    ['invalid_id', { id: '-demo' }],
    ['invalid_client', { client: ' ' }],
    ['invalid_client', { client: 'x'.repeat(121) }],
    ['invalid_url', { url: 'http://demo.ejemplo.com' }],
    ['invalid_url', { url: 'https://localhost' }],
    ['invalid_url', { url: 'https://demo.ejemplo.com/chat' }],
    ['invalid_url', { url: 'demo.ejemplo.com' }],
    ['invalid_timezone', { timezone: 'Europe/Nowhere' }],
    ['invalid_region', { region: 'ESP' }],
    ['invalid_currency', { currency: 'EURO' }],
    ['invalid_phone', { emergencyPhone: '123' }],
    ['invalid_phone', { emergencyPhone: 'teléfono' }],
    ['invalid_backup_dir', { backupDir: 'backups' }],
    ['invalid_backup_dir', { backupDir: 'C:\\backups' }],
  ] as Array<[string, Partial<MinimalInput>]>)('rechaza con %s: %o', (code, overrides) => {
    expect(codeOf(() => validateMinimalData(input(overrides)))).toBe(code);
  });
});

describe('checkNotUsed', () => {
  it('id ya usado, también por una instancia dada de baja', () => {
    const { inventory } = sampleInventory(3);
    expect(
      codeOf(() => {
        checkNotUsed(validateMinimalData(input({ id: 'demo-01' })), inventory, TEST_INVENTORY_KEY);
      }),
    ).toBe('duplicate_instance_id');
    expect(inventory.instances.find((i) => i.id === 'demo-02')?.status).toBe('retired');
    expect(
      codeOf(() => {
        checkNotUsed(validateMinimalData(input({ id: 'demo-02' })), inventory, TEST_INVENTORY_KEY);
      }),
    ).toBe('duplicate_instance_id');
  });

  it('URL pública de otra instancia → duplicate_public_url', () => {
    const { inventory } = sampleInventory(2);
    expect(
      codeOf(() => {
        checkNotUsed(
          validateMinimalData(input({ url: 'https://DEMO-01.ejemplo.com' })),
          inventory,
          TEST_INVENTORY_KEY,
        );
      }),
    ).toBe('duplicate_public_url');
  });
});

describe('buildInstanceEnv', () => {
  const deps = { hasher: fastHasher, today: TODAY };

  it('produce valores, pendientes y una instancia provisioning con sus huellas', async () => {
    const data = validateMinimalData(input({ whatsapp: true }));
    const result = await buildInstanceEnv(data, null, TEST_INVENTORY_KEY, deps);
    expect(result.values).toMatchObject({
      NODE_ENV: 'production',
      INSTANCE_ID: 'demo-09',
      PUBLIC_BASE_URL: 'https://demo-09.ejemplo.com',
      EMERGENCY_CONTACT_PHONE: '+34600111222',
      BACKUP_DIR: '/var/lib/chatbot/backups',
    });
    expect(result.values.SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(result.values.BACKUP_KEY).toMatch(/^[0-9a-f]{64}$/);
    // 009: secreto de salud propio, distinto de los otros dos.
    expect(result.values.HEALTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(result.values.HEALTH_SECRET).not.toBe(result.values.SESSION_SECRET);
    expect(result.values.HEALTH_SECRET).not.toBe(result.values.BACKUP_KEY);
    expect(result.instance.fingerprints.map((f) => f.variable)).toContain('HEALTH_SECRET');
    expect(JSON.stringify(result.instance)).not.toContain(result.values.HEALTH_SECRET);
    expect(result.values.WHATSAPP_VERIFY_TOKEN).toMatch(/^[0-9a-f]{48}$/);
    expect(result.values.OPERATOR_PASSWORD_HASH).toMatch(/^\$argon2id\$/);
    expect(Object.keys(result.pending).sort()).toEqual(
      [
        'ANTHROPIC_API_KEY',
        'DATABASE_URL',
        'SMTP_FROM',
        'SMTP_URL',
        'WHATSAPP_ACCESS_TOKEN',
        'WHATSAPP_APP_SECRET',
        'WHATSAPP_GRAPH_VERSION',
        'WHATSAPP_PHONE_NUMBER_ID',
      ].sort(),
    );
    expect(result.instance).toMatchObject({
      id: 'demo-09',
      client: 'Cliente de prueba',
      status: 'provisioning',
      publicUrl: 'https://demo-09.ejemplo.com',
      database: null,
      dates: { provisioned: TODAY, retired: null, dataDeleted: null },
    });
    const variables = result.instance.fingerprints.map((f) => f.variable);
    expect(variables).toEqual(
      expect.arrayContaining([
        'SESSION_SECRET',
        'BACKUP_KEY',
        'OPERATOR_PASSWORD_HASH',
        'WHATSAPP_VERIFY_TOKEN',
        'PUBLIC_BASE_URL',
        'BACKUP_DIR',
      ]),
    );
    expect(result.password).toHaveLength(24);
    expect(JSON.stringify(result.instance)).not.toContain(result.password);
  });

  it('sin WhatsApp no hay token ni pendientes de WhatsApp', async () => {
    const result = await buildInstanceEnv(
      validateMinimalData(input()),
      null,
      TEST_INVENTORY_KEY,
      deps,
    );
    expect(result.values.WHATSAPP_VERIFY_TOKEN).toBeUndefined();
    expect(Object.keys(result.pending).some((k) => k.startsWith('WHATSAPP_'))).toBe(false);
  });

  it('si una huella generada coincide con el inventario, regenera (máximo 3 intentos)', async () => {
    const repeated = randomBytes(32);
    const inventory = createInventory(TEST_INVENTORY_KEY, TODAY);
    inventory.instances.push(
      instanceFromEnv(productionEnv('demo-01', { SESSION_SECRET: repeated.toString('hex') })),
    );
    let calls = 0;
    /** Las dos primeras claves son la ya usada; después, aleatorias. */
    const random: RandomSource = {
      bytes: (n) => (n === 32 && calls++ < 1 ? Buffer.from(repeated) : cryptoRandom.bytes(n)),
      int: (max) => cryptoRandom.int(max),
    };
    const result = await buildInstanceEnv(
      validateMinimalData(input()),
      inventory,
      TEST_INVENTORY_KEY,
      {
        ...deps,
        random,
      },
    );
    expect(result.values.SESSION_SECRET).not.toBe(repeated.toString('hex'));

    const always: RandomSource = {
      bytes: (n) => (n === 32 ? Buffer.from(repeated) : cryptoRandom.bytes(n)),
      int: (max) => cryptoRandom.int(max),
    };
    await expect(
      buildInstanceEnv(validateMinimalData(input()), inventory, TEST_INVENTORY_KEY, {
        ...deps,
        random: always,
      }),
    ).rejects.toMatchObject({ code: 'duplicate_value' });
  });

  it('SC-004: 100 generaciones seguidas sin ningún secreto repetido', async () => {
    const seen = new Set<string>();
    let total = 0;
    for (let i = 0; i < 100; i++) {
      const data = validateMinimalData(
        input({
          id: `demo-${String(i)}`,
          url: `https://d${String(i)}.ejemplo.com`,
          whatsapp: true,
        }),
      );
      const result = await buildInstanceEnv(data, null, TEST_INVENTORY_KEY, deps);
      for (const value of [
        result.values.SESSION_SECRET,
        result.values.BACKUP_KEY,
        result.values.HEALTH_SECRET,
        result.values.WHATSAPP_VERIFY_TOKEN,
        result.values.OPERATOR_PASSWORD_HASH,
        result.password,
      ]) {
        seen.add(value ?? '');
        total++;
      }
    }
    expect(seen.size).toBe(total);
    // La huella de la URL no depende de la generación: control de que la clave se usa.
    expect(fingerprint(TEST_INVENTORY_KEY, 'public_url', 'x')).toHaveLength(22);
  });
});
