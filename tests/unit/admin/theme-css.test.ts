/**
 * Contrato del tema en `app.css` (014, contracts/panel-theme-css.md): un solo sitio con los
 * colores y bloques de mapeo que eligen la paleta activa. El test lee la hoja como texto porque es
 * lo que se sirve: no hay proceso de construcción de CSS que pudiera reescribirla.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Hex } from '../../../src/webchat/design/defaults.js';
import {
  contrastRatio,
  MIN_TEXT_CONTRAST,
  MIN_UI_CONTRAST,
} from '../../../src/webchat/design/contrast.js';

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

/** La paleta clara es copia literal de los colores que el panel usaba antes de la 014 (FR-005). */
const LIGHT_BEFORE_014: Record<string, string> = {
  bg: '#f6f7f9',
  card: '#ffffff',
  field: '#ffffff',
  fg: '#1d2330',
  muted: '#5f6878',
  line: '#d9dde4',
  'control-line': '#d9dde4',
  accent: '#1f5fbf',
  'on-accent': '#ffffff',
  ok: '#1f7a4a',
  warn: '#9a6200',
  danger: '#b3261e',
  'flash-bg': '#e8f5ec',
  'flash-line': '#b7dcc4',
  'error-bg': '#fdecea',
  'error-line': '#f1b7b2',
};

/**
 * Parejas con contraste exigido en oscuro (data-model §2.4): 4,5 para texto y 3 para bordes y
 * foco, los mismos mínimos que ya se exigen al diseño del chat (FR-014, FR-015).
 */
const DARK_PAIRS: Array<[string, string, number]> = [
  ['fg', 'bg', MIN_TEXT_CONTRAST],
  ['fg', 'card', MIN_TEXT_CONTRAST],
  ['fg', 'field', MIN_TEXT_CONTRAST],
  ['muted', 'bg', MIN_TEXT_CONTRAST],
  ['muted', 'card', MIN_TEXT_CONTRAST],
  ['accent', 'bg', MIN_TEXT_CONTRAST],
  ['accent', 'card', MIN_TEXT_CONTRAST],
  ['accent', 'field', MIN_TEXT_CONTRAST],
  ['on-accent', 'accent', MIN_TEXT_CONTRAST],
  ['ok', 'bg', MIN_TEXT_CONTRAST],
  ['ok', 'card', MIN_TEXT_CONTRAST],
  ['warn', 'bg', MIN_TEXT_CONTRAST],
  ['warn', 'card', MIN_TEXT_CONTRAST],
  ['danger', 'bg', MIN_TEXT_CONTRAST],
  ['danger', 'card', MIN_TEXT_CONTRAST],
  ['ok', 'flash-bg', MIN_TEXT_CONTRAST],
  ['danger', 'error-bg', MIN_TEXT_CONTRAST],
  ['fg', 'flash-bg', MIN_TEXT_CONTRAST],
  ['fg', 'error-bg', MIN_TEXT_CONTRAST],
  ['control-line', 'field', MIN_UI_CONTRAST],
  ['control-line', 'bg', MIN_UI_CONTRAST],
  ['control-line', 'card', MIN_UI_CONTRAST],
  ['accent', 'bg', MIN_UI_CONTRAST],
  ['flash-line', 'bg', MIN_UI_CONTRAST],
  ['error-line', 'bg', MIN_UI_CONTRAST],
];

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

/** Colores de una paleta, por su nombre corto: `palette('dark').fg`. */
function palette(variant: 'light' | 'dark'): Record<string, Hex> {
  const colors: Record<string, Hex> = {};
  for (const match of code.matchAll(/--c-(light|dark)-([a-z-]+):\s*(#[0-9a-fA-F]{6});/g)) {
    if (match[1] === variant && match[2] && match[3]) colors[match[2]] = match[3];
  }
  return colors;
}

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
        expect(declaration.value, `${declaration.name} en el mapeo «${block.selector}»`).toBe(
          `${prefix}${declaration.name.slice(2)})`,
        );
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

  it('las dos paletas tienen los mismos 16 colores', () => {
    const light = Object.keys(palette('light')).sort();
    const dark = Object.keys(palette('dark')).sort();
    expect(light).toEqual(WORKING_TOKENS.map((t) => t.slice(2)).sort());
    expect(dark).toEqual(light);
  });

  it('la paleta clara es la de antes de la feature (FR-005)', () => {
    expect(palette('light')).toEqual(LIGHT_BEFORE_014);
  });

  it('la paleta oscura cumple el contraste de todas sus parejas (FR-014, FR-015)', () => {
    const dark = palette('dark');
    for (const [fg, bg, min] of DARK_PAIRS) {
      const first = dark[fg];
      const second = dark[bg];
      expect(first, `falta --c-dark-${fg}`).toBeDefined();
      expect(second, `falta --c-dark-${bg}`).toBeDefined();
      if (!first || !second) continue;
      const ratio = contrastRatio(first, second);
      expect(ratio, `${fg} sobre ${bg} (mínimo ${String(min)}:1)`).toBeGreaterThanOrEqual(min);
    }
  });

  it('el elemento enfocado por teclado se ve en los dos temas (FR-015)', () => {
    const focus = parseBlocks(code).find((block) => block.selector === ':focus-visible');
    expect(focus, 'falta la regla :focus-visible').toBeDefined();
    const rules = declarations(focus?.body ?? '');
    expect(rules.find((d) => d.name === 'outline')?.value).toBe('2px solid var(--accent)');
    expect(rules.find((d) => d.name === 'outline-offset')?.value).toBeDefined();
  });

  it('al imprimir siempre manda la paleta clara, también con el tema forzado (FR-021)', () => {
    const printAt = code.indexOf('@media print');
    expect(printAt, 'falta el bloque @media print').toBeGreaterThan(-1);
    const printBlock = parseBlocks(code).find(
      (block) => block.body.includes('color-scheme: light') && block.selector.includes('@media'),
    );
    expect(printBlock?.selector, 'el bloque de impresión no es un @media').toContain('print');
    // Igual especificidad que los mapeos oscuros y después de ellos: manda por orden.
    const forced = code.indexOf(":root[data-theme='dark']");
    expect(printAt).toBeGreaterThan(forced);
    const inside = code.slice(printAt);
    expect(inside).toContain(":root[data-theme='dark']");
  });
});
