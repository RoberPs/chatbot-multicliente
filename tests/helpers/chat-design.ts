/**
 * Ayudas de los tests del diseño del chat web (011).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../src/db/client.js';
import { chatDesign, chatDesignImage } from '../../src/db/schema.js';
import {
  ORIGINAL_DESIGN,
  type ChatDesignOptions,
  type Slot,
} from '../../src/webchat/design/defaults.js';
import {
  IMAGE_EXTENSIONS,
  validateDesignImage,
  type DesignImage,
} from '../../src/webchat/design/images.js';
import type { ValidImageChange } from '../../src/webchat/design/schemas.js';
import { saveChatDesign } from '../../src/webchat/design/store.js';
import type { Session } from './app.js';
import { multipartBody } from './config-transfer.js';

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

/** Formulario completo del panel con los valores originales sobrescritos por `over`. */
export const designForm = (over: Record<string, string> = {}): Record<string, string> => ({
  primary_color: ORIGINAL_DESIGN.primaryColor,
  on_primary_color: ORIGINAL_DESIGN.onPrimaryColor,
  background_color: ORIGINAL_DESIGN.backgroundColor,
  text_color: ORIGINAL_DESIGN.textColor,
  bot_bubble_color: ORIGINAL_DESIGN.botBubbleColor,
  shape: ORIGINAL_DESIGN.shape,
  position: ORIGINAL_DESIGN.position,
  size: ORIGINAL_DESIGN.size,
  chat_name: '',
  welcome_text: '',
  placeholder: '',
  send_label: '',
  ...over,
});

/** Paleta verde como campos del formulario. */
export const GREEN_FORM = {
  primary_color: GREEN_PALETTE.primaryColor,
  on_primary_color: GREEN_PALETTE.onPrimaryColor,
  background_color: GREEN_PALETTE.backgroundColor,
  text_color: GREEN_PALETTE.textColor,
  bot_bubble_color: GREEN_PALETTE.botBubbleColor,
};

export interface DesignFile {
  name: 'logo' | 'avatar' | 'icon';
  bytes: Buffer;
  filename?: string;
  type?: string;
}

/** Guardado multipart del panel, como lo envía el navegador (con o sin imágenes). */
export function postDesign(
  app: FastifyInstance,
  session: Session,
  fields: Record<string, string>,
  files: DesignFile[] = [],
  opts: { url?: string; headers?: Record<string, string> } = {},
) {
  const { payload, contentType } = multipartBody([
    { name: '_csrf', value: session.csrf },
    ...Object.entries(fields).map(([name, value]) => ({ name, value })),
    ...files.map((f) => ({
      name: f.name,
      value: f.bytes,
      filename: f.filename ?? `${f.name}.png`,
      type: f.type ?? 'image/png',
    })),
  ]);
  return app.inject({
    method: 'POST',
    url: opts.url ?? '/admin/chat-design',
    headers: { cookie: session.cookie, 'content-type': contentType, ...opts.headers },
    payload,
  });
}

/** Fila del diseño guardado (o `undefined`). */
export async function designRow(db: Db) {
  const [row] = await db.select().from(chatDesign);
  return row;
}

/** Imágenes guardadas, por hueco. */
export async function designImages(db: Db) {
  const rows = await db.select().from(chatDesignImage);
  return Object.fromEntries(rows.map((r) => [r.slot, r]));
}

/** Guarda un diseño con imágenes de `tests/fixtures/images/` (ya validadas y normalizadas). */
export async function seedChatDesignWithImages(
  db: Db,
  files: Partial<Record<Slot, string>>,
  partial: Partial<ChatDesignOptions> = {},
): Promise<Record<Slot, DesignImage | undefined>> {
  const options = { ...ORIGINAL_DESIGN, ...partial };
  const images: Partial<Record<Slot, ValidImageChange>> = {};
  const out = {} as Record<Slot, DesignImage | undefined>;
  for (const [slot, name] of Object.entries(files) as Array<[Slot, string]>) {
    const result = validateDesignImage({ bytes: loadImageFixture(name), truncated: false });
    if (!result.ok) throw new Error(`${name}: ${result.message}`);
    images[slot] = { kind: 'replace', image: result.image };
    out[slot] = result.image;
  }
  await saveChatDesign(db, options, images);
  return out;
}

/** URL de una imagen guardada (`/chat/design/<hueco>/<huella>.<ext>`). */
export const imageUrl = (slot: Slot, image: DesignImage): string =>
  `/chat/design/${slot}/${image.sha256.slice(0, 16)}.${IMAGE_EXTENSIONS[image.mimeType]}`;
