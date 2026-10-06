/**
 * Versión del núcleo (009, research R4): única fuente, el `version` de `package.json`, que viaja
 * en la imagen. Se lee una vez al arrancar; si no se puede leer o no es semántica, el arranque
 * falla: nunca se inventa una versión. Módulo sin dependencias de HTTP.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `MAYOR.MENOR.PARCHE` con sufijo prerelease opcional (`1.4.0-rc.1`). */
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** La misma forma dentro de un texto, sin trocear números más largos (`11.4.0.1` no cuenta). */
const SEMVER_INSIDE = /(?<![\d.])\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?![\d.])/;

/** Nombre del paquete del núcleo en `package.json`. */
const CORE_PACKAGE = 'chatbotasesor';

export function isSemanticVersion(text: string): boolean {
  return SEMVER.test(text);
}

/** Primera versión semántica dentro de un texto (`chatbot:1.4.0` → `1.4.0`), o `null`. */
export function extractSemanticVersion(text: string): string | null {
  return SEMVER_INSIDE.exec(text)?.[0] ?? null;
}

/** Error del arranque con texto propio y sin datos: se muestra tal cual (013). */
export class CoreVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreVersionError';
  }
}

function readPackage(path: string): { name?: unknown; version?: unknown } | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; version?: unknown };
  } catch {
    return null;
  }
}

/**
 * Sube directorios desde `startDir` hasta el primer `package.json` del núcleo y devuelve su
 * versión validada. Lanza un error claro si no lo encuentra o si la versión no es semántica.
 */
export function readCoreVersion(
  startDir: string = dirname(fileURLToPath(import.meta.url)),
): string {
  let dir = startDir;
  for (;;) {
    const pkg = readPackage(join(dir, 'package.json'));
    if (pkg?.name === CORE_PACKAGE) {
      const version = typeof pkg.version === 'string' ? pkg.version : '';
      if (!isSemanticVersion(version)) {
        throw new CoreVersionError(
          `La versión del núcleo en package.json no es una versión semántica (X.Y.Z): «${version}»`,
        );
      }
      return version;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new CoreVersionError(
        'No se encuentra el package.json del núcleo: no se puede saber su versión',
      );
    }
    dir = parent;
  }
}
