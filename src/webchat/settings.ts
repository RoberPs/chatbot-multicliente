/**
 * Configuración del chat web (004, research R8): fila única de `web_chat_settings`, leída sin
 * caché en cada petición para que activar o desactivar tenga efecto en la siguiente.
 */
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../conversation/repositories/customer.js';
import { webChatSettings } from '../db/schema.js';

export interface WebChatSettings {
  enabled: boolean;
  /** Orígenes normalizados (`https://host[:puerto]`), máximo 10. */
  allowedOrigins: string[];
  privacyUrl: string | null;
  dailyCap: number;
  monthlyCap: number;
}

/** Valores de la migración: desactivado, sin webs y con los topes por defecto (FR-014). */
export const defaultWebChatSettings: WebChatSettings = {
  enabled: false,
  allowedOrigins: [],
  privacyUrl: null,
  dailyCap: 200,
  monthlyCap: 3000,
};

export async function readWebChatSettings(tx: DbOrTx): Promise<WebChatSettings> {
  const [row] = await tx
    .select({
      enabled: webChatSettings.enabled,
      allowedOrigins: webChatSettings.allowedOrigins,
      privacyUrl: webChatSettings.privacyUrl,
      dailyCap: webChatSettings.dailyCap,
      monthlyCap: webChatSettings.monthlyCap,
    })
    .from(webChatSettings)
    .where(eq(webChatSettings.id, 1));
  return row ?? defaultWebChatSettings;
}
