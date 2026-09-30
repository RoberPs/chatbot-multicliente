import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/instance.js';
import type { CheckResult } from '../../../src/provisioning/check.js';
import type { EnvMap } from '../../../src/provisioning/env-file.js';
import {
  collectSecrets,
  containsAny,
  instanceIO,
  OTHER_INVENTORY_KEY_HEX,
  productionEnv,
  sampleInventory,
  TEST_INVENTORY_KEY_HEX,
  testDeps,
  workspace,
  type Workspace,
} from '../../helpers/provisioning.js';

let ws: Workspace;
let used: EnvMap[];

beforeEach(async () => {
  ws = await workspace();
  const sample = sampleInventory(2);
  used = [...sample.envs];
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

async function expectNoSecretsInInventory(): Promise<void> {
  const text = await ws.inventoryText();
  expect(containsAny(text, [...used.flatMap(collectSecrets), TEST_INVENTORY_KEY_HEX])).toBe(false);
}

async function writeEnv(name: string, values: EnvMap): Promise<string> {
  used.push(values);
  return ws.writeEnv(name, values);
}

describe('mantenimiento del inventario (US4)', () => {
  it('register → 0; con coincidencias avisa y registra igualmente', async () => {
    const own = await writeEnv('demo-05.env', productionEnv('demo-05'));
    let io = instanceIO(env());
    expect(await main(['register', own, '--client', 'Anterior'], io, testDeps())).toBe(0);
    expect(io.stdout[0]).toBe('Instancia demo-05 registrada en el inventario (estado: activa).');

    const copied = await writeEnv(
      'demo-06.env',
      productionEnv('demo-06', { SESSION_SECRET: used[0]?.SESSION_SECRET ?? '' }),
    );
    io = instanceIO(env());
    const args = ['register', copied, '--client', 'Copia', '--status', 'testing'];
    expect(await main(args, io, testDeps())).toBe(0);
    const out = io.stdout.join('\n');
    expect(out).toContain('(estado: de pruebas)');
    expect(out).toContain('SESSION_SECRET: es igual a SESSION_SECRET de la instancia demo-01.');
    expect(out).toContain(`pnpm instance:sync demo-06 ${copied}`);
    const inventory = await ws.readInventory();
    expect(inventory.instances.map((i) => i.id)).toEqual([
      'demo-01',
      'demo-02',
      'demo-05',
      'demo-06',
    ]);
    await expectNoSecretsInInventory();
  });

  it('register sin inventario: sin terminal → 2 inventory_missing; con --create-inventory lo crea', async () => {
    const other = join(ws.dir, 'nuevo', 'inventory.json');
    const file = await writeEnv('demo-07.env', productionEnv('demo-07'));
    let io = instanceIO(env({ INSTANCE_INVENTORY: other }));
    expect(await main(['register', file, '--client', 'X'], io, testDeps())).toBe(2);
    expect(io.stderr.join('\n')).toContain(`No existe un inventario en ${other}`);
    expect(existsSync(other)).toBe(false);

    io = instanceIO(env({ INSTANCE_INVENTORY: other }));
    const args = ['register', file, '--client', 'X', '--create-inventory'];
    expect(await main(args, io, testDeps())).toBe(0);
    expect(existsSync(other)).toBe(true);
  });

  it('verified: desde fichero y desde la entrada estándar; el informe de otra instancia se rechaza', async () => {
    const report = join(ws.dir, 'v.json');
    await writeFile(
      report,
      JSON.stringify({
        file: 'demo-01__0005_x__20260930T101500Z__manual.cbak',
        restorable: true,
        sourceInstance: 'demo-01',
        installedSchema: '0005_x',
        durationMs: 10,
      }),
    );
    let io = instanceIO(env());
    expect(await main(['verified', 'demo-01', report], io, testDeps())).toBe(0);
    expect(io.stdout[0]).toBe(
      'Verificación anotada: demo-01__0005_x__20260930T101500Z__manual.cbak · restaurable',
    );

    io = instanceIO(env(), {
      stdin: JSON.stringify({ file: 'demo-01__b.cbak', restorable: false, failure: 'wrong_key' }),
    });
    expect(await main(['verified', 'demo-01', '-'], io, testDeps())).toBe(0);
    expect(io.stdout[0]).toBe('Verificación anotada: demo-01__b.cbak · wrong_key');

    const before = await ws.inventoryText();
    io = instanceIO(env(), {
      stdin: JSON.stringify({ file: 'demo-02__c.cbak', restorable: true }),
    });
    expect(await main(['verified', 'demo-01', '-'], io, testDeps())).toBe(1);
    expect(io.stderr.join('\n')).toBe('La copia demo-02__c.cbak es de la instancia demo-02.');
    io = instanceIO(env(), { stdin: 'no es json' });
    expect(await main(['verified', 'demo-01', '-'], io, testDeps())).toBe(1);
    expect(await ws.inventoryText()).toBe(before);
  });

  it('update y list: marca ! y resumen; --json sin huellas; clave opcional pero comprobada', async () => {
    let io = instanceIO(env());
    const update = ['update', 'demo-01', '--status', 'active', '--image', '0.2.0'];
    expect(await main(update, io, testDeps())).toBe(0);

    io = instanceIO(env());
    expect(await main(['list'], io, testDeps())).toBe(0);
    const text = io.stdout.join('\n');
    expect(text).toContain(`Inventario ${ws.inventoryPath} — 2 instancias`);
    expect(text).toMatch(/^! demo-01 +Cliente demo-01 +activa +0\.2\.0 +—$/m);
    expect(text).toContain(
      '! 2 instancias activas sin verificación correcta en los últimos 31 días.',
    );

    io = instanceIO(env({ INSTANCE_INVENTORY_KEY: undefined }));
    expect(await main(['list', '--json'], io, testDeps())).toBe(0);
    const json = JSON.parse(io.stdout[0] ?? '{}') as {
      inventory: string;
      instances: Array<Record<string, unknown>>;
    };
    expect(json.inventory).toBe(ws.inventoryPath);
    expect(json.instances[0]).toMatchObject({
      id: 'demo-01',
      imageVersion: '0.2.0',
      verificationOverdue: true,
    });
    expect(Object.keys(json.instances[0] ?? {})).not.toContain('fingerprints');

    io = instanceIO(env({ INSTANCE_INVENTORY_KEY: OTHER_INVENTORY_KEY_HEX }));
    expect(await main(['list'], io, testDeps())).toBe(2);
    expect(io.stderr.join('\n')).toContain('no es la clave de este inventario');
  });

  it('update rechaza transiciones y textos con forma de secreto', async () => {
    const before = await ws.inventoryText();
    let io = instanceIO(env());
    const secretText = ['update', 'demo-01', '--backup-key-location', 'postgres://u:clave@h/db'];
    expect(await main(secretText, io, testDeps())).toBe(1);
    expect(io.stderr.join('\n')).toContain('parece un secreto');
    io = instanceIO(env());
    expect(await main(['update', 'demo-01', '--data-deleted', '2026-10-01'], io, testDeps())).toBe(
      1,
    );
    expect(await ws.inventoryText()).toBe(before);
    io = instanceIO(env());
    expect(await main(['update', 'demo-01'], io, testDeps())).toBe(2);
  });

  it('retire pide el id (o --yes sin terminal); después el id y los secretos siguen contando', async () => {
    let io = instanceIO(env());
    expect(await main(['retire', 'demo-02'], io, testDeps())).toBe(2);

    io = instanceIO(env(), { tty: true, answers: ['otro'] });
    expect(await main(['retire', 'demo-02'], io, testDeps())).toBe(1);

    io = instanceIO(env(), { tty: true, answers: ['demo-02'] });
    expect(await main(['retire', 'demo-02'], io, testDeps())).toBe(0);
    const out = io.stdout.join('\n');
    expect(out).toContain('Instancia demo-02 dada de baja en el inventario.');
    expect(out).toContain('pnpm instance:update demo-02 --data-deleted <YYYY-MM-DD>');
    const inventory = await ws.readInventory();
    expect(inventory.instances.find((i) => i.id === 'demo-02')?.status).toBe('retired');

    io = instanceIO(env());
    expect(await main(['update', 'demo-02', '--data-deleted', '2026-10-15'], io, testDeps())).toBe(
      0,
    );
    io = instanceIO(env());
    expect(await main(['list'], io, testDeps())).toBe(0);
    expect(io.stdout.join('\n')).toContain('(baja 2026-09-30, datos borrados 2026-10-15)');

    const neu = instanceIO(env(), { tty: true });
    const args = ['new', '--id', 'demo-02', '--client', 'X', '--url', 'https://otra.ejemplo.com'];
    const rest = ['--timezone', 'Europe/Madrid', '--region', 'ES', '--currency', 'EUR'];
    const phone = ['--emergency-phone', '+34600111222'];
    expect(await main([...args, ...rest, ...phone], neu, testDeps())).toBe(1);
    expect(neu.stderr.join('\n')).toContain(
      'Ya hay una instancia demo-02 en el inventario (dada de baja)',
    );

    const reuse = await writeEnv(
      'reusa.env',
      productionEnv('demo-09', { SESSION_SECRET: used[1]?.SESSION_SECRET ?? '' }),
    );
    io = instanceIO(env());
    expect(await main(['check', reuse, '--json'], io, testDeps())).toBe(1);
    const result = JSON.parse(io.stdout[0] ?? '{}') as CheckResult;
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'duplicate_secret', otherInstance: 'demo-02' }),
    );
  });

  it('retire con --yes sin terminal', async () => {
    const io = instanceIO(env());
    expect(await main(['retire', 'demo-01', '--yes'], io, testDeps())).toBe(0);
  });

  it('sync tras rotar SESSION_SECRET: la huella anterior sigue contando', async () => {
    const old = used[0]?.SESSION_SECRET ?? '';
    const rotated = await writeEnv('demo-01.env', {
      ...(used[0] ?? {}),
      SESSION_SECRET: `${'e'.repeat(8)}${'0123456789abcdef'.repeat(3)}f1e2d3c4`,
    });
    let io = instanceIO(env());
    expect(await main(['sync', 'demo-01', rotated], io, testDeps())).toBe(0);
    expect(io.stdout[0]).toContain('Cambian: SESSION_SECRET.');

    const reuse = await writeEnv('viejo.env', productionEnv('demo-09', { SESSION_SECRET: old }));
    io = instanceIO(env());
    expect(await main(['check', reuse, '--json'], io, testDeps())).toBe(1);
    const result = JSON.parse(io.stdout[0] ?? '{}') as CheckResult;
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'duplicate_secret',
        variable: 'SESSION_SECRET',
        otherInstance: 'demo-01',
        otherCurrent: false,
      }),
    );
    await expectNoSecretsInInventory();
  });
});
