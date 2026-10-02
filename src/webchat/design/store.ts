/**
 * Lectura y escritura del diseño del chat web (011, research R1, R13).
 *
 * Sin fila en `chat_design` el chat tiene el aspecto original. La lectura es tolerante, campo a
 * campo: un valor guardado que ya no se admite toma el original y se anota en `unsupported`, y
 * el chat se sigue sirviendo (FR-018). Se lee sin caché, en cada petición (FR-012).
 */
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../conversation/repositories/customer.js';
import { chatDesign } from '../../db/schema.js';
import { touch } from '../../db/timestamps.js';
import {
  ORIGINAL_DESIGN,
  originalResolved,
  type ChatDesignOptions,
  type ResolvedChatDesign,
} from './defaults.js';
import { chatDesignOptionsSchema } from './schemas.js';

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
export function resolveChatDesign(row: ChatDesignRow | null): ResolvedChatDesign {
  if (!row) return originalResolved();
  const shape = chatDesignOptionsSchema.shape;
  const options = { ...ORIGINAL_DESIGN } as Record<keyof ChatDesignOptions, unknown>;
  const unsupported: string[] = [];
  for (const key of OPTION_KEYS) {
    const parsed = shape[key].safeParse(ROW_VALUE[key](row));
    if (parsed.success) options[key] = parsed.data;
    else unsupported.push(key);
  }
  return {
    saved: true,
    options: options as unknown as ChatDesignOptions,
    images: {},
    unsupported,
  };
}

/** Diseño guardado, leído sin caché. */
export async function readChatDesign(tx: DbOrTx): Promise<ResolvedChatDesign> {
  const [row] = await tx.select().from(chatDesign).where(eq(chatDesign.id, 1));
  return resolveChatDesign(row ?? null);
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
export async function saveChatDesign(tx: DbOrTx, options: ChatDesignOptions): Promise<void> {
  const values = rowValues(options);
  await tx
    .insert(chatDesign)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: chatDesign.id, set: { ...values, ...touch() } });
}
