/**
 * Lectura y escritura del diseño del chat web (011, research R1, R13).
 *
 * Sin fila en `chat_design` el chat tiene el aspecto original. La lectura es tolerante, campo a
 * campo: un valor guardado que ya no se admite toma el original y se anota en `unsupported`, y
 * el chat se sigue sirviendo (FR-018). Se lee sin caché, en cada petición (FR-012).
 */
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../conversation/repositories/customer.js';
import { chatDesign, chatDesignImage } from '../../db/schema.js';
import { touch } from '../../db/timestamps.js';
import { contrastFailures } from './contrast.js';
import {
  COLOR_FIELDS,
  IMAGE_TYPES,
  ORIGINAL_DESIGN,
  originalResolved,
  SLOTS,
  type ChatDesignOptions,
  type ImageRef,
  type ImageType,
  type ResolvedChatDesign,
  type Slot,
} from './defaults.js';
import {
  IMAGE_EXTENSIONS,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIDE,
  MIN_IMAGE_SIDE,
  validateDesignImage,
} from './images.js';
import { chatDesignOptionsSchema, type ValidImageChange } from './schemas.js';

/** Fila de `chat_design` tal como sale de la BD. */
export type ChatDesignRow = typeof chatDesign.$inferSelect;

/** Opción del dominio → columna de la fila. */
const ROW_VALUE: Record<keyof ChatDesignOptions, (row: ChatDesignRow) => unknown> = {
  primaryColor: (r) => r.primaryColor,
  onPrimaryColor: (r) => r.onPrimaryColor,
  backgroundColor: (r) => r.backgroundColor,
  textColor: (r) => r.textColor,
  botBubbleColor: (r) => r.botBubbleColor,
  shape: (r) => r.shape,
  position: (r) => r.position,
  size: (r) => r.size,
  chatName: (r) => r.chatName,
  welcomeText: (r) => r.welcomeText,
  placeholder: (r) => r.placeholderText,
  sendLabel: (r) => r.sendLabel,
};

const OPTION_KEYS = Object.keys(ROW_VALUE) as Array<keyof ChatDesignOptions>;

/**
 * Diseño que se aplica a partir de lo guardado (función pura, R13): cada campo se interpreta
 * por separado y, si no vale, se usa el original.
 */
export function resolveChatDesign(
  row: ChatDesignRow | null,
  imageRows: ImageMetaRow[] = [],
): ResolvedChatDesign {
  if (!row) return originalResolved();
  const shape = chatDesignOptionsSchema.shape;
  const options = { ...ORIGINAL_DESIGN } as Record<keyof ChatDesignOptions, unknown>;
  const unsupported: string[] = [];
  for (const key of OPTION_KEYS) {
    const parsed = shape[key].safeParse(ROW_VALUE[key](row));
    if (parsed.success) options[key] = parsed.data;
    else unsupported.push(key);
  }
  // Si con lo leído alguna pareja no cumple (un núcleo posterior más exigente), toda la paleta
  // vuelve a la original: nunca se sirve un chat ilegible (R13).
  if (contrastFailures(options as unknown as ChatDesignOptions).length > 0) {
    for (const field of COLOR_FIELDS) options[field] = ORIGINAL_DESIGN[field];
    unsupported.push('palette');
  }
  const images: ResolvedChatDesign['images'] = {};
  for (const image of imageRows) {
    const ref = imageRef(image);
    if (ref) images[image.slot as Slot] = ref;
    else if (isSlot(image.slot)) unsupported.push(image.slot);
  }
  return {
    saved: true,
    options: options as unknown as ChatDesignOptions,
    images,
    unsupported,
  };
}

/** Metadatos de una imagen guardada (sin los bytes). */
export interface ImageMetaRow {
  slot: string;
  mimeType: string;
  sha256: string;
  width: number;
  height: number;
  byteSize: number;
}

const isSlot = (value: string): value is Slot => (SLOTS as readonly string[]).includes(value);
const isImageType = (value: string): value is ImageType =>
  (IMAGE_TYPES as readonly string[]).includes(value);
const inRange = (side: number) => side >= MIN_IMAGE_SIDE && side <= MAX_IMAGE_SIDE;

/** Huella de la URL: 16 primeros caracteres del SHA-256 (R10). */
export const imageFileName = (sha256: string, mimeType: ImageType): string =>
  `${sha256.slice(0, 16)}.${IMAGE_EXTENSIONS[mimeType]}`;

/**
 * Referencia de una imagen guardada para el chat, o `null` si sus metadatos ya no valen (la
 * imagen se ignora, R13). Los bytes se vuelven a validar al servirlos.
 */
function imageRef(row: ImageMetaRow): ImageRef | null {
  if (!isSlot(row.slot) || !isImageType(row.mimeType)) return null;
  if (!/^[0-9a-f]{64}$/.test(row.sha256) || !inRange(row.width) || !inRange(row.height)) {
    return null;
  }
  if (row.byteSize < 1 || row.byteSize > MAX_IMAGE_BYTES) return null;
  return {
    url: `/chat/design/${row.slot}/${imageFileName(row.sha256, row.mimeType)}`,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
  };
}

/** Diseño guardado, leído sin caché. */
export async function readChatDesign(tx: DbOrTx): Promise<ResolvedChatDesign> {
  const [row] = await tx.select().from(chatDesign).where(eq(chatDesign.id, 1));
  if (!row) return resolveChatDesign(null);
  // Solo los metadatos: los bytes se leen únicamente para servir la imagen.
  const images = await tx
    .select({
      slot: chatDesignImage.slot,
      mimeType: chatDesignImage.mimeType,
      sha256: chatDesignImage.sha256,
      width: chatDesignImage.width,
      height: chatDesignImage.height,
      byteSize: chatDesignImage.byteSize,
    })
    .from(chatDesignImage);
  return resolveChatDesign(row, images);
}

/**
 * Bytes de la imagen de un hueco, solo si siguen pasando la validación (R13); `null` si no hay
 * imagen o ya no vale.
 */
export async function readDesignImageBytes(
  tx: DbOrTx,
  slot: Slot,
): Promise<{ bytes: Buffer; mimeType: ImageType; sha256: string } | null> {
  const [row] = await tx.select().from(chatDesignImage).where(eq(chatDesignImage.slot, slot));
  if (!row) return null;
  const checked = validateDesignImage({ bytes: row.bytes, truncated: false });
  if (
    !checked.ok ||
    checked.image.sha256 !== row.sha256 ||
    checked.image.mimeType !== row.mimeType
  ) {
    return null;
  }
  return { bytes: row.bytes, mimeType: checked.image.mimeType, sha256: row.sha256 };
}

/** Columnas de la fila a partir de unas opciones ya validadas. */
const rowValues = (o: ChatDesignOptions) => ({
  primaryColor: o.primaryColor,
  onPrimaryColor: o.onPrimaryColor,
  backgroundColor: o.backgroundColor,
  textColor: o.textColor,
  botBubbleColor: o.botBubbleColor,
  shape: o.shape,
  position: o.position,
  size: o.size,
  chatName: o.chatName,
  welcomeText: o.welcomeText,
  placeholderText: o.placeholder,
  sendLabel: o.sendLabel,
});

/**
 * Guarda el diseño (opciones ya validadas): reemplaza la fila entera, así que de dos guardados
 * seguidos gana el último (FR-017). No toca `web_chat_settings` (FR-014).
 */
export async function saveChatDesign(
  tx: DbOrTx,
  options: ChatDesignOptions,
  images: Partial<Record<Slot, ValidImageChange>> = {},
): Promise<void> {
  // Red de seguridad: solo llega aquí un diseño validado con `validateChatDesign`.
  if (contrastFailures(options).length > 0) {
    throw new Error('Diseño sin validar: hay parejas de colores sin contraste suficiente');
  }
  const values = rowValues(options);
  await tx
    .insert(chatDesign)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: chatDesign.id, set: { ...values, ...touch() } });
  // Por hueco: sustituir, quitar o dejar la imagen (FR-029), en la misma transacción.
  for (const slot of SLOTS) {
    const change = images[slot];
    if (!change || change.kind === 'keep') continue;
    if (change.kind === 'remove') {
      await tx.delete(chatDesignImage).where(eq(chatDesignImage.slot, slot));
      continue;
    }
    const image = {
      designId: 1,
      mimeType: change.image.mimeType,
      bytes: change.image.bytes,
      sha256: change.image.sha256,
      width: change.image.width,
      height: change.image.height,
      byteSize: change.image.byteSize,
    };
    await tx
      .insert(chatDesignImage)
      .values({ slot, ...image })
      .onConflictDoUpdate({ target: chatDesignImage.slot, set: { ...image, ...touch() } });
  }
}

/**
 * Vuelve al aspecto original (US6): borra la fila del diseño y, en cascada, sus imágenes. No
 * toca `web_chat_settings`.
 */
export async function resetChatDesign(tx: DbOrTx): Promise<'reset' | 'nothing_to_reset'> {
  const deleted = await tx.delete(chatDesign).returning({ id: chatDesign.id });
  return deleted.length > 0 ? 'reset' : 'nothing_to_reset';
}
