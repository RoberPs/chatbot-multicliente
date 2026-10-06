import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/instance.js';
import { parseEnvText } from '../../../src/provisioning/env-file.js';
import { ProvisioningError } from '../../../src/provisioning/messages.js';
import {
  instanceIO,
  sampleInventory,
  TEST_INVENTORY_KEY_HEX,
  testDeps,
  workspace,
  type TestInstanceIO,
  type Workspace,
} from '../../helpers/provisioning.js';

let ws: Workspace;
beforeEach(async () => {
  ws = await workspace();
});
afterEach(async () => {
  await ws.remove();
});

const ARGS = [
  'new',
  '--id',
  'demo-09',
  '--client',
  'Cliente nuevo',
  '--url',
  'https://demo-09.ejemplo.com',
  '--timezone',
  'Europe/Madrid',
  '--region',
  'ES',
  '--currency',
  'EUR',
  '--emergency-phone',
  '+34 600 111 222',
];

const env = (extra: Record<string, string | undefined> = {}) => ({
  INSTANCE_INVENTORY: ws.inventoryPath,
  INSTANCE_INVENTORY_KEY: TEST_INVENTORY_KEY_HEX,
  ...extra,
});

/** Líneas `    <valor>` (las únicas en las que se muestra un secreto). */
const shownSecrets = (io: TestInstanceIO) =>
  io.stdout.filter((l) => /^ {4}\S+$/.test(l)).map((l) => l.trim());

async function withInventory() {
  const sample = sampleInventory(2);
  await ws.writeInventory(sample.inventory);
  return sample;
}

describe('pnpm instance:new (US2)', () => {
  it('alta correcta: entorno, inventario "en alta" y contraseña mostrada una sola vez', async () => {
    await withInventory();
    const io = instanceIO(env(), { tty: true });
    expect(await main(ARGS, io, testDeps())).toBe(0);

    const envPath = join(ws.envsDir, 'demo-09.env');
    const text = await readFile(envPath, 'utf8');
    const values = parseEnvText(text);
    expect(values).toMatchObject({
      NODE_ENV: 'production',
      INSTANCE_ID: 'demo-09',
      DATABASE_URL: '',
    });
    if (process.platform !== 'win32') expect((await stat(envPath)).mode & 0o777).toBe(0o600);

    const inventory = await ws.readInventory();
    expect(inventory.instances.find((i) => i.id === 'demo-09')).toMatchObject({
      status: 'provisioning',
      client: 'Cliente nuevo',
    });

    const [password] = shownSecrets(io);
    expect(password).toHaveLength(24);
    expect(io.stdout.filter((l) => l.includes(password ?? '-')).length).toBe(1);
    expect(text).not.toContain(password);
    expect(await ws.inventoryText()).not.toContain(password);
    expect(await ws.otherFilesText()).not.toContain(password);
    expect(await ws.inventoryText()).not.toContain(values.SESSION_SECRET);
    // 009: el entorno nace con su secreto de salud, que no se imprime ni va al inventario.
    expect(values.HEALTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(io.all()).not.toContain(values.HEALTH_SECRET);
    expect(await ws.inventoryText()).not.toContain(values.HEALTH_SECRET);
    expect(
      inventory.instances
        .find((i) => i.id === 'demo-09')
        ?.fingerprints.some((f) => f.variable === 'HEALTH_SECRET'),
    ).toBe(true);

    const out = io.stdout.join('\n');
    expect(out).toContain('Instancia demo-09 dada de alta en el inventario (estado: en alta).');
    expect(out).toContain('  2. Crea la base de datos: pnpm instance:db demo-09\n');
    expect(out).toContain(`  4. Valida: pnpm instance:check ${envPath}`);
    expect(out).toContain('pnpm instance:update demo-09 --backup-key-location "<dónde>"');
  });

  it('con --out, el paso de instance:db lleva --env <fichero>', async () => {
    await withInventory();
    const target = join(ws.dir, 'otro-sitio', 'demo-09.env');
    const io = instanceIO(env(), { tty: true });
    expect(await main([...ARGS, '--out', target], io, testDeps())).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(io.stdout.join('\n')).toContain(`pnpm instance:db demo-09 --env ${target}`);
  });

  it('sin inventario ni clave: se pregunta y solo con «crear» se crea; la clave se muestra una vez', async () => {
    const io = instanceIO(env({ INSTANCE_INVENTORY_KEY: undefined }), {
      tty: true,
      answers: ['crear'],
    });
    expect(await main(ARGS, io, testDeps())).toBe(0);
    expect(io.questions.some((q) => q.includes('Para crear uno nuevo escribe «crear»'))).toBe(true);
    const [key, password] = shownSecrets(io);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(password).toHaveLength(24);
    expect(await ws.inventoryText()).not.toContain(key);
    expect(existsSync(join(ws.envsDir, 'demo-09.env'))).toBe(true);
  });

  it('sin inventario, con otra respuesta no se escribe nada', async () => {
    const io = instanceIO(env({ INSTANCE_INVENTORY_KEY: undefined }), {
      tty: true,
      answers: ['no'],
    });
    expect(await main(ARGS, io, testDeps())).toBe(1);
    expect(existsSync(ws.inventoryPath)).toBe(false);
    expect(await readdir(ws.envsDir)).toEqual([]);
  });

  it('sin inventario con INSTANCE_INVENTORY_KEY definida: la pregunta avisa de otra ruta', async () => {
    const io = instanceIO(env(), { tty: true, answers: ['crear'] });
    expect(await main(ARGS, io, testDeps())).toBe(0);
    expect(
      io.questions.some((q) => q.includes('parece que ya existe un inventario en otra ruta')),
    ).toBe(true);
    expect(shownSecrets(io)).toHaveLength(1); // solo la contraseña: la clave ya la tiene el operador
  });

  it('salida no interactiva → not_interactive antes de generar nada', async () => {
    await withInventory();
    const before = await ws.inventoryText();
    const io = instanceIO(env(), { tty: false });
    expect(await main(ARGS, io, testDeps())).toBe(2);
    expect(io.stderr.join('\n')).toContain('necesita una terminal');
    expect(await readdir(ws.envsDir)).toEqual([]);
    expect(await ws.inventoryText()).toBe(before);
  });

  it('output_exists: no toca el fichero existente ni el inventario', async () => {
    await withInventory();
    const path = join(ws.envsDir, 'demo-09.env');
    await writeFile(path, 'ORIGINAL=1\n');
    const before = await ws.inventoryText();
    const io = instanceIO(env(), { tty: true });
    expect(await main(ARGS, io, testDeps())).toBe(1);
    expect(io.stderr.join('\n')).toContain(`Ya existe ${path}`);
    expect(await readFile(path, 'utf8')).toBe('ORIGINAL=1\n');
    expect(await ws.inventoryText()).toBe(before);
  });

  it('--out dentro de un repositorio git: rechazada si no está ignorada, aceptada si lo está', async () => {
    await withInventory();
    const repo = await mkdtemp(join(tmpdir(), 'repo-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo });
      await writeFile(join(repo, '.gitignore'), 'secretos/\n');
      const deps = testDeps({ repoRoot: repo });

      const bad = instanceIO(env(), { tty: true });
      expect(await main([...ARGS, '--out', join(repo, 'demo-09.env')], bad, deps)).toBe(1);
      expect(bad.stderr.join('\n')).toContain('no está excluida del control de versiones');
      expect(existsSync(join(repo, 'demo-09.env'))).toBe(false);

      const good = instanceIO(env(), { tty: true });
      expect(
        await main([...ARGS, '--out', join(repo, 'secretos', 'demo-09.env')], good, deps),
      ).toBe(0);
      expect(existsSync(join(repo, 'secretos', 'demo-09.env'))).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('los datos que faltan se preguntan en la terminal', async () => {
    await withInventory();
    const partial = ARGS.filter(
      (a, i) =>
        !['--client', 'Cliente nuevo', '--url', 'https://demo-09.ejemplo.com'].includes(a) ||
        i === 0,
    );
    const io = instanceIO(env(), {
      tty: true,
      answers: ['Cliente preguntado', 'https://demo-09.ejemplo.com'],
    });
    expect(await main(partial, io, testDeps())).toBe(0);
    expect(io.questions[0]).toContain('--client');
    expect(io.questions[1]).toContain('--url');
    const inventory = await ws.readInventory();
    expect(inventory.instances.find((i) => i.id === 'demo-09')?.client).toBe('Cliente preguntado');
  });

  it('fallo al escribir el inventario → se borra el entorno recién creado y se informa', async () => {
    await withInventory();
    const before = await ws.inventoryText();
    const io = instanceIO(env(), { tty: true });
    const deps = testDeps({
      writeInventory: () => Promise.reject(new ProvisioningError('write_failed', { path: 'x' })),
    });
    expect(await main(ARGS, io, deps)).toBe(1);
    expect(io.stderr.join('\n')).toContain('se ha borrado');
    expect(await readdir(ws.envsDir)).toEqual([]);
    expect(await ws.inventoryText()).toBe(before);
    expect(shownSecrets(io)).toEqual([]);
  });

  it.each([
    ['duplicate_instance_id', ['--id', 'demo-01'], 'Ya hay una instancia demo-01'],
    [
      'duplicate_public_url',
      ['--url', 'https://demo-02.ejemplo.com'],
      'ya es la de la instancia demo-02',
    ],
    ['invalid_phone', ['--emergency-phone', '123'], '--emergency-phone'],
    ['invalid_timezone', ['--timezone', 'Marte/Olimpo'], '--timezone'],
    ['invalid_url', ['--url', 'http://demo-09.ejemplo.com'], '--url'],
  ])('rechazo %s: sin entorno ni cambios en el inventario', async (_code, override, text) => {
    await withInventory();
    const before = await ws.inventoryText();
    const args = [...ARGS];
    const index = args.indexOf(override[0] ?? '');
    args[index + 1] = override[1] ?? '';
    const io = instanceIO(env(), { tty: true });
    expect(await main(args, io, testDeps())).toBe(1);
    expect(io.stderr.join('\n')).toContain(text);
    expect(await readdir(ws.envsDir)).toEqual([]);
    expect(await ws.inventoryText()).toBe(before);
  });
});
