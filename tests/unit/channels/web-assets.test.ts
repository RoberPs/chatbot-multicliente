/**
 * Garantía 9 del contrato del chat web (004): los scripts que se sirven al navegador del
 * visitante nunca construyen HTML a partir de texto. Todo lo que viene del visitante o del bot
 * se escribe con `textContent`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const assetsDir = fileURLToPath(new URL('../../../src/channels/web/assets', import.meta.url));

/** Formas de inyectar HTML o de evaluar texto como código. */
const PROHIBIDO = [
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'document.write',
  'eval',
  'Function(',
  'createContextualFragment',
];

describe('assets del chat web', () => {
  const files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));

  it('hay scripts que revisar', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s no construye HTML a partir de texto ni evalúa código', (file) => {
    const source = readFileSync(`${assetsDir}/${file}`, 'utf8');
    for (const forbidden of PROHIBIDO) {
      expect(source, `${file} usa ${forbidden}`).not.toContain(forbidden);
    }
  });
});
