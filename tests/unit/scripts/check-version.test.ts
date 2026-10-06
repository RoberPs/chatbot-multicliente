/**
 * `scripts/check-version.mjs` (009, R4): la imagen no se construye con un CORE_VERSION distinto
 * de la versión de package.json.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

async function check(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, ['scripts/check-version.mjs', ...args]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe('scripts/check-version.mjs', () => {
  it('igual a package.json → 0', async () => {
    const result = await check(pkg.version);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(pkg.version);
  });

  it.each([
    ['vacío', ['']],
    ['sin argumento', []],
    ['no semántico', ['latest']],
    ['con v', [`v${pkg.version}`]],
    ['distinto', ['99.0.0']],
  ])('%s → código ≠ 0 y mensaje en español', async (_name, args) => {
    const result = await check(...args);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/CORE_VERSION/);
    expect(result.stderr).toMatch(/versión|package\.json/);
  });
});
