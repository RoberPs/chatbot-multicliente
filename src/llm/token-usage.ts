/**
 * Aviso del consumo de una llamada al puerto que lo registra (010, R1).
 *
 * 017 (FR-022, FR-023): este módulo ya **no sabe de ningún proveedor**. Recibe un `TokenUsage` ya
 * normalizado y la extracción de los campos vive en cada adaptador, que es el único que conoce la
 * forma de la respuesta de su API.
 */
import type { TokenUsage } from '../usage/types.js';

/**
 * Avisa a `onUsage` con `usage`, si el proveedor informó algo. Un `null` o `undefined` significa
 * que esa llamada **no informó ningún token**: no se avisa, y el responder la cuenta como llamada
 * no medida (FR-025).
 */
export function reportUsage(
  usage: TokenUsage | null | undefined,
  onUsage: ((usage: TokenUsage) => void) | undefined,
): void {
  if (!onUsage || !usage) return;
  onUsage(usage);
}
