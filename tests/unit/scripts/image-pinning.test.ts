/**
 * Imagen reproducible y gestor de paquetes con hash (013, FR-013–FR-017, research R6–R8,
 * contracts/image-and-repo.md): pruebas estáticas sobre los ficheros del repositorio.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (name: string) => readFileSync(join(root, name), 'utf8');

/** Instrucciones del Dockerfile, con las continuaciones `\` unidas. */
function instructions(): string[] {
  return read('Dockerfile')
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

const DIGEST = /@sha256:[0-9a-f]{64}$/;

describe('Dockerfile', () => {
  it('ARG NODE_IMAGE=node:22-slim@sha256:<64 hex> antes del primer FROM', () => {
    const lines = instructions();
    const firstFrom = lines.findIndex((l) => l.startsWith('FROM '));
    const arg = lines.findIndex((l) => /^ARG NODE_IMAGE=node:22-slim@sha256:[0-9a-f]{64}$/.test(l));
    expect(arg).toBeGreaterThanOrEqual(0);
    expect(arg).toBeLessThan(firstFrom);
  });

  it('cada FROM usa ${NODE_IMAGE} o una referencia nombre:etiqueta@sha256', () => {
    const froms = instructions().filter((l) => l.startsWith('FROM '));
    expect(froms.length).toBeGreaterThanOrEqual(2);
    for (const line of froms) {
      const image = line.split(/\s+/)[1] ?? '';
      const pinned =
        image === '${NODE_IMAGE}' || (/^[\w./-]+:[\w.-]+@/.test(image) && DIGEST.test(image));
      expect(pinned, line).toBe(true);
    }
  });

  it('exactamente un HEALTHCHECK con los parámetros del contrato y sin curl ni wget', () => {
    const checks = instructions().filter((l) => l.startsWith('HEALTHCHECK'));
    expect(checks).toHaveLength(1);
    const check = checks[0] ?? '';
    for (const option of ['--start-period=120s', '--interval=30s', '--timeout=5s', '--retries=3']) {
      expect(check).toContain(option);
    }
    expect(check).toMatch(/CMD \["node", "dist\/src\/cli\/healthcheck\.js"\]$/);
    expect(check).not.toMatch(/curl|wget/);
  });

  it('la etapa de construcción copia .npmrc', () => {
    const copies = instructions().filter(
      (l) => l.startsWith('COPY ') && l.includes('package.json'),
    );
    expect(copies.some((l) => l.split(/\s+/).includes('.npmrc'))).toBe(true);
  });
});

describe('pnpm', () => {
  const pkg = JSON.parse(read('package.json')) as {
    packageManager?: string;
    pnpm?: { onlyBuiltDependencies?: string[] };
  };

  it('packageManager con versión exacta y hash sha512', () => {
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
  });

  it('solo argon2 y esbuild ejecutan scripts de instalación', () => {
    expect(pkg.pnpm?.onlyBuiltDependencies).toEqual(['argon2', 'esbuild']);
  });

  it('.npmrc guarda versiones exactas', () => {
    expect(
      read('.npmrc')
        .split(/\r?\n/)
        .map((l) => l.trim()),
    ).toContain('save-exact=true');
  });
});
