import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveInventoryPath } from '../../../src/provisioning/inventory.js';
import { ProvisioningError } from '../../../src/provisioning/messages.js';
import { coreRoot, isGitIgnored, isInsideCoreRepo } from '../../../src/provisioning/repo-paths.js';

let repo: string;
let outside: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'repo-'));
  outside = await mkdtemp(join(tmpdir(), 'fuera-'));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  await writeFile(join(repo, 'package.json'), '{}');
  await writeFile(join(repo, '.gitignore'), 'secretos/\n');
  await mkdir(join(repo, 'secretos'));
});
afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('rutas del repositorio (research R6, R7)', () => {
  it('isInsideCoreRepo detecta rutas dentro y fuera, también con ..', () => {
    expect(isInsideCoreRepo(join(repo, 'a.env'), repo)).toBe(true);
    expect(isInsideCoreRepo(join(repo, 'x', '..', 'b.env'), repo)).toBe(true);
    expect(isInsideCoreRepo(repo, repo)).toBe(true);
    expect(isInsideCoreRepo(join(outside, 'a.env'), repo)).toBe(false);
    expect(isInsideCoreRepo(join(repo, '..', 'otro', 'a.env'), repo)).toBe(false);
  });

  it('isGitIgnored: verdadero para una ruta en .gitignore y falso para una que no', () => {
    expect(isGitIgnored(join(repo, 'secretos', 'demo.env'), { root: repo })).toBe(true);
    expect(isGitIgnored(join(repo, 'demo.env'), { root: repo })).toBe(false);
  });

  it('sin git disponible → no se considera ignorada (se rechaza)', () => {
    expect(
      isGitIgnored(join(repo, 'secretos', 'demo.env'), {
        root: repo,
        env: { PATH: '', Path: '' },
      }),
    ).toBe(false);
  });

  it('un inventario dentro del repositorio del núcleo se rechaza aunque esté ignorado', () => {
    const path = join(coreRoot(), 'node_modules', 'inventory.json');
    let error: unknown;
    try {
      resolveInventoryPath(path, {});
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).code).toBe('inventory_in_repo');
  });
});
