import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyCheck } from '../../../src/provisioning/fingerprint.js';
import {
  formatInstanceList,
  inventorySchema,
  listView,
  loadInventoryForUse,
  recordVerification,
  registerInstance,
  resolveInventoryPath,
  retireInstance,
  serializeInventory,
  syncInstance,
  updateInstance,
  type Inventory,
} from '../../../src/provisioning/inventory.js';
import { ProvisioningError } from '../../../src/provisioning/messages.js';
import {
  collectSecrets,
  containsAny,
  OTHER_INVENTORY_KEY_HEX,
  productionEnv,
  sampleInventory,
  TEST_INVENTORY_KEY,
  TEST_INVENTORY_KEY_HEX,
  TODAY,
} from '../../helpers/provisioning.js';

/** Ejemplo de contracts/inventory-format.md con huellas de 22 caracteres. */
const EXAMPLE: Inventory = {
  format: 'chatbot-inventory',
  version: 1,
  keyCheck: keyCheck(TEST_INVENTORY_KEY),
  createdAt: '2026-09-30',
  instances: [
    {
      id: 'demo-01',
      client: 'Cliente de ejemplo',
      status: 'active',
      publicUrl: 'https://demo-01.ejemplo.com',
      imageVersion: '0.1.0',
      llmWorkspace: 'demo-01',
      llmProvider: 'anthropic',
      backupKeyLocation: 'Gestor de secretos, entrada demo-01/BACKUP_KEY',
      backupDir: '/var/lib/chatbot/backups',
      database: {
        host: 'db.interna',
        port: 5432,
        name: 'chatbot_demo_01',
        user: 'chatbot_demo_01',
      },
      dates: { provisioned: '2026-09-30', retired: null, dataDeleted: null },
      lastVerification: {
        at: '2026-09-30T12:40:11+02:00',
        file: 'demo-01__0005_x__20260930T1015Z__manual.cbak',
        result: 'restorable',
      },
      lastSuccessfulVerificationAt: '2026-09-30T12:40:11+02:00',
      fingerprints: [
        {
          variable: 'SESSION_SECRET',
          class: 'secret',
          value: 'Zb1cAAAAAAAAAAAAAAAAAA',
          current: true,
          since: '2026-09-30',
        },
      ],
    },
  ],
};

const clone = (): Inventory => structuredClone(EXAMPLE);
const first = (inv: Inventory) => inv.instances[0] as Inventory['instances'][number];

describe('esquema del inventario (contracts/inventory-format.md)', () => {
  it('acepta el ejemplo del contrato', () => {
    expect(inventorySchema.safeParse(EXAMPLE).success).toBe(true);
  });

  it.each([
    ['version 2', (i: Inventory) => Object.assign(i, { version: 2 })],
    ['otro format', (i: Inventory) => Object.assign(i, { format: 'otro' })],
    ['campo desconocido en la raíz', (i: Inventory) => Object.assign(i, { extra: 1 })],
    [
      'campo desconocido en una instancia',
      (i: Inventory) => Object.assign(first(i), { secret: 'x' }),
    ],
    ['ids repetidos', (i: Inventory) => i.instances.push(structuredClone(first(i)))],
    ['retired sin fecha de baja', (i: Inventory) => (first(i).status = 'retired')],
    ['fecha de baja sin retired', (i: Inventory) => (first(i).dates.retired = '2026-09-30')],
    ['dataDeleted sin retired', (i: Inventory) => (first(i).dates.dataDeleted = '2026-09-30')],
    [
      'URL con credenciales en un texto',
      (i: Inventory) => (first(i).llmWorkspace = 'postgres://u:clave@h/db'),
    ],
    ['estado desconocido', (i: Inventory) => Object.assign(first(i), { status: 'pausada' })],
  ])('rechaza: %s', (_name, mutate) => {
    const inv = clone();
    mutate(inv);
    expect(inventorySchema.safeParse(inv).success).toBe(false);
  });

  /**
   * 017 (FR-009): el campo del proveedor es nuevo y hay inventarios reales ahí fuera. Como
   * `instanceSchema` es un `strictObject`, un campo **obligatorio** dejaría de cargar esos
   * ficheros y rompería `instance:list` antes de que nadie pudiera arreglarlo. Por eso entra como
   * nullable con valor por defecto y `version` se queda en 1: no es un formato nuevo.
   */
  it('un inventario anterior a la 017, sin el campo del proveedor, sigue cargando', () => {
    const inv = clone() as unknown as Record<string, unknown>;
    const instances = inv.instances as Array<Record<string, unknown>>;
    for (const instance of instances) delete instance.llmProvider;
    const parsed = inventorySchema.safeParse(inv);
    expect(parsed.success).toBe(true);
    // `null` es «el inventario no lo sabe», distinto de cualquier proveedor concreto.
    expect(parsed.data?.instances[0]?.llmProvider).toBeNull();
  });

  it('rechaza un proveedor que no es elegible', () => {
    const inv = clone();
    Object.assign(first(inv), { llmProvider: 'mistral' });
    expect(inventorySchema.safeParse(inv).success).toBe(false);
  });

  it('serializeInventory ordena por id, sangría de 2 y salto de línea final', () => {
    const { inventory } = sampleInventory(3);
    inventory.instances.reverse();
    const text = serializeInventory(inventory);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "format": "chatbot-inventory"');
    const ids = (JSON.parse(text) as Inventory).instances.map((i) => i.id);
    expect(ids).toEqual(['demo-01', 'demo-02', 'demo-03']);
  });
});

describe('ruta y acceso', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'inv-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('--inventory › INSTANCE_INVENTORY › ~/.chatbotasesor/inventory.json', () => {
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    expect(resolveInventoryPath(a, { INSTANCE_INVENTORY: b })).toBe(resolve(a));
    expect(resolveInventoryPath(undefined, { INSTANCE_INVENTORY: b })).toBe(resolve(b));
    expect(resolveInventoryPath(undefined, { INSTANCE_INVENTORY: ' ' }, { home: dir })).toBe(
      join(dir, '.chatbotasesor', 'inventory.json'),
    );
    expect(resolveInventoryPath(undefined, {})).toBe(
      join(homedir(), '.chatbotasesor', 'inventory.json'),
    );
  });

  it('loadInventoryForUse distingue ausente, ilegible, sin clave y clave equivocada', async () => {
    const path = join(dir, 'inventory.json');
    expect(await loadInventoryForUse(path, TEST_INVENTORY_KEY_HEX)).toEqual({
      kind: 'absent',
      path,
    });

    await writeFile(path, '{ roto');
    expect(await loadInventoryForUse(path, TEST_INVENTORY_KEY_HEX)).toEqual({
      kind: 'unreadable',
      path,
      reason: 'no es un JSON válido',
    });

    await writeFile(path, JSON.stringify({ ...EXAMPLE, version: 2 }));
    const invalid = await loadInventoryForUse(path, TEST_INVENTORY_KEY_HEX);
    expect(invalid.kind).toBe('unreadable');
    expect(invalid.kind === 'unreadable' && invalid.reason).toBe('formato no válido en version');

    await writeFile(path, serializeInventory(EXAMPLE));
    expect((await loadInventoryForUse(path, undefined)).kind).toBe('key_missing');
    expect((await loadInventoryForUse(path, OTHER_INVENTORY_KEY_HEX)).kind).toBe('key_wrong');
    expect((await loadInventoryForUse(path, 'no-hex')).kind).toBe('key_wrong');
    const ok = await loadInventoryForUse(path, TEST_INVENTORY_KEY_HEX);
    expect(ok.kind).toBe('ok');
  });

  it('el motivo de un inventario no válido no incluye su contenido', async () => {
    const path = join(dir, 'secreto.json');
    await writeFile(path, JSON.stringify({ ...EXAMPLE, extra: 'contenido-privado' }));
    const read = await loadInventoryForUse(path, TEST_INVENTORY_KEY_HEX);
    expect(JSON.stringify(read)).not.toContain('contenido-privado');
  });
});

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof ProvisioningError ? error.code : 'otro';
  }
};
const byId = (inv: Inventory, id: string) => inv.instances.find((i) => i.id === id);

describe('operaciones del inventario (US4, research R9)', () => {
  it('registerInstance: registra con huellas; avisa de coincidencias y registra igualmente', () => {
    const { inventory, envs } = sampleInventory(2);
    const env = productionEnv('demo-05', { SESSION_SECRET: envs[0]?.SESSION_SECRET ?? '' });
    const result = registerInstance(inventory, env, TEST_INVENTORY_KEY, {
      client: 'Anterior',
      status: 'active',
      today: TODAY,
    });
    expect(result.instance).toMatchObject({
      id: 'demo-05',
      status: 'active',
      publicUrl: 'https://demo-05.ejemplo.com',
      database: {
        host: 'db.interna',
        port: 5432,
        name: 'chatbot_demo_05',
        user: 'chatbot_demo_05',
      },
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'duplicate_secret',
        variable: 'SESSION_SECRET',
        otherInstance: 'demo-01',
      }),
    );
    expect(byId(result.inventory, 'demo-05')).toBeDefined();
    expect(byId(inventory, 'demo-05')).toBeUndefined(); // no muta la entrada
    expect(containsAny(serializeInventory(result.inventory), collectSecrets(env))).toBe(false);

    const testing = registerInstance(inventory, productionEnv('demo-06'), TEST_INVENTORY_KEY, {
      client: 'Pruebas',
      status: 'testing',
      today: TODAY,
    });
    expect(testing.instance.status).toBe('testing');
  });

  // 017 (FR-009): el proveedor se registra; la credencial, nunca. Y un entorno sin `LLM_PROVIDER`
  // se registra como `anthropic`, que es lo que ese entorno significa (FR-003).
  it('registerInstance anota el proveedor declarado y ninguna credencial', () => {
    const { inventory } = sampleInventory(1);
    const opts = { client: 'X', status: 'active' as const, today: TODAY };
    const sinDeclarar = productionEnv('demo-07');
    expect(
      registerInstance(inventory, sinDeclarar, TEST_INVENTORY_KEY, opts).instance.llmProvider,
    ).toBe('anthropic');

    const gemini = productionEnv('demo-08', {
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: 'AIza-clave-de-prueba-de-gemini-larga',
      LLM_PROVIDER: 'gemini',
      LLM_MODEL: 'modelo-del-proveedor',
    });
    const result = registerInstance(inventory, gemini, TEST_INVENTORY_KEY, opts);
    expect(result.instance.llmProvider).toBe('gemini');
    const text = serializeInventory(result.inventory);
    // El valor no está en ninguna parte. El **nombre** de la variable sí, en la huella, y debe
    // estarlo: el inventario registra de qué variable es cada secreto, no el secreto.
    expect(containsAny(text, collectSecrets(gemini))).toBe(false);

    // Un valor mal escrito no impide registrar: lo rechaza la comprobación previa, con su mensaje.
    const malEscrito = productionEnv('demo-09', { LLM_PROVIDER: 'mistral' });
    expect(
      registerInstance(inventory, malEscrito, TEST_INVENTORY_KEY, opts).instance.llmProvider,
    ).toBeNull();
  });

  it('syncInstance rellena el proveedor de un inventario anterior y anota el cambio', () => {
    const { inventory, envs } = sampleInventory(1);
    const env = envs[0];
    if (!env) throw new Error('falta el entorno de ejemplo');
    // Inventario anterior a la 017: el campo existe pero no se sabe.
    const previo = structuredClone(inventory);
    const instance = previo.instances[0];
    if (!instance) throw new Error('falta la instancia de ejemplo');
    instance.llmProvider = null;

    const primera = syncInstance(previo, instance.id, env, TEST_INVENTORY_KEY, TODAY);
    expect(primera.inventory.instances[0]?.llmProvider).toBe('anthropic');
    expect(primera.changed).toContain('LLM_PROVIDER');

    // Y una segunda pasada sin cambios no vuelve a anotarlo: `changed` es «qué cambió».
    const again = syncInstance(primera.inventory, instance.id, env, TEST_INVENTORY_KEY, TODAY);
    expect(again.changed).not.toContain('LLM_PROVIDER');

    const cambiado = syncInstance(
      primera.inventory,
      instance.id,
      { ...env, LLM_PROVIDER: 'openai', LLM_MODEL: 'modelo-del-proveedor' },
      TEST_INVENTORY_KEY,
      TODAY,
    );
    expect(cambiado.inventory.instances[0]?.llmProvider).toBe('openai');
    expect(cambiado.changed).toContain('LLM_PROVIDER');
  });

  it('registerInstance rechaza id repetido y entorno sin INSTANCE_ID válido', () => {
    const { inventory } = sampleInventory(2);
    const opts = { client: 'X', status: 'active' as const, today: TODAY };
    const register = (env: Record<string, string>) => () =>
      registerInstance(inventory, env, TEST_INVENTORY_KEY, opts);
    expect(codeOf(register(productionEnv('demo-01')))).toBe('duplicate_instance_id');
    expect(codeOf(register(productionEnv('x', { INSTANCE_ID: 'Mal' })))).toBe(
      'env_invalid_instance',
    );
  });

  it('syncInstance: las huellas cambiadas pasan a anteriores, se añaden las nuevas y ninguna se borra', () => {
    const { inventory, envs } = sampleInventory(2);
    const before = byId(inventory, 'demo-01')?.fingerprints.length ?? 0;
    const rotated = {
      ...(envs[0] ?? {}),
      SESSION_SECRET: `${'f'.repeat(8)}${'0123456789abcdef'.repeat(3)}a1b2c3d4`,
      DATABASE_URL:
        'postgres://chatbot_demo_01:NuevaClaveLarga123456@nuevo.servidor:5433/chatbot_demo_01',
      PUBLIC_BASE_URL: 'https://nuevo-01.ejemplo.com',
    };
    const result = syncInstance(inventory, 'demo-01', rotated, TEST_INVENTORY_KEY, '2026-10-01');
    const inst = byId(result.inventory, 'demo-01');
    expect(result.changed).toEqual(['DATABASE_URL', 'PUBLIC_BASE_URL', 'SESSION_SECRET']);
    const sessions = inst?.fingerprints.filter((f) => f.variable === 'SESSION_SECRET') ?? [];
    expect(sessions.map((f) => f.current).sort()).toEqual([false, true]);
    expect(inst?.fingerprints.length).toBeGreaterThan(before);
    expect(inst?.database).toEqual({
      host: 'nuevo.servidor',
      port: 5433,
      name: 'chatbot_demo_01',
      user: 'chatbot_demo_01',
    });
    expect(inst?.publicUrl).toBe('https://nuevo-01.ejemplo.com');
    const same = syncInstance(inventory, 'demo-01', envs[0] ?? {}, TEST_INVENTORY_KEY, TODAY);
    expect(same.changed).toEqual([]);
  });

  it('syncInstance completa database cuando era null y avisa de coincidencias', () => {
    const { inventory, envs } = sampleInventory(2);
    const inst = byId(inventory, 'demo-01');
    if (inst) inst.database = null;
    const env = { ...(envs[0] ?? {}), BACKUP_KEY: envs[1]?.BACKUP_KEY ?? '' };
    const result = syncInstance(inventory, 'demo-01', env, TEST_INVENTORY_KEY, TODAY);
    expect(byId(result.inventory, 'demo-01')?.database?.name).toBe('chatbot_demo_01');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'duplicate_secret',
        variable: 'BACKUP_KEY',
        otherInstance: 'demo-02',
      }),
    );
    const sync = (id: string) => () =>
      syncInstance(inventory, id, envs[0] ?? {}, TEST_INVENTORY_KEY, TODAY);
    expect(codeOf(sync('demo-02'))).toBe('env_other_instance');
    expect(codeOf(sync('nada'))).toBe('unknown_instance');
  });

  it('updateInstance: transiciones, data-deleted solo en retired y textos que parecen secretos', () => {
    const { inventory } = sampleInventory(3);
    const updated = updateInstance(inventory, 'demo-01', {
      status: 'testing',
      image: '0.2.0',
      client: 'Nuevo',
    });
    expect(byId(updated, 'demo-01')).toMatchObject({
      status: 'testing',
      imageVersion: '0.2.0',
      client: 'Nuevo',
    });
    const update = (id: string, changes: Parameters<typeof updateInstance>[2]) => () =>
      updateInstance(inventory, id, changes);
    expect(codeOf(update('demo-02', { status: 'active' }))).toBe('invalid_transition');
    expect(codeOf(update('demo-01', { dataDeleted: '2026-10-01' }))).toBe('invalid_transition');
    const deleted = updateInstance(inventory, 'demo-02', { dataDeleted: '2026-10-01' });
    expect(byId(deleted, 'demo-02')?.dates.dataDeleted).toBe('2026-10-01');
    expect(codeOf(update('demo-02', { dataDeleted: '1/10/2026' }))).toBe('invalid_date');
    for (const text of [
      'postgres://u:clave@h/db',
      `${'a'.repeat(8)}${'0123456789abcdef'.repeat(3)}`,
      'sk-ant-api03-abcdef',
      'Qz7Kp2Wm9Rt4Yv8Nb3Hj6Lx1Fg5Dc0SaE9',
    ]) {
      expect(codeOf(update('demo-01', { backupKeyLocation: text }))).toBe('looks_like_secret');
    }
    const location = 'Gestor de secretos, entrada demo-01/BACKUP_KEY';
    const noted = updateInstance(inventory, 'demo-01', { backupKeyLocation: location });
    expect(byId(noted, 'demo-01')?.backupKeyLocation).toBe(location);
  });

  it('recordVerification: instancia por sourceInstance o por el prefijo del fichero', () => {
    const { inventory } = sampleInventory(2);
    const now = new Date('2026-09-30T12:40:11');
    const file = 'demo-01__0005_x__20260930T101500Z__manual.cbak';
    const ok = recordVerification(
      inventory,
      'demo-01',
      { file, restorable: true, sourceInstance: 'demo-01', durationMs: 5 },
      now,
    );
    const inst = byId(ok.inventory, 'demo-01');
    expect(inst?.lastVerification).toMatchObject({ file, result: 'restorable' });
    expect(inst?.lastSuccessfulVerificationAt).toBe(inst?.lastVerification?.at);
    expect(inventorySchema.safeParse(ok.inventory).success).toBe(true);

    const failed = recordVerification(
      ok.inventory,
      'demo-01',
      {
        file: '/copias/demo-01__0005_x__20261001T101500Z__daily.cbak',
        restorable: false,
        failure: 'wrong_key',
      },
      now,
    );
    const after = byId(failed.inventory, 'demo-01');
    expect(after?.lastVerification?.result).toBe('wrong_key');
    expect(after?.lastVerification?.file).toBe('demo-01__0005_x__20261001T101500Z__daily.cbak');
    expect(after?.lastSuccessfulVerificationAt).toBe(inst?.lastSuccessfulVerificationAt);

    const record = (report: unknown) => () => recordVerification(inventory, 'demo-01', report, now);
    expect(codeOf(record({ file: 'demo-02__x.cbak', restorable: true }))).toBe('other_instance');
    expect(codeOf(record({ ok: true }))).toBe('invalid_report');
    expect(codeOf(record({ file: 'sin-prefijo.cbak', restorable: true }))).toBe('invalid_report');
  });

  it('retireInstance: fecha de hoy y estado final', () => {
    const { inventory } = sampleInventory(2);
    const retired = retireInstance(inventory, 'demo-01', TODAY);
    expect(byId(retired, 'demo-01')).toMatchObject({
      status: 'retired',
      dates: { retired: TODAY },
    });
    expect(codeOf(() => retireInstance(retired, 'demo-01', TODAY))).toBe('invalid_transition');
    expect(codeOf(() => updateInstance(retired, 'demo-01', { status: 'active' }))).toBe(
      'invalid_transition',
    );
  });

  it('listView: verificación vencida solo en activas sin verificación correcta en 31 días; sin huellas', () => {
    const { inventory } = sampleInventory(3);
    const withRecent = recordVerification(
      inventory,
      'demo-01',
      { file: 'demo-01__a.cbak', restorable: true },
      new Date('2026-09-20T12:00:00Z'),
    ).inventory;
    let view = listView(withRecent, new Date('2026-09-30T12:00:00Z'));
    expect(view.map((v) => [v.id, v.verificationOverdue])).toEqual([
      ['demo-01', false],
      ['demo-02', false], // dada de baja
      ['demo-03', false], // de pruebas
    ]);
    expect(Object.keys(view[0] ?? {})).not.toContain('fingerprints');

    const later = new Date('2026-10-25T12:00:00Z');
    view = listView(withRecent, later);
    expect(view[0]?.verificationOverdue).toBe(true);
    const text = formatInstanceList(view, '/inv/inventory.json', later);
    expect(text.split('\n')[0]).toBe('Inventario /inv/inventory.json — 3 instancias');
    expect(text).toMatch(
      /^! demo-01 +Cliente demo-01 +activa +0\.1\.0 +anthropic +2026-09-20 restaurable \(35 días\)$/m,
    );
    expect(text).toMatch(
      /^ {2}demo-02 +Cliente demo-02 +de baja +0\.1\.0 +anthropic +— +\(baja 2026-09-30\)$/m,
    );
    expect(text).toContain('de pruebas');
    expect(text.split('\n').at(-1)).toBe(
      '! 1 instancia activa sin verificación correcta en los últimos 31 días.',
    );
  });
});
