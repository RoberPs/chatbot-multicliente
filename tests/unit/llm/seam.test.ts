/**
 * La costura del proveedor no tiene fugas (017, reglas C1 y C2, FR-006, FR-023, SC-008;
 * contracts/llm-provider.md §2).
 *
 * Prueba **estática**: recorre `src/`, excluye `src/llm/`, y falla si encuentra el nombre de una
 * variable de credencial de proveedor o un importe del SDK de un proveedor.
 *
 * Por qué una prueba y no una revisión: la fuga que esto impide no rompe nada el día que se
 * escribe. Un `ANTHROPIC_API_KEY` en el panel funciona perfectamente hasta que alguien despliega
 * una instancia con Gemini, y entonces el aviso de «falta la clave» nombra una variable que esa
 * instancia no usa. El coste de encontrarlo entonces es mucho mayor que el de no dejarlo entrar.
 *
 * Antes de la 017 el nombre de la variable de Anthropic estaba en 15 ficheros de `src/`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LLM_KEY_VARIABLES } from '../../../src/llm/provider.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../../../src');

/** La frontera: dentro de ella sí se nombra a los proveedores, y es su trabajo. */
const SEAM = join(SRC, 'llm');

/**
 * **La única excepción a C1, y está documentada en el propio fichero.** `src/config/env.ts` es la
 * frontera cuyo trabajo es declarar variables de entorno, y construir su esquema desde la tabla
 * metería una firma de índice en el tipo `Env`, debilitando el tipado de **todas** las demás
 * variables. Nadie **decide** ahí: el proveedor declarado dice cuál de las tres se usa, y el resto
 * del programa lee `llmApiKey` y `llmKeyVariable` sin saber de quién son.
 *
 * Que la excepción esté en esta lista, y solo esta, es lo que la mantiene siendo una excepción.
 */
const C1_EXCEPTIONS = ['config/env.ts'];

/** Importes que solo pueden aparecer dentro de la costura (C2). */
const PROVIDER_SDKS = ['@anthropic-ai/sdk', '@google/genai', 'openai'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (full.startsWith(SEAM)) return [];
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|eta)$/.test(full) ? [full] : [];
  });
}

interface Fichero {
  /** Ruta relativa a `src/`, con `/` siempre, para que el mensaje sea igual en toda máquina. */
  path: string;
  text: string;
}

const files: Fichero[] = walk(SRC).map((full) => ({
  path: relative(SRC, full).split(sep).join('/'),
  text: readFileSync(full, 'utf8'),
}));

/** Importes de un fichero, en cualquiera de sus formas. */
function importsOf(text: string): string[] {
  const from = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)];
  const bare = [...text.matchAll(/(?:^|[^.\w])(?:import|require)\s*\(?\s*['"]([^'"]+)['"]/g)];
  return [...from, ...bare].map((m) => m[1] ?? '');
}

describe('la costura del proveedor (reglas C1 y C2)', () => {
  it('hay ficheros que recorrer, y la costura queda fuera', () => {
    expect(files.length).toBeGreaterThan(30);
    expect(files.some((f) => f.path.startsWith('llm/'))).toBe(false);
  });

  // C1 · FR-006, SC-008.
  it('nadie fuera de src/llm/ nombra una variable de credencial de proveedor', () => {
    const leaks = files
      .filter((f) => !C1_EXCEPTIONS.includes(f.path))
      .filter((f) => LLM_KEY_VARIABLES.some((variable) => f.text.includes(variable)))
      .map((f) => f.path);
    expect(leaks).toEqual([]);
  });

  // C2 · FR-023. Un importe de SDK fuera de la costura es una fuga aunque no se use: arrastra el
  // tipo del proveedor a un módulo que no debería saber que existe.
  it('nadie fuera de src/llm/ importa el SDK de un proveedor', () => {
    const leaks = files
      .filter((f) =>
        importsOf(f.text).some((spec) =>
          PROVIDER_SDKS.some((sdk) => spec === sdk || spec.startsWith(`${sdk}/`)),
        ),
      )
      .map((f) => f.path);
    expect(leaks).toEqual([]);
  });

  // La excepción tiene que seguir siendo necesaria: si alguien quita esos nombres de `env.ts`, la
  // lista sobra y hay que borrarla, no dejarla envejecer como permiso para volver a meterlos.
  it('la excepción declarada sigue siendo necesaria, y ninguna sobra', () => {
    for (const path of C1_EXCEPTIONS) {
      const file = files.find((f) => f.path === path);
      expect(file, `la excepción ${path} ya no existe en src/`).toBeDefined();
      expect(
        LLM_KEY_VARIABLES.some((variable) => file?.text.includes(variable)),
        `la excepción ${path} ya no nombra ninguna credencial: quítala de la lista`,
      ).toBe(true);
    }
  });

  // Y la excepción es solo para C1: `env.ts` tampoco puede importar un SDK.
  it('la excepción de C1 no la es de C2', () => {
    for (const path of C1_EXCEPTIONS) {
      const file = files.find((f) => f.path === path);
      expect(importsOf(file?.text ?? '').filter((s) => PROVIDER_SDKS.includes(s))).toEqual([]);
    }
  });
});
