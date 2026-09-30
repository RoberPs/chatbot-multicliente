/**
 * Rutas del repositorio del núcleo (007, research R6 y R7): el inventario nunca puede estar
 * dentro del repositorio, y un entorno generado solo si `git` lo excluye del control de versiones.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | null = null;

/** Raíz del núcleo: el primer directorio con `package.json` subiendo desde este módulo. */
export function coreRoot(): string {
  if (cachedRoot !== null) return cachedRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('No se encuentra la raíz del núcleo');
    dir = parent;
  }
}

/** Plantilla del entorno de una instancia. */
export function templatePath(root = coreRoot()): string {
  return join(root, '.env.example');
}

/** Ruta real: resuelve enlaces del tramo que ya existe y añade el resto tal cual. */
function realPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    rest.unshift(basename(existing));
    existing = parent;
  }
  try {
    return join(realpathSync.native(existing), ...rest);
  } catch {
    return absolute;
  }
}

/** `true` si `path` está dentro de `root` (con `..` y enlaces resueltos). */
export function isInsideCoreRepo(path: string, root = coreRoot()): boolean {
  const target = realPath(path);
  const base = realPath(root);
  const rel =
    process.platform === 'win32'
      ? relative(base.toLowerCase(), target.toLowerCase())
      : relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * `true` si `git check-ignore` dice que la ruta está excluida del control de versiones. Sin
 * `git` (o con cualquier error) se considera no excluida: la ruta se rechaza.
 */
export function isGitIgnored(
  path: string,
  options: { root?: string; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const result = spawnSync('git', ['check-ignore', '-q', resolve(path)], {
    cwd: options.root ?? coreRoot(),
    env: options.env ?? process.env,
    stdio: 'ignore',
    windowsHide: true,
  });
  return result.error === undefined && result.status === 0;
}
