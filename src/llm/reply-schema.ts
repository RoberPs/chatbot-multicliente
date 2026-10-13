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
 * Añade `null` a los tipos admitidos de un nodo, sin duplicarlo. Un nodo sin `type` —una
 * composición— se deja como está: añadirle un tipo cambiaría su significado.
 */
function admitNull(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node;
  const out = { ...(node as Record<string, unknown>) };
  const type = out.type;
  if (typeof type === 'string') {
    out.type = type === 'null' ? type : [type, 'null'];
  } else if (Array.isArray(type) && !type.includes('null')) {
    out.type = [...(type as unknown[]), 'null'];
  }
  return out;
}

/**
 * Dialecto del modo estricto de OpenAI: **todas** las propiedades en `required`, y las que el
 * dominio dejaba opcionales admitiendo `null`.
 *
 * El modo estricto no admite propiedades opcionales, y `modelReplySchema` tiene opcionales: los
 * campos de la derivación (005) faltan en la respuesta y Zod les pone su valor por defecto. Se
 * resuelve **aquí**, en el adaptador, y no en el dominio: cambiar el esquema del dominio para
 * acomodar la limitación de un proveedor afectaría al comportamiento con los otros dos.
 *
 * La vuelta la cierra el adaptador, que normaliza los `null` recibidos a «ausente» antes de pasar
 * el objeto a Zod, para que los valores por defecto del dominio se apliquen igual que siempre.
 */
function strict(schema: Record<string, unknown>): Record<string, unknown> {
  const out = { ...schema };
  const properties = out.properties;
  if (out.type === 'object' && properties !== null && typeof properties === 'object') {
    const entries = Object.entries(properties as Record<string, unknown>);
    const required = new Set((Array.isArray(out.required) ? out.required : []) as string[]);
    out.properties = Object.fromEntries(
      entries.map(([name, value]) => [
        name,
        // Promovido: admite `null`. Ya obligatorio: se deja intacto, para que el esquema que ve
        // OpenAI diga de esos campos exactamente lo mismo que el que ven los otros dos.
        required.has(name) ? strictNode(value) : admitNull(strictNode(value)),
      ]),
    );
    out.required = entries.map(([name]) => name);
  }
  return out;
}

/** Aplica el modo estricto a los objetos anidados (los de `items`, entre otros). */
function strictNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictNode);
  if (node === null || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  if (obj.type === 'object') return strict(obj);
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, strictNode(v)]));
}

/**
 * JSON Schema de la respuesta en el dialecto del proveedor.
 *
 * - `anthropic`: la limpieza, tal cual.
 * - `gemini`: la misma limpieza. Su documentación dice que ignora las propiedades que no admite,
 *   así que quitarlas es inofensivo y deja un esquema más pequeño.
 * - `openai`: la limpieza más el modo estricto.
 */
export function replyJsonSchema(provider: LlmProvider = 'anthropic'): Record<string, unknown> {
  const base = z.toJSONSchema(modelReplySchema, { io: 'input' }) as Record<string, unknown>;
  const cleaned = clean(base) as Record<string, unknown>;
  switch (provider) {
    case 'openai':
      return strict(cleaned);
    case 'anthropic':
    case 'gemini':
      return cleaned;
  }
}
