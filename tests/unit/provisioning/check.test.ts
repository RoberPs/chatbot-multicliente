import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  checkResultJson,
  formatCheckResult,
  validate,
  type CheckResult,
} from '../../../src/provisioning/check.js';
import type { EnvMap } from '../../../src/provisioning/env-file.js';
import { createInventory, type InventoryAccess } from '../../../src/provisioning/inventory.js';
import {
  argonHash,
  collectSecrets,
  containsAny,
  instanceFromEnv,
  productionEnv,
  TEST_INVENTORY_KEY,
  TODAY,
  whatsappVars,
} from '../../helpers/provisioning.js';

const token = (n: number) => randomBytes(n).toString('base64url');
const hex = () => randomBytes(32).toString('hex');

/** Tres instancias con todos los secretos: activa, dada de baja y de pruebas. */
function fullEnv(id: string, extra: EnvMap = {}): EnvMap {
  return productionEnv(id, {
    ...whatsappVars(),
    STT_API_KEY: `stt-${token(24)}`,
    SMTP_URL: `smtps://avisos:${token(18)}@correo-${id}.ejemplo.com:465`,
    SMTP_FROM: `avisos@${id}.ejemplo.com`,
    BACKUP_KEYS_PREVIOUS: hex(),
    ...extra,
  });
}

const demo01 = fullEnv('demo-01');
const demo02 = fullEnv('demo-02');
const demo03 = fullEnv('demo-03', {
  NODE_ENV: 'development',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  TRUST_PROXY: '',
  DATABASE_URL: `postgres://chatbot_demo_03:${token(24)}@localhost:5432/chatbot_demo_03`,
});

const inventory = createInventory(TEST_INVENTORY_KEY, TODAY);
inventory.instances.push(
  instanceFromEnv(demo01, { status: 'active' }),
  instanceFromEnv(demo02, { status: 'retired' }),
  instanceFromEnv(demo03, { status: 'testing' }),
);
const access: InventoryAccess = {
  kind: 'ok',
  path: '/inv/inventory.json',
  inventory,
  key: TEST_INVENTORY_KEY,
};

/** Entorno nuevo, apto, sin nada en común con el inventario. */
const fresh = (overrides: EnvMap = {}): EnvMap => productionEnv('demo-09', overrides);

const run = (env: EnvMap, acc: InventoryAccess = access): CheckResult => validate(env, acc);
const errorKeys = (r: CheckResult) => r.errors.map((e) => `${e.code}:${e.variable ?? '-'}`);
const warningKeys = (r: CheckResult) => r.warnings.map((e) => `${e.code}:${e.variable ?? '-'}`);

function expectSecretFree(result: CheckResult, ...envs: EnvMap[]): void {
  const text = `${checkResultJson(result)}\n${formatCheckResult(result)}`;
  const secrets = envs.flatMap(collectSecrets);
  expect(containsAny(text, secrets)).toBe(false);
}

describe('validate: entorno apto', () => {
  it('un entorno nuevo completo → apto, comparado con las 3 instancias', () => {
    const env = fresh();
    const result = run(env);
    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({
      ok: true,
      instanceId: 'demo-09',
      profile: 'production',
      compared: true,
      comparedWith: 3,
    });
    expect(warningKeys(result)).toEqual(
      expect.arrayContaining(['not_registered:INSTANCE_ID', 'pending_optional:SMTP_URL']),
    );
    expectSecretFree(result, env);
  });

  it('la propia instancia no cuenta como repetida (US1-6)', () => {
    const result = run(demo01);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.comparedWith).toBe(2);
    expect(warningKeys(result)).not.toContain('not_registered:INSTANCE_ID');
    expectSecretFree(result, demo01, demo02, demo03);
  });
});

describe('validate: tabla SC-002 (cada incoherencia y cada repetición → no apto)', () => {
  const pw = token(24);
  const cases: Array<[string, EnvMap, string]> = [
    // FR-003
    [
      'URL http',
      fresh({ PUBLIC_BASE_URL: 'http://demo.ejemplo.com' }),
      'public_url_not_https:PUBLIC_BASE_URL',
    ],
    [
      'URL localhost',
      fresh({ PUBLIC_BASE_URL: 'http://localhost:3000' }),
      'public_url_not_https:PUBLIC_BASE_URL',
    ],
    [
      'URL https localhost',
      fresh({ PUBLIC_BASE_URL: 'https://localhost' }),
      'public_url_not_https:PUBLIC_BASE_URL',
    ],
    [
      'WhatsApp parcial',
      fresh({ WHATSAPP_PHONE_NUMBER_ID: '123456789012345' }),
      'whatsapp_incomplete:WHATSAPP_ACCESS_TOKEN',
    ],
    [
      'SMTP sin remitente',
      fresh({ SMTP_URL: `smtps://avisos:${token(18)}@correo.ejemplo.com:465` }),
      'smtp_incomplete:SMTP_FROM',
    ],
    ['remitente sin SMTP', fresh({ SMTP_FROM: 'avisos@ejemplo.com' }), 'smtp_incomplete:SMTP_URL'],
    [
      'WhatsApp sin clave del modelo',
      fresh({ ...whatsappVars(), ANTHROPIC_API_KEY: '' }),
      'llm_key_required:ANTHROPIC_API_KEY',
    ],
    [
      'teléfono no válido',
      fresh({ EMERGENCY_CONTACT_PHONE: '600' }),
      'core_rule:EMERGENCY_CONTACT_PHONE',
    ],
    [
      'zona inexistente',
      fresh({ DEFAULT_TIMEZONE: 'Europe/Nowhere' }),
      'core_rule:DEFAULT_TIMEZONE',
    ],
    [
      'retención fuera de rango',
      fresh({ BACKUP_RETENTION_DAYS: '31' }),
      'core_rule:BACKUP_RETENTION_DAYS',
    ],
    ['hora fuera de rango', fresh({ BACKUP_DAILY_TIME: '25:00' }), 'core_rule:BACKUP_DAILY_TIME'],
    ['TRUST_PROXY=true', fresh({ TRUST_PROXY: 'true' }), 'trust_proxy_all:TRUST_PROXY'],
    [
      'clave de copias igual a la sesión',
      ((e) => ({ ...e, BACKUP_KEY: e.SESSION_SECRET ?? '' }))(fresh()),
      'backup_key_equals_session:BACKUP_KEY',
    ],
    ['INSTANCE_ID mal formado', fresh({ INSTANCE_ID: 'Demo_09' }), 'core_rule:INSTANCE_ID'],
    // FR-002
    ['sin INSTANCE_ID', fresh({ INSTANCE_ID: '' }), 'missing:INSTANCE_ID'],
    ['sin BACKUP_DIR', fresh({ BACKUP_DIR: '' }), 'missing:BACKUP_DIR'],
    ['sin BACKUP_KEY', fresh({ BACKUP_KEY: '' }), 'missing:BACKUP_KEY'],
    ['sin DATABASE_URL', fresh({ DATABASE_URL: '' }), 'missing:DATABASE_URL'],
    [
      'sin hash del operador',
      fresh({ OPERATOR_PASSWORD_HASH: '' }),
      'missing:OPERATOR_PASSWORD_HASH',
    ],
    ['sin SESSION_SECRET', fresh({ SESSION_SECRET: '' }), 'missing:SESSION_SECRET'],
    // 009: secreto de salud
    ['sin HEALTH_SECRET', fresh({ HEALTH_SECRET: '' }), 'missing:HEALTH_SECRET'],
    [
      'secreto de salud débil',
      fresh({ HEALTH_SECRET: 'ab'.repeat(32) }),
      'core_rule:HEALTH_SECRET',
    ],
    [
      'secreto de salud igual a la sesión',
      ((e) => ({ ...e, HEALTH_SECRET: e.SESSION_SECRET ?? '' }))(fresh()),
      'health_secret_equals_session:HEALTH_SECRET',
    ],
    [
      'secreto de salud igual a la clave de copias',
      ((e) => ({ ...e, HEALTH_SECRET: (e.BACKUP_KEY ?? '').toUpperCase() }))(fresh()),
      'health_secret_equals_backup_key:HEALTH_SECRET',
    ],
    ['sin PUBLIC_BASE_URL', fresh({ PUBLIC_BASE_URL: '' }), 'missing:PUBLIC_BASE_URL'],
    [
      'bot sin teléfono de emergencia',
      fresh({ EMERGENCY_CONTACT_PHONE: '' }),
      'missing:EMERGENCY_CONTACT_PHONE',
    ],
    ['NODE_ENV development', fresh({ NODE_ENV: 'development' }), 'not_production:NODE_ENV'],
    // FR-004
    [
      'clave del modelo de relleno',
      fresh({ ANTHROPIC_API_KEY: 'sk-ant-test-0123456789abcdefghijklmnopqrstuvwxyz' }),
      'weak_secret:ANTHROPIC_API_KEY',
    ],
    [
      'token de WhatsApp corto',
      fresh({ ...whatsappVars(), WHATSAPP_ACCESS_TOKEN: 'changeme123' }),
      'weak_secret:WHATSAPP_ACCESS_TOKEN',
    ],
    [
      'contraseña de BD corta',
      fresh({ DATABASE_URL: 'postgres://chatbot_demo_09:corta@db.interna:5432/chatbot_demo_09' }),
      'weak_secret:DATABASE_URL',
    ],
    [
      'BD de ejemplo',
      fresh({ DATABASE_URL: 'postgres://chatbot:chatbot@db.interna:5432/chatbot' }),
      'example_database:DATABASE_URL',
    ],
    [
      'hash que no es Argon2id',
      fresh({ OPERATOR_PASSWORD_HASH: 'plano' }),
      'core_rule:OPERATOR_PASSWORD_HASH',
    ],
    // FR-005 dentro del entorno
    [
      'secreto repetido dentro del entorno',
      ((w) => fresh({ ...w, WHATSAPP_APP_SECRET: w.WHATSAPP_VERIFY_TOKEN ?? '' }))(whatsappVars()),
      'secret_reused_within:WHATSAPP_VERIFY_TOKEN',
    ],
    // FR-005 con el inventario
    [
      'INSTANCE_ID de otra instancia',
      fresh({ INSTANCE_ID: 'demo-01' }),
      'duplicate_instance_id:INSTANCE_ID',
    ],
    [
      // Encontrado al recorrer el quickstart (T053): el BACKUP_DIR y el SMTP compartidos no
      // hacen que un entorno ajeno pase por la propia instancia.
      'INSTANCE_ID de otra instancia con su mismo BACKUP_DIR y SMTP',
      fresh({
        INSTANCE_ID: 'demo-01',
        BACKUP_DIR: demo01.BACKUP_DIR ?? '',
        SMTP_URL: demo01.SMTP_URL ?? '',
        SMTP_FROM: 'avisos@ejemplo.com',
      }),
      'duplicate_instance_id:INSTANCE_ID',
    ],
    [
      'misma BD',
      fresh({ DATABASE_URL: `postgres://otro_usuario:${pw}@DB.interna:5432/chatbot_demo_01` }),
      'duplicate_database:DATABASE_URL',
    ],
    [
      'mismo usuario de BD',
      fresh({ DATABASE_URL: `postgres://chatbot_demo_01:${pw}@db.interna/otra_bd` }),
      'duplicate_database_user:DATABASE_URL',
    ],
    [
      'misma URL pública',
      fresh({ PUBLIC_BASE_URL: 'https://DEMO-01.ejemplo.com/' }),
      'duplicate_public_url:PUBLIC_BASE_URL',
    ],
    [
      'mismo número de WhatsApp',
      fresh({ ...whatsappVars(), WHATSAPP_PHONE_NUMBER_ID: demo01.WHATSAPP_PHONE_NUMBER_ID ?? '' }),
      'duplicate_whatsapp_phone:WHATSAPP_PHONE_NUMBER_ID',
    ],
  ];

  it.each(cases)('%s → %s', (_name, env, expected) => {
    const result = run(env);
    expect(result.ok).toBe(false);
    expect(errorKeys(result)).toContain(expected);
    expectSecretFree(result, env, demo01);
  });

  it('sin HEALTH_SECRET tampoco es apto en el perfil testing', () => {
    const { HEALTH_SECRET: _h, ...rest } = demo03;
    expect(errorKeys(run(rest))).toContain('missing:HEALTH_SECRET');
  });

  it('HEALTH_SECRET débil por calidad (no hex aleatorio) → weak_secret o regla del núcleo', () => {
    const result = run(fresh({ HEALTH_SECRET: 'changeme' }));
    expect(result.ok).toBe(false);
    expect(result.errors.filter((e) => e.variable === 'HEALTH_SECRET').length).toBeGreaterThan(0);
  });

  it('HEALTH_SECRET igual a SESSION_SECRET: un solo error, sin secret_reused_within', () => {
    const env = ((e) => ({ ...e, HEALTH_SECRET: e.SESSION_SECRET ?? '' }))(fresh());
    const keys = errorKeys(run(env));
    expect(keys.filter((k) => k.includes('HEALTH_SECRET'))).toEqual([
      'health_secret_equals_session:HEALTH_SECRET',
    ]);
    expect(keys.some((k) => k.startsWith('secret_reused_within'))).toBe(false);
    const finding = run(env).errors.find((e) => e.code === 'health_secret_equals_session');
    expect(finding?.action).toContain('openssl rand -hex 32');
  });

  const secretVariables = [
    'SESSION_SECRET',
    'BACKUP_KEY',
    'HEALTH_SECRET',
    'OPERATOR_PASSWORD_HASH',
    'ANTHROPIC_API_KEY',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
    'STT_API_KEY',
  ];

  it.each(secretVariables)('%s igual al de otra instancia → duplicate_secret', (variable) => {
    const env = fresh({
      ...whatsappVars(),
      STT_API_KEY: `stt-${token(24)}`,
      [variable]: demo01[variable] ?? '',
    });
    const result = run(env);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'duplicate_secret',
        variable,
        otherInstance: 'demo-01',
        otherVariable: variable,
        otherCurrent: true,
      }),
    );
    expectSecretFree(result, env, demo01);
  });

  it('contraseña de la BD igual a la de otra instancia → duplicate_secret en DATABASE_URL', () => {
    const password = new URL(demo01.DATABASE_URL ?? '').password;
    const env = fresh({
      DATABASE_URL: `postgres://u_demo_09:${password}@otro.servidor:5432/bd_demo_09`,
    });
    const result = run(env);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'duplicate_secret',
        variable: 'DATABASE_URL',
        otherVariable: 'DATABASE_PASSWORD',
        otherInstance: 'demo-01',
      }),
    );
  });

  it('clave de copias igual a una clave anterior de otra instancia (otherCurrent: false)', () => {
    const env = fresh({ BACKUP_KEY: demo01.BACKUP_KEYS_PREVIOUS ?? '' });
    expect(run(env).errors).toContainEqual(
      expect.objectContaining({
        code: 'duplicate_secret',
        variable: 'BACKUP_KEY',
        otherVariable: 'BACKUP_KEYS_PREVIOUS',
        otherCurrent: false,
      }),
    );
  });

  it('clave anterior propia igual a la clave vigente de otra instancia', () => {
    const env = fresh({ BACKUP_KEYS_PREVIOUS: demo01.BACKUP_KEY ?? '' });
    expect(errorKeys(run(env))).toContain('duplicate_secret:BACKUP_KEYS_PREVIOUS');
  });

  it('secreto repetido entre variables distintas (SESSION_SECRET = BACKUP_KEY de otra)', () => {
    const env = fresh({ SESSION_SECRET: demo01.BACKUP_KEY ?? '' });
    expect(run(env).errors).toContainEqual(
      expect.objectContaining({
        code: 'duplicate_secret',
        variable: 'SESSION_SECRET',
        otherVariable: 'BACKUP_KEY',
      }),
    );
  });

  it('se compara con las instancias dadas de baja (FR-029)', () => {
    const env = fresh({ SESSION_SECRET: demo02.SESSION_SECRET ?? '' });
    expect(run(env).errors).toContainEqual(
      expect.objectContaining({ code: 'duplicate_secret', otherInstance: 'demo-02' }),
    );
  });

  it('SMTP_URL igual a la de otra instancia → advertencia shared_smtp (apto)', () => {
    const env = fresh({ SMTP_URL: demo01.SMTP_URL ?? '', SMTP_FROM: 'avisos@ejemplo.com' });
    const result = run(env);
    expect(result.ok).toBe(true);
    expect(warningKeys(result)).toContain('shared_smtp:SMTP_URL');
  });

  it('SMTP_URL igual al secreto de otra variable de otra instancia → error', () => {
    const smtp = `smtps://avisos:${token(30)}@correo.ejemplo.com:465`;
    const other = fullEnv('demo-07', { WHATSAPP_ACCESS_TOKEN: smtp });
    const inv = structuredClone(inventory);
    inv.instances.push(instanceFromEnv(other));
    const env = fresh({ SMTP_URL: smtp, SMTP_FROM: 'avisos@ejemplo.com' });
    const result = run(env, { ...access, inventory: inv });
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'duplicate_secret',
        variable: 'SMTP_URL',
        otherVariable: 'WHATSAPP_ACCESS_TOKEN',
      }),
    );
  });

  it('BACKUP_DIR igual al de otra instancia → advertencia shared_backup_dir (apto)', () => {
    const result = run(fresh({ BACKUP_DIR: `${demo01.BACKUP_DIR ?? ''}/` }));
    expect(result.ok).toBe(true);
    expect(warningKeys(result)).toContain('shared_backup_dir:BACKUP_DIR');
  });

  it('los códigos específicos sustituyen al core_rule y lo desconocido sale como core_rule', () => {
    const result = run(fresh({ TRUST_PROXY: 'true', BACKUP_KEYS_PREVIOUS: 'abc' }));
    expect(errorKeys(result)).toContain('trust_proxy_all:TRUST_PROXY');
    expect(errorKeys(result)).not.toContain('core_rule:TRUST_PROXY');
    expect(errorKeys(result)).toContain('core_rule:BACKUP_KEYS_PREVIOUS');
    const stt = run(fresh({ AUDIO_TRANSCRIPTION: 'on' }));
    expect(errorKeys(stt)).toContain('core_rule:STT_API_KEY');
    expect(stt.errors.find((e) => e.variable === 'STT_API_KEY')?.message).toBe(
      'STT_API_KEY es obligatoria con AUDIO_TRANSCRIPTION=on',
    );
  });
});

describe('validate: advertencias, perfiles e inventario', () => {
  it('advertencias de producción', () => {
    const result = run(
      fresh({
        TRUST_PROXY: '',
        DATABASE_URL: `postgres://postgres:${token(24)}@localhost:5432/chatbot_demo_09`,
        ANTHROPIC_API_KEY: token(48),
        OPERATOR_PASSWORD_HASH: argonHash(4096, 1),
      }),
    );
    expect(result.ok).toBe(true);
    expect(warningKeys(result)).toEqual(
      expect.arrayContaining([
        'trust_proxy_empty:TRUST_PROXY',
        'database_superuser:DATABASE_URL',
        'database_localhost:DATABASE_URL',
        'llm_key_format:ANTHROPIC_API_KEY',
        'weak_argon2_params:OPERATOR_PASSWORD_HASH',
      ]),
    );
  });

  it('pending_optional para cada grupo opcional vacío', () => {
    const result = run(fresh({ ANTHROPIC_API_KEY: '', EMERGENCY_CONTACT_PHONE: '' }));
    expect(result.ok).toBe(true);
    expect(warningKeys(result)).toEqual(
      expect.arrayContaining([
        'pending_optional:ANTHROPIC_API_KEY',
        'pending_optional:SMTP_URL',
        'pending_optional:WHATSAPP_PHONE_NUMBER_ID',
      ]),
    );
  });

  it('perfil testing: no exige production, https, proxy ni BD remota', () => {
    const result = run(demo03);
    expect(result.profile).toBe('testing');
    expect(result.errors).toEqual([]);
    const codes = [...result.errors, ...result.warnings].map((f) => f.code);
    for (const code of [
      'not_production',
      'public_url_not_https',
      'trust_proxy_empty',
      'database_localhost',
    ]) {
      expect(codes).not.toContain(code);
    }
  });

  it('entorno de una instancia dada de baja → advertencia retired_instance', () => {
    const result = run(demo02);
    expect(result.errors).toEqual([]);
    expect(warningKeys(result)).toContain('retired_instance:INSTANCE_ID');
  });

  it('sin inventario → not_compared con la ruta buscada', () => {
    const result = run(fresh(), { kind: 'absent', path: '/ruta/buscada/inventory.json' });
    expect(result).toMatchObject({ ok: true, compared: false, comparedWith: 0 });
    const warning = result.warnings.find((w) => w.code === 'not_compared');
    expect(warning?.message).toContain('/ruta/buscada/inventory.json');
  });

  it.each([
    ['key_missing', 'inventory_key_missing'],
    ['key_wrong', 'inventory_key_wrong'],
  ] as const)('inventario con %s → no apto con %s (variable null)', (kind, code) => {
    const result = run(fresh(), { kind, path: '/inv.json' });
    expect(result.ok).toBe(false);
    expect(result.compared).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code, variable: null }));
  });

  it('inventario ilegible → no apto con inventory_unreadable', () => {
    const result = run(fresh(), {
      kind: 'unreadable',
      path: '/inv.json',
      reason: 'no es un JSON válido',
    });
    expect(errorKeys(result)).toContain('inventory_unreadable:-');
  });
});

describe('formato del resultado', () => {
  it('--json: una línea con los campos del contrato y sin detail', () => {
    const json = checkResultJson(run(fresh({ SESSION_SECRET: demo01.SESSION_SECRET ?? '' })));
    expect(json).not.toContain('\n');
    const parsed = JSON.parse(json) as CheckResult;
    expect(Object.keys(parsed)).toEqual([
      'ok',
      'instanceId',
      'profile',
      'compared',
      'comparedWith',
      'errors',
      'warnings',
    ]);
    expect(parsed.errors[0]).toEqual({
      code: 'duplicate_secret',
      variable: 'SESSION_SECRET',
      otherInstance: 'demo-01',
      otherVariable: 'SESSION_SECRET',
      otherCurrent: true,
      message: 'SESSION_SECRET es igual a SESSION_SECRET de la instancia demo-01.',
      action: 'Genera uno nuevo con openssl rand -hex 32.',
    });
  });

  it('para personas: cabecera, bloques y línea final', () => {
    const text = formatCheckResult(
      run(fresh({ SESSION_SECRET: demo01.SESSION_SECRET ?? '', BACKUP_KEY: '' })),
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('Validación de demo-09 (perfil production, comparado con 3 instancias)');
    expect(text).toContain('ERRORES (2)');
    expect(text).toContain(
      '  ✗ SESSION_SECRET: es igual a SESSION_SECRET de la instancia demo-01.',
    );
    expect(text).toContain('      → Genera uno nuevo con openssl rand -hex 32.');
    expect(text).toContain('  ✗ BACKUP_KEY: falta.');
    expect(text).toContain(
      '  ! SMTP_URL: SMTP_URL y SMTP_FROM están vacías: no habrá avisos de derivación por email.',
    );
    expect(lines.at(-1)).toBe('NO APTO para desplegar.');
    expect(formatCheckResult(run(fresh())).split('\n').at(-1)).toBe('APTO para desplegar.');
  });
});
