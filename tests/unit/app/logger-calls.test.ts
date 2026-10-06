/**
 * Prueba estática de los registros (012, US8, FR-032; contracts/logging-and-startup.md): en
 * `src/` ningún logger recibe el texto o la pila de un error, ni un error fuera de la clave `err`
 * (que el serializador reduce a tipo y código).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../../../src');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** Argumentos de cada llamada `<algo>log<algo>.<nivel>(…)`, con su línea. */
function loggerCalls(source: string): Array<{ line: number; args: string }> {
  const calls: Array<{ line: number; args: string }> = [];
  const pattern = /\b\w*(?:log|logger|Log|Logger)\.(?:fatal|error|warn|info|debug|trace)\(/g;
  for (const match of source.matchAll(pattern)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    calls.push({
      line: source.slice(0, match.index).split('\n').length,
      args: source.slice(start, i - 1),
    });
  }
  return calls;
}

/** Lo que no puede llegar a un logger. */
function problem(args: string): string | null {
  if (/\.message\b/.test(args)) return 'pasa .message';
  if (/\.stack\b/.test(args)) return 'pasa .stack';
  // Un error solo como `err: <error>`; nunca suelto ni con otra clave.
  const withoutErrKey = args.replace(/\berr:\s*\w+/g, '');
  if (/(?:^|[{,(]\s*)(?:error|err|e)\s*(?:[,})]|$)/.test(withoutErrKey.trim())) {
    return 'pasa un error fuera de la clave err';
  }
  if (/\b(?:error|reason|cause):\s*(?:error|err|e)\b/.test(withoutErrKey)) {
    return 'pasa un error con otra clave';
  }
  return null;
}

describe('llamadas a los loggers de src/', () => {
  it('ninguna pasa el mensaje, la pila ni un error fuera de err', () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      for (const call of loggerCalls(readFileSync(file, 'utf8'))) {
        const found = problem(call.args);
        if (found) offenders.push(`${relative(SRC, file)}:${String(call.line)} ${found}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('la regla detecta los casos prohibidos', () => {
    expect(problem("{ err: error }, 'Error'")).toBeNull();
    expect(problem("{ errorClass: (error as Error).name }, 'x'")).toBeNull();
    expect(problem("{ detail: error.message }, 'x'")).toBe('pasa .message');
    expect(problem('error.stack')).toBe('pasa .stack');
    expect(problem("error, 'Fallo'")).toBe('pasa un error fuera de la clave err');
    expect(problem("{ error }, 'Fallo'")).toBe('pasa un error fuera de la clave err');
    expect(problem("{ cause: error }, 'x'")).toBe('pasa un error con otra clave');
  });
});
