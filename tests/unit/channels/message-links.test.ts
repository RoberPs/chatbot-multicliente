/**
 * Enlaces pulsables en las respuestas del bot (004 FR-020a, research R15).
 *
 * Desde la 012 (FR-031, SC-008) la regla es una sola: `displayLinks`. El servidor la usa para
 * «Probar el bot» y el chat web la recibe inyectada en `links.js`; esta tabla y la batería de
 * enlaces se ejecutan contra los dos para que no se separen.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { splitLinks, type LinkPart } from '../../../src/admin/message-links.js';
import { injectLinkRule, LINK_RULE_MARKER } from '../../../src/channels/web/link-script.js';
import { displayLinks } from '../../../src/conversation/link-rule.js';
import { LINK_CASES } from '../../fixtures/links/battery.js';

const raw = readFileSync(
  fileURLToPath(new URL('../../../src/channels/web/assets/links.js', import.meta.url)),
  'utf8',
);
/** El fichero tal como se sirve: con la regla en lugar del marcador. */
const source = injectLinkRule(raw);

/** Ejecuta `links.js` como lo haría el navegador y devuelve su `ChatLinks.split`. */
function browserSplit(): (text: string) => LinkPart[] {
  const window: { ChatLinks?: { split: (text: string) => LinkPart[] } } = {};
  runInNewContext(source, { window, URL });
  if (!window.ChatLinks) throw new Error('links.js no define window.ChatLinks');
  const split = window.ChatLinks.split;
  // Los objetos vienen de otro contexto de `vm`: se copian para compararlos con `toEqual`.
  return (text) => JSON.parse(JSON.stringify(split(text))) as LinkPart[];
}

const MAP = 'https://maps.example.com/@40.41,-3.70,17z?q=Plaza+Mayor';
const link = (url: string): LinkPart => ({ text: url, href: url });

const CASES: Array<[string, string, LinkPart[]]> = [
  ['texto sin enlaces', 'Abrimos a las 10:00.', [{ text: 'Abrimos a las 10:00.' }]],
  ['texto vacío', '', []],
  [
    'enlace a mapa en medio del texto',
    `Estamos en Calle Mayor 1. Puede ver la ubicación aquí: ${MAP}\nLe esperamos.`,
    [
      { text: 'Estamos en Calle Mayor 1. Puede ver la ubicación aquí: ' },
      link(MAP),
      { text: '\nLe esperamos.' },
    ],
  ],
  ['enlace solo', MAP, [link(MAP)]],
  [
    'punto final fuera del enlace',
    'Mapa: https://maps.example.com/abc.',
    [{ text: 'Mapa: ' }, link('https://maps.example.com/abc'), { text: '.' }],
  ],
  [
    'coma y paréntesis de cierre fuera del enlace',
    '(ver https://maps.example.com/abc), gracias',
    [{ text: '(ver ' }, link('https://maps.example.com/abc'), { text: '), gracias' }],
  ],
  [
    'comillas latinas fuera del enlace',
    '«https://maps.example.com/abc»',
    [{ text: '«' }, link('https://maps.example.com/abc'), { text: '»' }],
  ],
  [
    'varios signos seguidos al final',
    '¿Es https://maps.example.com/abc?!',
    [{ text: '¿Es ' }, link('https://maps.example.com/abc'), { text: '?!' }],
  ],
  [
    'dos enlaces',
    'Uno https://a.example.com y otro https://b.example.com/x',
    [
      { text: 'Uno ' },
      link('https://a.example.com'),
      { text: ' y otro ' },
      link('https://b.example.com/x'),
    ],
  ],
  ['esquema en mayúsculas', 'HTTPS://maps.example.com/abc', [link('HTTPS://maps.example.com/abc')]],
  [
    'http:// no se enlaza',
    'Ver http://maps.example.com/abc',
    [{ text: 'Ver http://maps.example.com/abc' }],
  ],
  ['javascript: no se enlaza', 'javascript:alert(1)', [{ text: 'javascript:alert(1)' }]],
  [
    'data: no se enlaza',
    'data:text/html,<script>alert(1)</script>',
    [{ text: 'data:text/html,<script>alert(1)</script>' }],
  ],
  ['mailto: no se enlaza', 'mailto:hola@example.com', [{ text: 'mailto:hola@example.com' }]],
  ['dominio sin esquema no se enlaza', 'maps.example.com/abc', [{ text: 'maps.example.com/abc' }]],
  ['dominio sin punto no se enlaza', 'https://localhost/abc', [{ text: 'https://localhost/abc' }]],
  [
    'usuario y contraseña en el enlace no se enlaza',
    'https://usuario:clave@maps.example.com/abc',
    [{ text: 'https://usuario:clave@maps.example.com/abc' }],
  ],
  ['esquema sin dominio no se enlaza', 'https://', [{ text: 'https://' }]],
  [
    'las comillas y los signos < > cortan el enlace',
    'https://maps.example.com/a"onmouseover="x',
    [link('https://maps.example.com/a'), { text: '"onmouseover="x' }],
  ],
];

describe.each([
  ['servidor (message-links.ts)', () => splitLinks],
  ['navegador (links.js)', browserSplit],
])('enlaces de las respuestas del bot: %s', (_name, make) => {
  const split = make();

  it.each(CASES)('%s', (_case, text, expected) => {
    expect(split(text)).toEqual(expected);
  });

  it.each(CASES)('%s: los trozos unidos son el texto original', (_case, text) => {
    expect(
      split(text)
        .map((p) => p.text)
        .join(''),
    ).toBe(text);
  });
});

describe('una sola regla de enlaces (012, SC-008)', () => {
  const browser = browserSplit();
  const hrefs = (parts: LinkPart[]) => parts.flatMap((p) => (p.href ? [p.href] : []));

  it('links.js se sirve con la regla inyectada (sin el marcador)', () => {
    expect(raw).toContain(LINK_RULE_MARKER);
    expect(source).not.toContain(LINK_RULE_MARKER);
  });

  it.each(LINK_CASES.map((c) => [c.name, c.text] as const))(
    '%s: servidor y navegador pintan exactamente displayLinks',
    (_name, text) => {
      const expected = displayLinks(text).map((m) => m.url);
      expect(hrefs(splitLinks(text))).toEqual(expected);
      expect(hrefs(browser(text))).toEqual(expected);
    },
  );

  it('sin la regla inyectada, links.js no pinta ningún enlace', () => {
    const window: { ChatLinks?: { split: (text: string) => LinkPart[] } } = {};
    runInNewContext(raw, { window, URL });
    const parts = JSON.parse(
      JSON.stringify(window.ChatLinks?.split('mira https://a.es')),
    ) as LinkPart[];
    expect(parts).toEqual([{ text: 'mira https://a.es' }]);
  });
});
