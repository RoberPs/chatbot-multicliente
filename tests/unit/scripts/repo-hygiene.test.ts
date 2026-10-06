/**
 * Claves privadas y certificados fuera del repositorio (013, FR-018): `.gitignore` los excluye y
 * ningún fichero rastreado coincide con sus patrones.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');
const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
const available = git(['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';

if (!available) {
  console.warn('repo-hygiene: git no está disponible o no es un repositorio; se salta la prueba.');
}

describe.skipIf(!available)('certificados y claves privadas', () => {
  it.each(['x.pem', 'x.key', 'x.p12', 'certs/x.pem'])('%s está ignorado', (path) => {
    // `--no-index`: comprueba la regla aunque el fichero no exista.
    expect(git(['check-ignore', '-q', '--no-index', path]).status).toBe(0);
  });

  it('ningún fichero rastreado es .pem, .key ni .p12', () => {
    const tracked = execFileSync('git', ['ls-files', '*.pem', '*.key', '*.p12'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(tracked.trim()).toBe('');
  });
});
