import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/instance.js';
import type { CheckResult } from '../../../src/provisioning/check.js';
import {
  collectSecrets,
  containsAny,
  instanceIO,
  OTHER_INVENTORY_KEY_HEX,
  sampleInventory,
  TEST_INVENTORY_KEY_HEX,
  testDeps,
  productionEnv,
  workspace,
  type Workspace,
} from '../../helpers/provisioning.js';

let ws: Workspace;
let sample: ReturnType<typeof sampleInventory>;

beforeEach(async () => {
  ws = await workspace();
  sample = sampleInventory(2);
  await ws.writeInventory(sample.inventory);
});
afterEach(async () => {
  await ws.remove();
});

const env = (extra: Record<string, string | undefined> = {}) => ({
  INSTANCE_INVENTORY: ws.inventoryPath,
  INSTANCE_INVENTORY_KEY: TEST_INVENTORY_KEY_HEX,
  ...extra,
});
const secrets = () => [...sample.envs.flatMap(collectSecrets), TEST_INVENTORY_KEY_HEX];

async function snapshot(path: string) {
  return { bytes: await readFile(path), mtime: (await stat(path)).mtimeMs };
}

describe('pnpm instance:check (US1)', () => {
  it('entorno apto → 0 y APTO para desplegar', async () => {
    const path = await ws.writeEnv('nuevo.env', productionEnv('demo-09'));
    const io = instanceIO(env());
    expect(await main(['check', path], io, testDeps())).toBe(0);
    const text = io.stdout.join('\n');
    expect(text).toContain('Validación de demo-09 (perfil production, comparado con 2 instancias)');
    expect(text.split('\n').at(-1)).toBe('APTO para desplegar.');
    expect(containsAny(io.all(), secrets())).toBe(false);
  });

  it('009: sin HEALTH_SECRET no es apto; copiado de otra instancia → secreto repetido', async () => {
    const { HEALTH_SECRET: _h, ...without } = productionEnv('demo-09');
    const missing = instanceIO(env());
    expect(await main(['check', await ws.writeEnv('sin.env', without)], missing, testDeps())).toBe(
      1,
    );
    expect(missing.stdout.join('\n')).toContain('HEALTH_SECRET: falta.');

    const copied = productionEnv('demo-09', { HEALTH_SECRET: sample.envs[0]?.HEALTH_SECRET ?? '' });
    const io = instanceIO(env());
    const path = await ws.writeEnv('copiado.env', copied);
    expect(await main(['check', path, '--json'], io, testDeps())).toBe(1);
    const result = JSON.parse(io.stdout.join('')) as CheckResult;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'duplicate_secret',
        variable: 'HEALTH_SECRET',
        otherInstance: 'demo-01',
        otherVariable: 'HEALTH_SECRET',
      }),
    );
    expect(containsAny(io.all(), secrets())).toBe(false);
  });

  it('no apto → 1 con la salida para personas, sin ningún secreto', async () => {
    const bad = productionEnv('demo-09', {
      SESSION_SECRET: sample.envs[0]?.SESSION_SECRET ?? '',
      BACKUP_KEY: '',
    });
    const path = await ws.writeEnv('malo.env', bad);
    const io = instanceIO(env());
    expect(await main(['check', path], io, testDeps())).toBe(1);
    const text = io.stdout.join('\n');
    expect(text).toContain('ERRORES (2)');
    expect(text).toContain(
      '  ✗ SESSION_SECRET: es igual a SESSION_SECRET de la instancia demo-01.',
    );
    expect(text).toContain('  ✗ BACKUP_KEY: falta.');
    expect(text.split('\n').at(-1)).toBe('NO APTO para desplegar.');
    expect(containsAny(io.all(), [...secrets(), ...collectSecrets(bad)])).toBe(false);
  });

  it('--json → una sola línea con el resultado', async () => {
    const path = await ws.writeEnv('nuevo.env', productionEnv('demo-09', { NODE_ENV: 'test' }));
    const io = instanceIO(env());
    expect(await main(['check', path, '--json'], io, testDeps())).toBe(1);
    expect(io.stdout).toHaveLength(1);
    const result = JSON.parse(io.stdout[0] ?? '{}') as CheckResult;
    expect(result).toMatchObject({
      ok: false,
      instanceId: 'demo-09',
      compared: true,
      comparedWith: 2,
    });
    expect(result.errors.map((e) => e.code)).toContain('not_production');
    for (const f of [...result.errors, ...result.warnings]) {
      expect(Object.keys(f)).not.toContain('detail');
      expect(typeof f.action).toBe('string');
    }
  });

  it('fichero inexistente → 2 sin JSON', async () => {
    const io = instanceIO(env());
    expect(await main(['check', join(ws.dir, 'no.env'), '--json'], io, testDeps())).toBe(2);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join('\n')).toContain('No se puede leer el fichero de entorno');
  });

  it('argumentos no válidos → 2', async () => {
    const io = instanceIO(env());
    expect(await main(['check'], io, testDeps())).toBe(2);
    expect(await main(['check', 'a', '--otra'], io, testDeps())).toBe(2);
    expect(await main(['desconocida'], io, testDeps())).toBe(2);
  });

  it.each([
    ['sin clave', { INSTANCE_INVENTORY_KEY: undefined }, 'inventory_key_missing'],
    [
      'clave equivocada',
      { INSTANCE_INVENTORY_KEY: OTHER_INVENTORY_KEY_HEX },
      'inventory_key_wrong',
    ],
  ])('inventario %s → 1 con %s', async (_name, extra, code) => {
    const path = await ws.writeEnv('nuevo.env', productionEnv('demo-09'));
    const io = instanceIO(env(extra));
    expect(await main(['check', path, '--json'], io, testDeps())).toBe(1);
    const result = JSON.parse(io.stdout[0] ?? '{}') as CheckResult;
    expect(result.errors).toContainEqual(expect.objectContaining({ code, variable: null }));
  });

  it('inventario corrupto → 1 con inventory_unreadable', async () => {
    await writeFile(ws.inventoryPath, '{ roto');
    const path = await ws.writeEnv('nuevo.env', productionEnv('demo-09'));
    const io = instanceIO(env());
    expect(await main(['check', path, '--json'], io, testDeps())).toBe(1);
    expect(io.stdout[0]).toContain('inventory_unreadable');
  });

  it('sin inventario → 0 con not_compared que nombra la ruta buscada', async () => {
    const missing = join(ws.dir, 'otro', 'inventory.json');
    const path = await ws.writeEnv('nuevo.env', productionEnv('demo-09'));
    const io = instanceIO(env({ INSTANCE_INVENTORY: missing }));
    expect(await main(['check', path], io, testDeps())).toBe(0);
    expect(io.stdout.join('\n')).toContain(missing);
  });

  it('no escribe: entorno e inventario conservan bytes y mtime; no se crea .lock (FR-009)', async () => {
    const path = await ws.writeEnv('propio.env', sample.envs[0] ?? {});
    const envBefore = await snapshot(path);
    const invBefore = await snapshot(ws.inventoryPath);
    const io = instanceIO(env());
    expect(await main(['check', path], io, testDeps())).toBe(0);
    expect(await snapshot(path)).toEqual(envBefore);
    expect(await snapshot(ws.inventoryPath)).toEqual(invBefore);
    expect((await readdir(ws.dir)).some((n) => n.endsWith('.lock'))).toBe(false);
  });
});
