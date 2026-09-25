/**
 * Comprobaciones del chat web que dependen de cabeceras HTTP (004, FR-027,
 * contracts/web-chat-http.md). Lo que conoce el navegador vive aquí, no en `src/webchat`.
 */
import type { WebChatSettings } from '../../webchat/settings.js';

/** Ningún origen puede incrustar el frame. */
export const NO_ANCESTORS = "'none'";

/**
 * Valor de `frame-ancestors` para la CSP del frame: los orígenes permitidos cuando el chat
 * está activado, `'none'` en cualquier otro caso (el navegador impide la incrustación).
 */
export function frameAncestors(settings: WebChatSettings | null): string {
  if (!settings?.enabled || settings.allowedOrigins.length === 0) return NO_ANCESTORS;
  return settings.allowedOrigins.join(' ');
}

/** Origen de una URL de cabecera (`Referer`, `Origin`) en minúsculas; `null` si no es una URL. */
export function headerOrigin(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * El `Referer`, cuando llega, viene de una web permitida (FR-027). Si no llega no se puede
 * comprobar y se deja pasar: `frame-ancestors` es lo que de verdad impide la incrustación.
 */
export function refererAllowed(
  referer: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  const origin = headerOrigin(referer);
  return origin === null || allowedOrigins.includes(origin);
}
