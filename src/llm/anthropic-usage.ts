/**
 * Extracción del consumo de una respuesta de Anthropic (017, R11). La comparten los dos
 * adaptadores de este proveedor.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { TokenUsage } from '../usage/types.js';

/**
 * Tokens de la respuesta en la forma del dominio, o `null` si no informó nada.
 *
 * Los tokens de razonamiento ya van dentro de `output_tokens`, así que **no** se suman aparte.
 *
 * **Los dos conceptos de caché son números, nunca `null`**: Anthropic sí informa de los cuatro. Una
 * respuesta que no escribió caché llega con el campo ausente, y eso es un **cero medido**, no un
 * «sin dato» (FR-024, data-model.md §1). Cambiar este `?? 0` por `?? null` haría que el panel de
 * una instancia de Anthropic dijese «sin dato» de un dato del que su proveedor sí informa.
 */
export function anthropicTokenUsage(usage: Anthropic.Usage | undefined): TokenUsage | null {
  if (!usage) return null;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
  };
}
