/**
 * `pnpm instance:health-secret <id> [--rotate] [--env <ruta>]` (009, contracts/
 * instance-versions-command.md, research R2): añade el secreto de salud a una instancia anterior
 * sin tocar el resto del entorno y sin mostrarlo; con `--rotate` lo cambia; `instance:sync` guarda
 * su huella y nunca el valor.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/instance.js';
import { parseEnvText } from '../../../src/provisioning/env-file.js';
import {
  envText,
  instanceIO,
  sampleInventory,
  TEST_INVENTORY_KEY_HEX,
  testDeps,
  workspace,
  type Workspace,
} from '../../helpers/provisioning.js';

let ws: Workspace;
beforeEach(async () => {
  ws = await workspace();
});
afterEach(async () => {
  await ws.remove();
});

const env = () => ({
  INSTANCE_INVENTORY: ws.inventoryPath,
  INSTANCE_INVENTORY_KEY: TEST_INVENTORY_KEY_HEX,
});

/** Inventario con demo-01 y su entorno sin HEALTH_SECRET (instancia anterior a la 009). */
async function legacy() {
  const sample = sampleInventory(2);
  await ws.writeInventory(sample.inventory);
  const { HEALTH_SECRET: _h, ...withoutSecret } = sample.envs[0] ?? {};
  const path = await ws.writeEnv('demo-01.env', withoutSecret);
  return { path, env: withoutSecret, sample };
}

async function run(args: string[], deps = testDeps()) {
  const io = instanceIO(env());
  const code = await main(['health-secret', ...args], io, deps);
  return { code, io, all: io.all() };
}

describe('instance:health-secret', () => {
  it('añade HEALTH_SECRET sin tocar el resto de líneas y sin imprimirlo', async () => {
    const { path } = await legacy();
    const before = await readFile(path, 'utf8');
    const { code, all } = await run(['demo-01']);
    expect(code).toBe(0);

    const after = await readFile(path, 'utf8');
    const secret = parseEnvText(after).HEALTH_SECRET ?? '';
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toBe(`HEALTH_SECRET=${secret}\n`);
    expect(all).not.toContain(secret);
    expect(all).toContain('pnpm instance:sync demo-01');
    const values = parseEnvText(after);
    expect(secret).not.toBe(values.SESSION_SECRET);
    expect(secret).not.toBe(values.BACKUP_KEY);
  });

  it('con secreto existente no cambia nada (código 0)', async () => {
    const { path } = await legacy();
    await run(['demo-01']);
    const first = await readFile(path, 'utf8');
    const { code, all } = await run(['demo-01']);
    expect(code).toBe(0);
    expect(all).toContain('Ya tiene secreto de salud');
    expect(await readFile(path, 'utf8')).toBe(first);
  });

  it('--rotate lo cambia en su misma línea', async () => {
    const { path } = await legacy();
    await run(['demo-01']);
    const first = parseEnvText(await readFile(path, 'utf8')).HEALTH_SECRET;
    const { code, all } = await run(['demo-01', '--rotate']);
    expect(code).toBe(0);
    const text = await readFile(path, 'utf8');
    const second = parseEnvText(text).HEALTH_SECRET ?? '';
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    expect(text.match(/^HEALTH_SECRET=/gm)?.length).toBe(1);
    expect(all).not.toContain(second);
  });

  it('--env <ruta> usa ese fichero', async () => {
    const { env: values } = await legacy();
    const other = join(ws.dir, 'otro.env');
    await writeFile(other, envText(values));
    expect((await run(['demo-01', '--env', other])).code).toBe(0);
    expect(parseEnvText(await readFile(other, 'utf8')).HEALTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
  });

  it('instancia desconocida o entorno ilegible → 2', async () => {
    await legacy();
    expect((await run(['no-existe'])).code).toBe(2);
    expect((await run(['demo-02'])).code).toBe(2);
    expect((await run(['demo-01', '--env', join(ws.dir, 'no-hay.env')])).code).toBe(2);
    expect((await run([])).code).toBe(2);
  });

  it('entorno dentro del repositorio sin ignorar → 2 (output_in_repo)', async () => {
    const { env: values } = await legacy();
    const repo = await mkdtemp(join(tmpdir(), 'repo-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo });
      const inside = join(repo, 'demo-01.env');
      await writeFile(inside, envText(values));
      const before = await readFile(inside, 'utf8');
      const { code, all } = await run(['demo-01', '--env', inside], testDeps({ repoRoot: repo }));
      expect(code).toBe(2);
      expect(all).toContain('no está excluida del control de versiones');
      expect(await readFile(inside, 'utf8')).toBe(before);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('tras instance:sync el inventario guarda la huella y no el valor', async () => {
    const { path } = await legacy();
    await run(['demo-01']);
    const secret = parseEnvText(await readFile(path, 'utf8')).HEALTH_SECRET ?? '';
    const io = instanceIO(env());
    expect(await main(['sync', 'demo-01', path], io, testDeps())).toBe(0);
    expect(io.stdout.join('\n')).toContain('HEALTH_SECRET');
    const inventory = await ws.readInventory();
    const instance = inventory.instances.find((i) => i.id === 'demo-01');
    expect(
      instance?.fingerprints.some((f) => f.variable === 'HEALTH_SECRET' && f.class === 'secret'),
    ).toBe(true);
    expect(await ws.inventoryText()).not.toContain(secret);
  });
});
