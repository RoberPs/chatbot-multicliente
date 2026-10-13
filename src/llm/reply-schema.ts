/**
 * Los dialectos del JSON Schema de la respuesta (017, R7). El esquema del dominio
 * (`modelReplySchema`) es uno y no se toca: es la única puerta de validación (FR-014). Lo que varía
 * es cómo hay que presentárselo a cada proveedor, y eso es trabajo del adaptador.
 */
import { z } from 'zod';
import { modelReplySchema } from '../conversation/types.js';
import type { LlmProvider } from './provider.js';

/**
 * Claves que la salida estructurada no admite. Las restricciones de longitud se quitan aquí y las
 * comprueba Zod al recibir la respuesta; `default` se quita porque el valor por defecto lo pone el
 * dominio, no el proveedor.
 */
const UNSUPPORTED_KEYS = ['$schema', 'maxLength', 'minLength', 'default'];

/**
 * Limpieza común a los tres dialectos: quita lo no admitido y cierra cada objeto. Los campos de la
 * derivación (005) son opcionales en la respuesta: si faltan, Zod pone su valor por defecto.
 */
function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYS.includes(key)) continue;
    out[key] = clean(value);
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

/**
 * JSON Schema de la respuesta en el dialecto del proveedor.
 *
 * - `anthropic`: la limpieza, tal cual.
 * - `gemini`: la misma limpieza. Su documentación dice que ignora las propiedades que no admite,
 *   así que quitarlas es inofensivo y deja un esquema más pequeño.
 * - `openai`: pendiente (T032): la limpieza más la promoción de los opcionales a requeridos
 *   admitiendo `null`, que es lo que exige su modo estricto.
 */
export function replyJsonSchema(provider: LlmProvider = 'anthropic'): Record<string, unknown> {
  const base = z.toJSONSchema(modelReplySchema, { io: 'input' }) as Record<string, unknown>;
  const cleaned = clean(base) as Record<string, unknown>;
  switch (provider) {
    case 'anthropic':
    case 'gemini':
      return cleaned;
    default:
      return cleaned;
  }
}
