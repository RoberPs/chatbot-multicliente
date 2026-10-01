/** FR-022: el código solo abre la base de datos de su instancia (DATABASE_URL). */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', '..', 'src');
const ALLOWED_ARGS = new Set(['env.DATABASE_URL', 'databaseUrl']);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('aislamiento: conexiones a BD', () => {
  it('createDb solo se invoca con la DATABASE_URL de la instancia', () => {
    const calls: string[] = [];
    const bad: string[] = [];
    for (const file of files(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/createDb\(([^)]*)\)/g)) {
        const arg = (match[1] ?? '').trim();
        if (arg.startsWith('databaseUrl:')) continue; // la propia declaración de la función
        calls.push(`${relative(SRC, file)}: ${arg}`);
        if (!ALLOWED_ARGS.has(arg)) bad.push(`${relative(SRC, file)}: createDb(${arg})`);
        if (
          arg === 'databaseUrl' &&
          !text.includes('DATABASE_URL') &&
          !file.endsWith('migrate.ts')
        ) {
          bad.push(`${relative(SRC, file)}: databaseUrl no procede de DATABASE_URL`);
        }
      }
    }
    expect(calls.length).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it('no hay identificador de cliente en el esquema (una BD por instancia)', () => {
    const schema = readFileSync(join(SRC, 'db', 'schema.ts'), 'utf8');
    // `customer` (feature 002) es el cliente final que escribe por WhatsApp, no la instancia.
    expect(schema).not.toMatch(/tenant|client_id|instance_id|business_id/i);
  });
});

describe('aislamiento: herramientas de aprovisionamiento (007, FR-034)', () => {
  const imports = (file: string) =>
    [...readFileSync(file, 'utf8').matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map(
      (m) => m[1] ?? '',
    );
  const provisioning = files(join(SRC, 'provisioning'));

  it('src/provisioning no importa Fastify ni el dominio, los canales o el panel', () => {
    const forbidden = /fastify|\/(admin|channels|knowledge|conversation|webchat|handoff)\//;
    const bad = provisioning.flatMap((file) =>
      imports(file)
        .filter((spec) => forbidden.test(spec) || spec === 'fastify')
        .map((spec) => `${relative(SRC, file)}: ${spec}`),
    );
    expect(provisioning.length).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });

  it('solo database.ts importa pg', () => {
    const users = provisioning
      .filter((file) => imports(file).includes('pg'))
      .map((file) => relative(SRC, file).replaceAll('\\', '/'));
    expect(users).toEqual(['provisioning/database.ts']);
  });

  it('el arranque no importa src/provisioning', () => {
    for (const entry of ['server.ts', 'startup.ts', 'app.ts']) {
      const specs = imports(join(SRC, entry));
      expect(specs.some((s) => s.includes('provisioning'))).toBe(false);
    }
  });
});

describe('aislamiento: exportar e importar la configuración (008)', () => {
  const imports = (file: string) =>
    [...readFileSync(file, 'utf8').matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map(
      (m) => m[1] ?? '',
    );

  it('src/config-transfer no importa Fastify, el panel ni los canales', () => {
    const module = files(join(SRC, 'config-transfer'));
    const forbidden = /^fastify$|^@fastify\/|\/(admin|channels)\//;
    const bad = module.flatMap((file) =>
      imports(file)
        .filter((spec) => forbidden.test(spec))
        .map((spec) => `${relative(SRC, file)}: ${spec}`),
    );
    expect(module.length).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });

  it('@fastify/multipart solo se importa desde la ruta de importación del panel', () => {
    const users = files(SRC)
      .filter((file) => imports(file).includes('@fastify/multipart'))
      .map((file) => relative(SRC, file).replaceAll('\\', '/'));
    expect(users).toEqual(['admin/routes/config.ts']);
  });
});
