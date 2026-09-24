/**
 * Principio I / FR-024: en `src/` no puede haber nombres de sectores ni de clientes.
 * Solo pueden aparecer en `tests/fixtures/`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', '..', 'src');
const FORBIDDEN = [
  /cl[ií]nica/i,
  /\bclinic/i,
  /peluquer/i,
  /\btaller/i,
  /inmobiliaria/i,
  /dentist/i,
  /\bsalon\b/i,
  /\bbarber/i,
  /\bmec[aá]nic/i,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('neutralidad sectorial del código', () => {
  it('ningún fichero de src/ contiene nombres de sector o cliente', () => {
    const hits: string[] = [];
    for (const file of files(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (FORBIDDEN.some((re) => re.test(line)))
          hits.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
