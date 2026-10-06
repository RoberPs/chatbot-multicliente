/**
 * Contraste WCAG 2.x del diseño (011, research R4).
 */
import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  CONTRAST_PAIRS,
  formatRatio,
  meets,
  mix,
  relativeLuminance,
} from '../../../../src/webchat/design/contrast.js';
import { ORIGINAL_DESIGN } from '../../../../src/webchat/design/defaults.js';

describe('contraste', () => {
  it('luminancia relativa en los extremos', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
  });

  it('negro sobre blanco es 21:1 y un color sobre sí mismo 1:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 10);
    expect(contrastRatio('#1f5fbf', '#1f5fbf')).toBe(1);
  });

  it('se compara sin redondear: 4,4999 no cumple 4,5', () => {
    expect(meets(4.4999, 4.5)).toBe(false);
    expect(meets(4.5, 4.5)).toBe(true);
    expect(meets(2.9999, 3)).toBe(false);
    expect(meets(3, 3)).toBe(true);
    // Grises reales a cada lado del mínimo sobre blanco.
    expect(meets(contrastRatio('#767676', '#ffffff'), 4.5)).toBe(true);
    expect(meets(contrastRatio('#777777', '#ffffff'), 4.5)).toBe(false);
  });

  it('formatRatio trunca a dos decimales con coma', () => {
    expect(formatRatio(4.499)).toBe('4,49');
    expect(formatRatio(4.4999)).toBe('4,49');
    expect(formatRatio(4.5)).toBe('4,50');
    expect(formatRatio(21)).toBe('21,00');
    expect(formatRatio(3.219)).toBe('3,21');
  });

  it('mix mezcla en sRGB', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('las cinco parejas de R4, y la paleta original cumple todas', () => {
    expect(CONTRAST_PAIRS.map((p) => [p.fg, p.bg])).toEqual([
      ['onPrimaryColor', 'primaryColor'],
      ['textColor', 'backgroundColor'],
      ['textColor', 'botBubbleColor'],
      ['primaryColor', 'backgroundColor'],
      ['primaryColor', 'botBubbleColor'],
    ]);
    for (const pair of CONTRAST_PAIRS) {
      const ratio = contrastRatio(ORIGINAL_DESIGN[pair.fg], ORIGINAL_DESIGN[pair.bg]);
      expect([pair.fg, pair.bg, meets(ratio, 4.5)]).toEqual([pair.fg, pair.bg, true]);
    }
  });
});
