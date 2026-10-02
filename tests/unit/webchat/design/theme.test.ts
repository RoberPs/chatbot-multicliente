/**
 * Tema del chat a partir del diseño (011, research R3–R5, data-model §2 y §4).
 */
import { describe, expect, it } from 'vitest';
import {
  ORIGINAL_DESIGN,
  originalResolved,
  type ChatDesignOptions,
  type ResolvedChatDesign,
} from '../../../../src/webchat/design/defaults.js';
import { contrastRatio, CONTRAST_PAIRS, meets } from '../../../../src/webchat/design/contrast.js';
import { computeTheme, CSS_TOKENS, designVersion } from '../../../../src/webchat/design/theme.js';

const BUSINESS = 'Negocio de prueba';

const design = (over: Partial<ChatDesignOptions> = {}): ResolvedChatDesign => ({
  saved: true,
  options: { ...ORIGINAL_DESIGN, ...over },
  images: {},
  unsupported: [],
});

describe('computeTheme', () => {
  it('con el aspecto original no hay tokens ni atributos (R3)', () => {
    for (const resolved of [originalResolved(), design()]) {
      const theme = computeTheme(resolved, BUSINESS);
      expect(theme.tokens).toEqual({});
      expect(theme.htmlAttrs).toEqual({});
      expect(theme.customPalette).toBe(false);
    }
  });

  it('cambiar solo el nombre no emite tokens', () => {
    const theme = computeTheme(design({ chatName: 'Atención al cliente' }), BUSINESS);
    expect(theme.tokens).toEqual({});
    expect(theme.htmlAttrs).toEqual({});
    expect(theme.texts.chatName).toBe('Atención al cliente');
  });

  it('cambiar un color emite los cinco colores base y data-palette', () => {
    const theme = computeTheme(design({ primaryColor: '#0b6e4f' }), BUSINESS);
    expect(theme.customPalette).toBe(true);
    expect(theme.tokens).toMatchObject({
      '--chat-accent': '#0b6e4f',
      '--chat-on-accent': '#ffffff',
      '--chat-bg': '#ffffff',
      '--chat-fg': '#1d2330',
      '--chat-bot-bg': '#ffffff',
    });
    expect(theme.htmlAttrs['data-palette']).toBeDefined();
  });

  it('cada forma da los radios de la tabla de R5; la redondeada es la original (sin tokens)', () => {
    expect(computeTheme(design({ shape: 'square' }), BUSINESS).tokens).toEqual({
      '--chat-radius-panel': '0',
      '--chat-radius-bubble': '0',
      '--chat-radius-control': '0',
      '--chat-radius-toggle': '0',
    });
    expect(computeTheme(design({ shape: 'soft' }), BUSINESS).tokens).toEqual({
      '--chat-radius-panel': '6px',
      '--chat-radius-bubble': '6px',
      '--chat-radius-control': '4px',
      '--chat-radius-toggle': '12px',
    });
    expect(computeTheme(design({ shape: 'round' }), BUSINESS).tokens).toEqual({});
  });

  it('textos con sus valores por defecto', () => {
    const theme = computeTheme(design(), BUSINESS);
    expect(theme.texts).toEqual({
      chatName: `Asistente de ${BUSINESS}`,
      unavailableTitle: 'Chat',
      welcomeText: null,
      placeholder: 'Escribe tu mensaje',
      sendLabel: 'Enviar',
    });
    const custom = computeTheme(
      design({ chatName: 'Recepción', welcomeText: 'Hola', placeholder: 'Pregunta', sendLabel: 'Ir' }),
      BUSINESS,
    );
    expect(custom.texts).toEqual({
      chatName: 'Recepción',
      unavailableTitle: 'Recepción',
      welcomeText: 'Hola',
      placeholder: 'Pregunta',
      sendLabel: 'Ir',
    });
  });

  it('los nombres de token pertenecen siempre a la lista cerrada', () => {
    const theme = computeTheme(
      design({ primaryColor: '#0b6e4f', backgroundColor: '#fdfdf5', shape: 'soft' }),
      BUSINESS,
    );
    for (const name of Object.keys(theme.tokens)) expect(CSS_TOKENS).toContain(name);
  });
});

describe('designVersion', () => {
  it('es estable y cambia con el diseño', () => {
    const a = designVersion(design({ primaryColor: '#0b6e4f' }));
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(designVersion(design({ primaryColor: '#0b6e4f' }))).toBe(a);
    expect(designVersion(design({ primaryColor: '#0b6e50' }))).not.toBe(a);
  });
});

describe('colores derivados (R4, FR-019a)', () => {
  /** Generador pseudoaleatorio con semilla fija: la prueba es reproducible. */
  function prng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  const hex = (r: number, g: number, b: number) =>
    `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

  it('toda paleta guardable produce derivados que cumplen 4,5:1 y 3:1', () => {
    const rand = prng(20261002);
    const channel = (lo: number, hi: number) => lo + rand() * (hi - lo);
    const color = (lo: number, hi: number) => hex(channel(lo, hi), channel(lo, hi), channel(lo, hi));
    let checked = 0;
    for (let i = 0; i < 5000; i++) {
      const dark = rand() < 0.3;
      const light: [number, number] = [150, 255];
      const deep: [number, number] = [0, 110];
      const options = {
        ...ORIGINAL_DESIGN,
        primaryColor: color(...(dark ? light : deep)),
        onPrimaryColor: color(...(dark ? deep : light)),
        backgroundColor: color(...(dark ? deep : light)),
        textColor: color(...(dark ? light : deep)),
        botBubbleColor: color(...(dark ? deep : light)),
      };
      const savable = CONTRAST_PAIRS.every((p) =>
        meets(contrastRatio(options[p.fg], options[p.bg]), 4.5),
      );
      if (!savable) continue;
      checked++;
      const theme = computeTheme(design(options), BUSINESS);
      const muted = theme.tokens['--chat-muted'];
      const border = theme.tokens['--chat-field-border'];
      const focus = theme.tokens['--chat-focus'];
      expect(muted).toBeDefined();
      expect(border).toBeDefined();
      expect(theme.tokens['--chat-line']).toBeDefined();
      expect(focus).toBe(options.textColor);
      if (!muted || !border || !focus) return;
      expect(contrastRatio(muted, options.backgroundColor)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(border, options.backgroundColor)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(focus, options.backgroundColor)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(focus, options.botBubbleColor)).toBeGreaterThanOrEqual(4.5);
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('la paleta original no emite derivados (R3)', () => {
    const theme = computeTheme(design(), BUSINESS);
    expect(theme.tokens['--chat-muted']).toBeUndefined();
    expect(theme.tokens['--chat-field-border']).toBeUndefined();
  });
});
