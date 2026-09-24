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
    expect(schema).not.toMatch(/tenant|client_id|customer_id/i);
  });
});
