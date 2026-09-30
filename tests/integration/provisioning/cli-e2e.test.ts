/**
 * SC-003: un entorno generado y completado con los valores de terceros pasa la validación a la
 * primera, y el arranque del núcleo lo acepta ("apto" ⇒ "arranca").
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';
import { main } from '../../../src/cli/instance.js';
import { loadEnv } from '../../../src/config/env.js';
import type { CheckResult } from '../../../src/provisioning/check.js';
import { parseEnvText } from '../../../src/provisioning/env-file.js';
import {
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
  await ws.writeInventory(sampleInventory(2).inventory);
});
afterEach(async () => {
  await ws.remove();
});

describe('alta de extremo a extremo: new → db → completar → check (SC-003)', () => {
  it('apto a la primera y aceptado por loadEnv', async () => {
    const id = `e-${randomBytes(3).toString('hex')}`;
    const env = {
      INSTANCE_INVENTORY: ws.inventoryPath,
      INSTANCE_INVENTORY_KEY: TEST_INVENTORY_KEY_HEX,
      INSTANCE_DB_ADMIN_URL: inject('pgAdminUrl'),
    };
    const created = instanceIO(env, { tty: true });
    const args = [
      'new',
      '--id',
      id,
      '--client',
      'Cliente de extremo a extremo',
      '--url',
      `https://${id}.ejemplo.com`,
    ];
    const rest = [
      '--timezone',
      'Europe/Madrid',
      '--region',
      'ES',
      '--currency',
      'EUR',
      '--emergency-phone',
      '+34 600 111 222',
    ];
    expect(await main([...args, ...rest], created, testDeps())).toBe(0);

    expect(await main(['db', id], instanceIO(env), testDeps())).toBe(0);

    const envPath = join(ws.envsDir, `${id}.env`);
    const text = await readFile(envPath, 'utf8');
    const key = `sk-ant-${randomBytes(30).toString('base64url')}`;
    const completed = text.replace(
      /# PENDIENTE: [^\r\n]*\r?\nANTHROPIC_API_KEY=(\r?\n)/,
      (_m, eol: string) => `ANTHROPIC_API_KEY=${key}${eol}`,
    );
    expect(completed).not.toBe(text);
    await writeFile(envPath, completed);

    const check = instanceIO(env);
    expect(await main(['check', envPath, '--json'], check, testDeps())).toBe(0);
    const result = JSON.parse(check.stdout[0] ?? '{}') as CheckResult;
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => `${w.code}:${w.variable ?? '-'}`)).not.toContain(
      'pending_optional:ANTHROPIC_API_KEY',
    );

    const backupDir = await mkdtemp(join(tmpdir(), 'copias-'));
    try {
      const values = parseEnvText(await readFile(envPath, 'utf8'));
      const started = loadEnv({ ...values, BACKUP_DIR: backupDir });
      expect(started.backup?.instanceId).toBe(id);
      expect(started.NODE_ENV).toBe('production');
    } finally {
      await rm(backupDir, { recursive: true, force: true });
    }
  });
});
