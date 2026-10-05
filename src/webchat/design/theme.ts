/**
 * Tema del chat a partir del diseño (011, research R3–R5, data-model §2 y §4).
 *
 * Solo se emite lo que difiere del aspecto original (R3): con la paleta original no hay ningún
 * color, con la forma original ningún radio, y con la posición y el tamaño originales ningún
 * atributo. Así un diseño que solo cambia el nombre se ve como hoy salvo el nombre.
 */
import { createHash } from 'node:crypto';
import { contrastRatio, meets, MIN_TEXT_CONTRAST, MIN_UI_CONTRAST, mix } from './contrast.js';
import {
  COLOR_FIELDS,
  DEFAULT_PLACEHOLDER,
  DEFAULT_SEND_LABEL,
  defaultChatName,
  ORIGINAL_DESIGN,
  UNAVAILABLE_TITLE,
  type ChatDesignOptions,
  type ResolvedChatDesign,
  type Shape,
  type Size,
} from './defaults.js';

/** Propiedades personalizadas que puede llevar `/chat/design.css` (lista cerrada). */
export const CSS_TOKENS = [
  '--chat-accent',
  '--chat-on-accent',
  '--chat-bg',
  '--chat-fg',
  '--chat-bot-bg',
  '--chat-muted',
  '--chat-line',
  '--chat-field-border',
  '--chat-focus',
  '--chat-radius-panel',
  '--chat-radius-bubble',
  '--chat-radius-control',
  '--chat-radius-toggle',
  '--chat-avatar',
] as const;
export type CssToken = (typeof CSS_TOKENS)[number];

/** Radios por forma: panel, burbujas, botones y campo, botón flotante (R5). */
export const SHAPE_RADII: Record<
  Shape,
  { panel: string; bubble: string; control: string; toggle: string }
> = {
  square: { panel: '0', bubble: '0', control: '0', toggle: '0' },
  soft: { panel: '6px', bubble: '6px', control: '4px', toggle: '12px' },
  round: { panel: '12px', bubble: '10px', control: '8px', toggle: '50%' },
};

/** Tamaño del chat abierto (R5). El fragmento tiene su propia copia de esta tabla. */
export const SIZE_TABLE: Record<Size, { width: number; height: number }> = {
  small: { width: 320, height: 480 },
  medium: { width: 380, height: 560 },
  large: { width: 440, height: 640 },
};

/** Atributos de `<html>` que activan reglas fijas de `frame.css`. */
export interface HtmlAttrs {
  'data-palette'?: string;
  'data-position'?: string;
  'data-size'?: string;
  'data-avatar'?: string;
}

export interface ThemeTexts {
  chatName: string;
  /** Título del chat no disponible: el nombre configurado o "Chat" (R14). */
  unavailableTitle: string;
  welcomeText: string | null;
  placeholder: string;
  sendLabel: string;
}

export interface Theme {
  /** Algún color difiere del original (R3). */
  customPalette: boolean;
  tokens: Partial<Record<CssToken, string>>;
  htmlAttrs: HtmlAttrs;
  texts: ThemeTexts;
  /** URL de las imágenes guardadas, para las vistas. */
  images: { logo?: string; avatar?: string; icon?: string };
}

export const hasCustomPalette = (o: ChatDesignOptions): boolean =>
  COLOR_FIELDS.some((field) => o[field] !== ORIGINAL_DESIGN[field]);

/** Pasos de la mezcla del texto hacia el fondo: 0, 0,05, 0,10… */
const MIX_STEPS = Array.from({ length: 21 }, (_, i) => i / 20);

/**
 * El texto mezclado hacia el fondo con el mayor `t` (≤ `maxT`) que sigue cumpliendo `min`
 * frente al fondo. Como texto/fondo ya cumple 4,5:1 al guardar, `t = 0` siempre vale: nunca
 * falla con un diseño guardable (R4).
 */
function derived(text: string, background: string, maxT: number, min: number): string {
  let best = text;
  for (const t of MIX_STEPS) {
    if (t > maxT + 1e-9) break;
    const candidate = mix(text, background, t);
    if (meets(contrastRatio(candidate, background), min)) best = candidate;
  }
  return best;
}

/**
 * Tokens de los colores (vacío con la paleta original, R3). Con paleta propia se derivan el
 * atenuado, el borde del campo, las líneas y el foco (R4, FR-019a).
 */
function paletteTokens(o: ChatDesignOptions): Theme['tokens'] {
  if (!hasCustomPalette(o)) return {};
  return {
    '--chat-accent': o.primaryColor,
    '--chat-on-accent': o.onPrimaryColor,
    '--chat-bg': o.backgroundColor,
    '--chat-fg': o.textColor,
    '--chat-bot-bg': o.botBubbleColor,
    '--chat-muted': derived(o.textColor, o.backgroundColor, 0.6, MIN_TEXT_CONTRAST),
    '--chat-line': mix(o.textColor, o.backgroundColor, 0.8),
    '--chat-field-border': derived(o.textColor, o.backgroundColor, 0.8, MIN_UI_CONTRAST),
    '--chat-focus': o.textColor,
  };
}

function shapeTokens(shape: Shape): Theme['tokens'] {
  if (shape === ORIGINAL_DESIGN.shape) return {};
  const r = SHAPE_RADII[shape];
  return {
    '--chat-radius-panel': r.panel,
    '--chat-radius-bubble': r.bubble,
    '--chat-radius-control': r.control,
    '--chat-radius-toggle': r.toggle,
  };
}

/** Tema del chat y de la vista previa. */
export function computeTheme(resolved: ResolvedChatDesign, businessName: string): Theme {
  const o = resolved.options;
  const customPalette = hasCustomPalette(o);
  const htmlAttrs: HtmlAttrs = {};
  if (customPalette) htmlAttrs['data-palette'] = 'custom';
  if (o.position !== ORIGINAL_DESIGN.position) htmlAttrs['data-position'] = o.position;
  if (o.size !== ORIGINAL_DESIGN.size) htmlAttrs['data-size'] = o.size;
  const { logo, avatar, icon } = resolved.images;
  // El avatar es un fondo CSS junto a los mensajes del bot (FR-030): token y atributo.
  const avatarTokens: Theme['tokens'] = avatar ? { '--chat-avatar': `url(${avatar.url})` } : {};
  if (avatar) htmlAttrs['data-avatar'] = 'on';
  return {
    customPalette,
    tokens: { ...paletteTokens(o), ...shapeTokens(o.shape), ...avatarTokens },
    htmlAttrs,
    texts: {
      chatName: o.chatName ?? defaultChatName(businessName),
      unavailableTitle: o.chatName ?? UNAVAILABLE_TITLE,
      welcomeText: o.welcomeText,
      placeholder: o.placeholder ?? DEFAULT_PLACEHOLDER,
      sendLabel: o.sendLabel ?? DEFAULT_SEND_LABEL,
    },
    images: {
      ...(logo ? { logo: logo.url } : {}),
      ...(avatar ? { avatar: avatar.url } : {}),
      ...(icon ? { icon: icon.url } : {}),
    },
  };
}

/** Huella corta y estable del diseño, para que la URL de `design.css` cambie con él. */
export function designVersion(resolved: ResolvedChatDesign): string {
  const images = Object.entries(resolved.images)
    .map(([slot, ref]) => `${slot}:${ref.sha256}`)
    .sort();
  return createHash('sha256')
    .update(JSON.stringify([resolved.options, images]))
    .digest('hex')
    .slice(0, 12);
}
