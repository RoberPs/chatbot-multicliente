/**
 * Contrato del tema en `app.css` (014, contracts/panel-theme-css.md): un solo sitio con los
 * colores y bloques de mapeo que eligen la paleta activa. El test lee la hoja como texto porque es
 * lo que se sirve: no hay proceso de construcción de CSS que pudiera reescribirla.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS_PATH = new URL('../../../src/admin/views/app.css', import.meta.url);

/** Los 16 tokens de trabajo (data-model §2.1): los que usan las reglas de la hoja. */
const WORKING_TOKENS = [
  '--bg',
  '--card',
  '--field',
  '--fg',
  '--muted',
  '--line',
  '--control-line',
  '--accent',
  '--on-accent',
  '--ok',
  '--warn',
  '--danger',
  '--flash-bg',
  '--flash-line',
  '--error-bg',
  '--error-line',
] as const;

/** Tokens que no son de trabajo: las dos paletas y los tres colores fijos. */
const isPaletteToken = (name: string): boolean => /^--(c-light-|c-dark-|fixed-)/.test(name);

const css = readFileSync(CSS_PATH, 'utf8');
/** Sin comentarios: un color nombrado en un comentario no es un color de la hoja. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

interface Block {
  selector: string;
  body: string;
}

/** Bloques de la hoja con su selector; el cuerpo de un `@media` incluye sus bloques internos. */
function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const open: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '{') open.push(i);
    else if (source[i] === '}') {
      const start = open.pop();
      expect(start, `llave de cierre sin abrir en la posición ${String(i)}`).toBeDefined();
      if (start === undefined) break;
      const before = source.slice(0, start);
      const cut = Math.max(before.lastIndexOf('{'), before.lastIndexOf('}'));
      blocks.push({ selector: before.slice(cut + 1).trim(), body: source.slice(start + 1, i) });
    }
  }
  expect(open, 'hay llaves sin cerrar en app.css').toHaveLength(0);
  return blocks;
}

interface Declaration {
  name: string;
  value: string;
}

function declarations(body: string): Declaration[] {
  return body
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.includes(':'))
    .map((part) => {
      const at = part.indexOf(':');
      return { name: part.slice(0, at).trim(), value: part.slice(at + 1).trim() };
    });
}

/** Un bloque de mapeo declara `color-scheme` y no contiene bloques dentro. */
const mappingBlocks = parseBlocks(code).filter(
  (block) => block.body.includes('color-scheme:') && !block.body.includes('{'),
);

describe('El tema en app.css (014)', () => {
  it('hay al menos un mapeo claro y otro oscuro', () => {
    const schemes = mappingBlocks.map(
      (block) => declarations(block.body).find((d) => d.name === 'color-scheme')?.value,
    );
    expect(schemes).toContain('light');
    expect(schemes).toContain('dark');
  });

  it('todos los mapeos declaran exactamente los 16 tokens de trabajo (FR-018)', () => {
    expect(mappingBlocks.length).toBeGreaterThan(0);
    for (const block of mappingBlocks) {
      const declared = declarations(block.body)
        .map((d) => d.name)
        .filter((name) => name.startsWith('--') && !isPaletteToken(name));
      expect([...declared].sort(), `mapeo «${block.selector}»`).toEqual([...WORKING_TOKENS].sort());
    }
  });

  it('ningún mapeo contiene un color literal: cada token apunta a su paleta', () => {
    for (const block of mappingBlocks) {
      const scheme = declarations(block.body).find((d) => d.name === 'color-scheme')?.value;
      expect(scheme, `mapeo «${block.selector}» sin color-scheme`).toMatch(/^(light|dark)$/);
      const prefix = `var(--c-${String(scheme)}-`;
      for (const declaration of declarations(block.body)) {
        if (!declaration.name.startsWith('--') || isPaletteToken(declaration.name)) continue;
        expect(
          declaration.value,
          `${declaration.name} en el mapeo «${block.selector}»`,
        ).toBe(`${prefix}${declaration.name.slice(2)})`);
      }
    }
  });

  it('solo la paleta y los tres colores fijos tienen colores escritos a mano', () => {
    const offenders: string[] = [];
    for (const match of code.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g)) {
      const from = code.lastIndexOf('\n', match.index) + 1;
      const to = code.indexOf('\n', match.index);
      const line = code.slice(from, to === -1 ? undefined : to).trim();
      if (!/^--(c-light-|c-dark-|fixed-)[a-z-]+:/.test(line)) offenders.push(line);
    }
    expect(offenders).toEqual([]);
  });
});
