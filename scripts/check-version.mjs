// Comprueba en la construcción de la imagen que CORE_VERSION es la versión de package.json
// (009, research R4): así la etiqueta OCI de la imagen no puede declarar otra versión.
// Uso: node scripts/check-version.mjs "$CORE_VERSION"
import { readFileSync } from 'node:fs';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

const coreVersion = (process.argv[2] ?? '').trim();
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = typeof pkg.version === 'string' ? pkg.version : '';

if (coreVersion === '') {
  fail(
    `Falta CORE_VERSION: construye con --build-arg CORE_VERSION=${version || 'X.Y.Z'} (la versión de package.json). Nunca latest.`,
  );
}
if (!SEMVER.test(coreVersion)) {
  fail(`CORE_VERSION «${coreVersion}» no es una versión semántica X.Y.Z (sin «v» ni latest).`);
}
if (coreVersion !== version) {
  fail(
    `CORE_VERSION ${coreVersion} no coincide con la versión de package.json (${version}). Sube la versión en package.json o corrige el argumento.`,
  );
}
process.stdout.write(`Versión del núcleo comprobada: ${version}\n`);
