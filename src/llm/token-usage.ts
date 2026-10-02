/**
 * Tokens de una respuesta de Anthropic en la forma del dominio (010, R1). Los tokens de
 * razonamiento ya van dentro de `output_tokens`; la caché ausente o nula cuenta como 0.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { TokenUsage } from '../usage/types.js';

/** Avisa a `onUsage` con los tokens de `response`, si el proveedor los informa. */
export function reportUsage(
  response: Pick<Anthropic.Message, 'usage'>,
  onUsage: ((usage: TokenUsage) => void) | undefined,
): void {
  const u = response.usage as Anthropic.Usage | undefined;
  if (!onUsage || !u) return;
  onUsage({
    input: u.input_tokens,
    output: u.output_tokens,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
  });
}
