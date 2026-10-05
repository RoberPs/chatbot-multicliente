/**
 * Hoja `/chat/design.css` (011, research R2, data-model §4): solo propiedades personalizadas de
 * la lista cerrada con valores de tablas o colores validados; nunca texto del operador.
 */
import { describe, expect, it } from 'vitest';
import { renderDesignCss } from '../../../../src/webchat/design/css.js';
import {
  ORIGINAL_DESIGN,
  type ChatDesignOptions,
  type ResolvedChatDesign,
} from '../../../../src/webchat/design/defaults.js';
import { computeTheme, CSS_TOKENS } from '../../../../src/webchat/design/theme.js';

const design = (over: Partial<ChatDesignOptions> = {}): ResolvedChatDesign => ({
  saved: true,
  options: { ...ORIGINAL_DESIGN, ...over },
  images: {},
  unsupported: [],
});

const css = (over: Partial<ChatDesignOptions> = {}) =>
  renderDesignCss(computeTheme(design(over), 'Negocio'));

const VALUE =
  /^(#[0-9a-f]{6}|0|\d+px|50%|url\(\/chat\/design\/avatar\/[0-9a-f]{16}\.(png|jpg|webp)\))$/;

describe('renderDesignCss', () => {
  it('sin tokens, cadena vacía', () => {
    expect(css()).toBe('');
    expect(css({ chatName: 'Solo el nombre' })).toBe('');
  });

  it('con tokens, un único bloque :root solo con propiedades de la lista cerrada', () => {
    const out = css({ primaryColor: '#0b6e4f', botBubbleColor: '#eef6f2', shape: 'soft' });
    expect(out.match(/\{/g)).toHaveLength(1);
    expect(out.startsWith(':root {')).toBe(true);
    expect(out.trim().endsWith('}')).toBe(true);
    const body = out.slice(out.indexOf('{') + 1, out.lastIndexOf('}'));
    const declarations = body
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean);
    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) {
      const [name = '', value = ''] = declaration.split(':').map((s) => s.trim());
      expect(CSS_TOKENS).toContain(name);
      expect(value).toMatch(VALUE);
    }
  });

  it('un texto del operador nunca aparece en la hoja', () => {
    const evil = '}</style><script>alert(1)</script>; url(https://ajeno.example/x)';
    const out = css({
      primaryColor: '#0b6e4f',
      chatName: evil.slice(0, 40),
      welcomeText: evil,
      placeholder: evil,
      sendLabel: '};url(',
    });
    expect(out).not.toContain('</style>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('ajeno');
    expect(out).not.toMatch(/url\((?!\/chat\/design\/)/);
    expect(out.match(/\}/g)).toHaveLength(1);
  });
});
