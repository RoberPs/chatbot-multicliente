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

describe('franja de derivación del iframe (005, FR-013a, R15)', () => {
  const frame = readFileSync(`${assetsDir}/frame.js`, 'utf8');
  const view = readFileSync(
    fileURLToPath(new URL('../../../src/channels/web/views/frame.eta', import.meta.url)),
    'utf8',
  );

  it('la franja es un aviso de la interfaz con role="status", no una burbuja', () => {
    expect(view).toMatch(/<p id="chat-handoff" class="handoff" role="status" hidden><\/p>/);
    expect(view.indexOf('chat-handoff')).toBeLessThan(view.indexOf('chat-messages'));
  });

  it('pinta handoff.notice con textContent', () => {
    expect(frame).toContain('handoffBar.textContent = active ? String(handoff.notice');
  });

  it('oculta "escribiendo" mientras está visible y sondea cada 60 s', () => {
    expect(frame).toContain('var HANDOFF_POLL_MS = 60000;');
    expect(frame).toContain('window.setInterval(pollHandoff, HANDOFF_POLL_MS)');
    expect(frame).toMatch(/function startPolling\(\) \{\s*if \(state\.handoffActive\) return;/);
    expect(frame).toContain("if (!state.handoffActive) setStatus('escribiendo…');");
    expect(frame).toContain('data.waiting && !state.handoffActive');
  });
});
