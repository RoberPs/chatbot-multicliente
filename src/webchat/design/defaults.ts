/**
 * Tipos y valores originales del diseño del chat web (011, data-model §2).
 *
 * Los valores originales son los del chat de la 004 (FR-015): un diseño sin fila en la BD se ve
 * exactamente como hasta ahora. Dominio puro: sin HTTP ni BD.
 */

export const SLOTS = ['logo', 'avatar', 'icon'] as const;
export type Slot = (typeof SLOTS)[number];

export const SHAPES = ['square', 'soft', 'round'] as const;
export type Shape = (typeof SHAPES)[number];

export const POSITIONS = ['right', 'left'] as const;
export type Position = (typeof POSITIONS)[number];

export const SIZES = ['small', 'medium', 'large'] as const;
export type Size = (typeof SIZES)[number];

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** Color opaco `#rrggbb` en minúsculas. */
export type Hex = string;

/** Lo que el operador elige (sin imágenes). */
export interface ChatDesignOptions {
  primaryColor: Hex;
  onPrimaryColor: Hex;
  backgroundColor: Hex;
  textColor: Hex;
  botBubbleColor: Hex;
  shape: Shape;
  position: Position;
  size: Size;
  chatName: string | null;
  welcomeText: string | null;
  placeholder: string | null;
  sendLabel: string | null;
}

/** Los cinco colores del diseño, en el orden del formulario. */
export const COLOR_FIELDS = [
  'primaryColor',
  'onPrimaryColor',
  'backgroundColor',
  'textColor',
  'botBubbleColor',
] as const;
export type ColorField = (typeof COLOR_FIELDS)[number];

/** Imagen guardada, tal como la ve el chat (sin los bytes). */
export interface ImageRef {
  url: string;
  mimeType: ImageType;
  width: number;
  height: number;
  sha256: string;
}

/** Lo que se aplica al chat y a la vista previa. */
export interface ResolvedChatDesign {
  /** Hay fila en `chat_design`. */
  saved: boolean;
  /** Efectivos: los originales donde no hay valor o el guardado no vale. */
  options: ChatDesignOptions;
  images: Partial<Record<Slot, ImageRef>>;
  /** Campos guardados que no se han podido aplicar (R13). */
  unsupported: string[];
}

/** Aspecto del chat de la 004. */
export const ORIGINAL_DESIGN: Readonly<ChatDesignOptions> = Object.freeze({
  primaryColor: '#1f5fbf',
  onPrimaryColor: '#ffffff',
  backgroundColor: '#ffffff',
  textColor: '#1d2330',
  botBubbleColor: '#ffffff',
  shape: 'round',
  position: 'right',
  size: 'medium',
  chatName: null,
  welcomeText: null,
  placeholder: null,
  sendLabel: null,
});

export const DEFAULT_PLACEHOLDER = 'Escribe tu mensaje';
export const DEFAULT_SEND_LABEL = 'Enviar';
/** Título del chat no disponible sin nombre configurado (el de la 004). */
export const UNAVAILABLE_TITLE = 'Chat';

/** Título de la cabecera sin nombre configurado (el que pinta el frame de la 004). */
export const defaultChatName = (businessName: string): string => `Asistente de ${businessName}`;

/** Sin diseño guardado. */
export const originalResolved = (): ResolvedChatDesign => ({
  saved: false,
  options: { ...ORIGINAL_DESIGN },
  images: {},
  unsupported: [],
});
