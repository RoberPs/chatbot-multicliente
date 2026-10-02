/**
 * Contraste WCAG 2.x del diseño del chat (011, research R4).
 *
 * Luminancia relativa en sRGB (umbral de linealización 0,04045) y razón de contraste comparada
 * **sin redondear** con el mínimo: 4,4999 no cumple 4,5. En los mensajes la razón se trunca a dos
 * decimales, nunca se redondea hacia arriba. Es la única implementación: la usan el guardado, la
 * importación, el aviso en vivo del panel y los colores derivados del tema.
 */
import type { ColorField, Hex } from './defaults.js';

/** Mínimo de todas las parejas que se exigen al guardar (FR-019). */
export const MIN_TEXT_CONTRAST = 4.5;
/** Mínimo de los elementos que no son texto, como el borde del campo (FR-019a). */
export const MIN_UI_CONTRAST = 3;

const channel = (hex: Hex, offset: number): number =>
  Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;

const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function relativeLuminance(hex: Hex): number {
  return (
    0.2126 * linear(channel(hex, 1)) +
    0.7152 * linear(channel(hex, 3)) +
    0.0722 * linear(channel(hex, 5))
  );
}

/** Razón de contraste entre dos colores, sin redondear (1 a 21). */
export function contrastRatio(a: Hex, b: Hex): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export const meets = (ratio: number, min: number): boolean => ratio >= min;

/** Razón truncada a dos decimales con coma decimal: 4,499 → "4,49". */
export function formatRatio(ratio: number): string {
  const truncated = Math.floor(ratio * 100 + 1e-9) / 100;
  return truncated.toFixed(2).replace('.', ',');
}

/** Mezcla en sRGB: `t = 0` es `fg` y `t = 1` es `bg`. */
export function mix(fg: Hex, bg: Hex, t: number): Hex {
  const out = [1, 3, 5].map((offset) => {
    const value = channel(fg, offset) * (1 - t) + channel(bg, offset) * t;
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  });
  return `#${out.join('')}`;
}

export interface ContrastPair {
  /** Texto o primer plano. */
  fg: ColorField;
  /** Fondo. */
  bg: ColorField;
  /** Cómo se nombra la pareja en los mensajes. */
  label: string;
}

/** Parejas que se exigen al guardar y al importar, todas a 4,5:1 (R4). */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { fg: 'onPrimaryColor', bg: 'primaryColor', label: 'El texto sobre el color principal' },
  { fg: 'textColor', bg: 'backgroundColor', label: 'El texto del chat sobre el fondo' },
  { fg: 'textColor', bg: 'botBubbleColor', label: 'El texto sobre los mensajes del bot' },
  { fg: 'primaryColor', bg: 'backgroundColor', label: 'El color principal frente al fondo del chat' },
  {
    fg: 'primaryColor',
    bg: 'botBubbleColor',
    label: 'El color principal frente a los mensajes del bot',
  },
];

export interface ContrastFailure {
  pair: ContrastPair;
  ratio: number;
  /** "… tiene un contraste de 3,21:1; el mínimo es 4,5:1". */
  message: string;
}

export const contrastMessage = (pair: ContrastPair, ratio: number): string =>
  `${pair.label} tiene un contraste de ${formatRatio(ratio)}:1; el mínimo es 4,5:1`;

/**
 * Parejas que no cumplen con estos colores. Una pareja con algún color ausente (mal escrito) no
 * se comprueba: ese color ya tiene su propio error.
 */
export function contrastFailures(colors: Partial<Record<ColorField, Hex>>): ContrastFailure[] {
  const failures: ContrastFailure[] = [];
  for (const pair of CONTRAST_PAIRS) {
    const fg = colors[pair.fg];
    const bg = colors[pair.bg];
    if (fg === undefined || bg === undefined) continue;
    const ratio = contrastRatio(fg, bg);
    if (!meets(ratio, MIN_TEXT_CONTRAST)) {
      failures.push({ pair, ratio, message: contrastMessage(pair, ratio) });
    }
  }
  return failures;
}
