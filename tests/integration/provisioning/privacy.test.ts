/**
 * SC-005: ninguna salida de las herramientas ni el inventario contienen un valor secreto de los
 * entornos usados, la clave del inventario, la URL de administración ni una DATABASE_URL. Las
 * únicas excepciones son la línea de la contraseña del operador en `new` y la de la clave al
 * crear el inventario.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { main } from '../../../src/cli/instance.js';
import { parseEnvText } from '../../../src/provisioning/env-file.js';
import {
  collectSecrets,
  instanceIO,
  productionEnv,
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

const NEW = (id: string) => [
  'new',
  '--id',
  id,
  '--client',
  `Cliente ${id}`,
  '--url',
  `https://${id}.ejemplo.com`,
  '--timezone',
  'Europe/Madrid',
  '--region',
  'ES',
  '--currency',
  'EUR',
  '--emergency-phone',
  '+34600111222',
];

describe('privacidad de todas las salidas (SC-005)', () => {
  it('0 coincidencias de secretos en salidas, inventario y ficheros nuevos', async () => {
    const outputs: TestInstanceIO[] = [];
    /** Líneas permitidas: las que muestran una vez la contraseña o la clave. */
    const allowed: string[] = [];
    const deps = testDeps();
    const adminUrl = inject('pgAdminUrl');
    let key = '';
    const env = (extra: Record<string, string | undefined> = {}) => ({
      INSTANCE_INVENTORY: ws.inventoryPath,
      INSTANCE_INVENTORY_KEY: key === '' ? undefined : key,
      INSTANCE_DB_ADMIN_URL: adminUrl,
      ...extra,
    });
    const run = async (args: string[], options: Parameters<typeof instanceIO>[1] = {}) => {
      const io = instanceIO(env(), options);
      outputs.push(io);
      return main(args, io, deps);
    };
    const suffix = Date.now().toString(36);
    const a = `pa-${suffix}`;
    const b = `pb-${suffix}`;

    // new creando el inventario: se muestran la clave y la contraseña (una vez cada una).
    expect(await run(NEW(a), { tty: true, answers: ['crear'] })).toBe(0);
    const shown = (outputs.at(-1)?.stdout ?? []).filter((l) => /^ {4}\S+$/.test(l));
    expect(shown).toHaveLength(2);
    allowed.push(...shown);
    key = shown[0]?.trim() ?? '';

    expect(await run(NEW(b), { tty: true })).toBe(0);
    allowed.push(...(outputs.at(-1)?.stdout ?? []).filter((l) => /^ {4}\S+$/.test(l)));
    const passwords = allowed.map((l) => l.trim()).filter((v) => v !== key);

    expect(await run(['db', a])).toBe(0);
    const envB = join(ws.envsDir, `${b}.env`);
    expect(await run(['db', b, '--print-sql', '--host', 'db.interna', '--port', '5432'])).toBe(0);

    const envA = join(ws.envsDir, `${a}.env`);
    for (const args of [
      ['check', envA],
      ['check', envA, '--json'],
      ['check', envB, '--json'],
    ]) {
      await run(args);
    }

    // Una instancia anterior registrada desde su entorno, con un secreto copiado de `a`.
    const valuesA = parseEnvText(await readFile(envA, 'utf8'));
    const external = productionEnv('px-anterior', { SESSION_SECRET: valuesA.SESSION_SECRET ?? '' });
    const externalPath = await ws.writeEnv('externo.env', external);
    expect(await run(['register', externalPath, '--client', 'Anterior'])).toBe(0);
    await run(['check', externalPath]);
    await writeFile(
      externalPath,
      `${await readFile(externalPath, 'utf8')}BACKUP_KEYS_PREVIOUS=${valuesA.BACKUP_KEY ?? ''}\n`,
    );
    expect(await run(['sync', 'px-anterior', externalPath])).toBe(0);
    expect(await run(['update', a, '--status', 'active', '--image', '0.1.0'])).toBe(0);
    const report = join(ws.dir, 'verificacion.json');
    await writeFile(
      report,
      JSON.stringify({ file: `${a}__0005_x__20260930T101500Z__manual.cbak`, restorable: true }),
    );
    expect(await run(['verified', a, report])).toBe(0);
    expect(await run(['list'])).toBe(0);
    expect(await run(['list', '--json'])).toBe(0);
    // 009: secreto de salud (rotación) y versiones del parque (sin servidores: no responden).
    expect(await run(['health-secret', a])).toBe(0);
    expect(await run(['health-secret', a, '--rotate'])).toBe(0);
    expect(await run(['health-secret', 'no-existe'])).toBe(2);
    await run(['versions', '--timeout', '1']);
    await run(['versions', '--timeout', '1', '--json']);
    expect(await run(['retire', 'px-anterior', '--yes'])).toBe(0);

    // Rechazos principales.
    expect(await run(NEW(a), { tty: true })).toBe(1);
    expect(await run(['db', a])).toBe(1);
    expect(await run(['verified', b, report])).toBe(1);
    const noKey = instanceIO(env({ INSTANCE_INVENTORY_KEY: undefined }));
    outputs.push(noKey);
    expect(await main(['check', envA, '--json'], noKey, deps)).toBe(1);
    const badAdmin = new URL(adminUrl);
    badAdmin.password = 'clave-de-administracion-equivocada';
    const wrongAdmin = instanceIO(env({ INSTANCE_DB_ADMIN_URL: badAdmin.toString() }));
    outputs.push(wrongAdmin);
    const c = `pc-${suffix}`;
    expect(await run(NEW(c), { tty: true })).toBe(0);
    allowed.push(...(outputs.at(-1)?.stdout ?? []).filter((l) => /^ {4}\S+$/.test(l)));
    passwords.push(
      ...allowed.map((l) => l.trim()).filter((v) => v !== key && !passwords.includes(v)),
    );
    expect(await main(['db', c], wrongAdmin, deps)).toBe(1);

    // Todo lo que hay que buscar.
    const envFiles = (await readdir(ws.envsDir)).map((n) => join(ws.envsDir, n));
    const envs = await Promise.all(
      envFiles.map(async (f) => parseEnvText(await readFile(f, 'utf8'))),
    );
    const secrets = [
      ...envs.flatMap(collectSecrets),
      ...envs.map((e) => e.DATABASE_URL ?? '').filter((u) => u !== ''),
      key,
      adminUrl,
      badAdmin.toString(),
      'clave-de-administracion-equivocada',
      ...passwords,
    ].filter((s) => s.length >= 8);
    const adminPassword = decodeURIComponent(new URL(adminUrl).password);
    if (adminPassword.length >= 8) secrets.push(adminPassword);

    const outputText = outputs
      .flatMap((io) => [...io.stdout, ...io.stderr, io.logger.text()])
      .filter((line) => !allowed.includes(line))
      .join('\n');
    const inventory = await ws.inventoryText();
    const others = await ws.otherFilesText();

    const leaks = (text: string) => secrets.filter((s) => text.includes(s)).length;
    expect(leaks(outputText)).toBe(0);
    expect(leaks(inventory)).toBe(0);
    expect(leaks(others)).toBe(0);
    // Cada línea permitida aparece una sola vez en todas las salidas.
    const all = outputs.flatMap((io) => io.stdout);
    for (const line of allowed) expect(all.filter((l) => l === line)).toHaveLength(1);
  });
});
