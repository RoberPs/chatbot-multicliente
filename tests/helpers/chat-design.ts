/**
 * Ayudas de los tests del diseño del chat web (011).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from '../../src/db/client.js';
import { chatDesign } from '../../src/db/schema.js';
import { ORIGINAL_DESIGN, type ChatDesignOptions } from '../../src/webchat/design/defaults.js';
import { saveChatDesign } from '../../src/webchat/design/store.js';

const IMAGES = fileURLToPath(new URL('../fixtures/images/', import.meta.url));

/** Bytes de una imagen de `tests/fixtures/images/`. */
export const loadImageFixture = (name: string): Buffer => readFileSync(`${IMAGES}${name}`);

/** Guarda un diseño con los valores originales sobrescritos por `partial`. */
export async function seedChatDesign(
  db: Db,
  partial: Partial<ChatDesignOptions> = {},
): Promise<ChatDesignOptions> {
  const options = { ...ORIGINAL_DESIGN, ...partial };
  await saveChatDesign(db, options);
  return options;
}

/** Sin diseño: el aspecto original (las imágenes se borran en cascada). */
export async function clearChatDesign(db: Db): Promise<void> {
  await db.delete(chatDesign);
}

/** Colores de una paleta propia que cumple todas las parejas de contraste. */
export const GREEN_PALETTE = {
  primaryColor: '#0b6e4f',
  onPrimaryColor: '#ffffff',
  backgroundColor: '#ffffff',
  textColor: '#1d2330',
  botBubbleColor: '#eef6f2',
} as const;
