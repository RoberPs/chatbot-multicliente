/**
 * Doble del cliente de OpenAI, con la forma real de su respuesta (017, R13).
 *
 * La trampa que este doble existe para cazar: **el rechazo llega como un elemento de contenido**
 * `type: 'refusal'` dentro de `output`, y el estado de la respuesta sigue siendo `completed` (R10).
 * Un adaptador que mire solo el estado lo tomará por una respuesta válida vacía y el cliente final
 * recibirá algo sin sentido. Por eso `openaiRefusal()` tiene el estado en `completed` a propósito.
 *
 * Corrección respecto a R11, comprobada contra `openai` 7.32.0: OpenAI **sí** informa de la
 * escritura de caché, en `input_tokens_details.cache_write_tokens`, declarado no opcional. Así que
 * sus cuatro conceptos son números y `cacheWrite` **no** es `null`.
 */
import type { TokenUsage } from '../../../src/usage/types.js';

/** Consumo en la forma real de OpenAI. */
export interface OpenAiUsageShape {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  /** Los tokens de razonamiento ya van **dentro** de `output_tokens`: no se suman aparte. */
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens?: number;
}

export const openaiUsage = (
  input: number,
  output: number,
  cacheWrite?: number,
  cacheRead?: number,
  reasoning?: number,
): OpenAiUsageShape => ({
  input_tokens: input,
  output_tokens: output,
  input_tokens_details: {
    ...(cacheRead === undefined ? {} : { cached_tokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cache_write_tokens: cacheWrite }),
  },
  ...(reasoning === undefined ? {} : { output_tokens_details: { reasoning_tokens: reasoning } }),
});

/** Tokens que el adaptador debe deducir: el razonamiento **no** se suma dos veces. */
export const openaiExpected = (u: OpenAiUsageShape): TokenUsage => ({
  input: u.input_tokens,
  output: u.output_tokens,
  cacheWrite: u.input_tokens_details?.cache_write_tokens ?? 0,
  cacheRead: u.input_tokens_details?.cached_tokens ?? 0,
});

export type OpenAiContentItem =
  | { type: 'output_text'; text: string; annotations?: unknown[] }
  | { type: 'refusal'; refusal: string };

export type OpenAiOutputItem =
  | { type: 'message'; role: 'assistant'; status?: string; content: OpenAiContentItem[] }
  | { type: 'reasoning'; summary: unknown[] };

export interface OpenAiResponseShape {
  id: string;
  object: 'response';
  status?: string;
  output: OpenAiOutputItem[];
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
  usage?: OpenAiUsageShape;
}

export interface OpenAiResponseOptions {
  text?: string;
  status?: string;
  usage?: OpenAiUsageShape | null;
}

export function openaiResponse(opts: OpenAiResponseOptions = {}): OpenAiResponseShape {
  const { text = '{}', status = 'completed', usage } = opts;
  return {
    id: 'resp_1',
    object: 'response',
    status,
    output: [
      { type: 'reasoning', summary: [] },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    ],
    incomplete_details: null,
    error: null,
    ...(usage === undefined || usage === null ? {} : { usage }),
  };
}

/**
 * Rechazo del modelo. **El estado es `completed`**: la señal está en el tipo del elemento de
 * contenido, no en el estado de la respuesta (R10).
 */
export function openaiRefusal(
  refusal = 'No puedo ayudar con eso.',
  usage?: OpenAiUsageShape,
): OpenAiResponseShape {
  return {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'refusal', refusal }],
      },
    ],
    incomplete_details: null,
    error: null,
    ...(usage === undefined ? {} : { usage }),
  };
}

/** Respuesta truncada por el tope de salida: `invalid_output`, no rechazo. */
export function openaiTruncated(text = '{"body": '): OpenAiResponseShape {
  return {
    ...openaiResponse({ text, status: 'incomplete' }),
    incomplete_details: { reason: 'max_output_tokens' },
  };
}

export interface OpenAiCall {
  params: Record<string, unknown>;
  options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number };
}

/** Cliente doble: devuelve lo programado, en orden, y guarda cada petición. */
export class OpenAiDouble {
  readonly calls: OpenAiCall[] = [];
  private readonly steps: Array<OpenAiResponseShape | Error> = [];

  queue(...steps: Array<OpenAiResponseShape | Error>): this {
    this.steps.push(...steps);
    return this;
  }

  /** Lo que el adaptador recibe en su opción `client`. */
  get client(): unknown {
    const create = async (
      params: Record<string, unknown>,
      options?: OpenAiCall['options'],
    ): Promise<OpenAiResponseShape> => {
      this.calls.push({ params, ...(options === undefined ? {} : { options }) });
      if (options?.signal?.aborted === true) throw new Error('aborted');
      const step = this.steps.shift();
      if (step === undefined) throw new Error('Doble de OpenAI sin respuesta programada');
      if (step instanceof Error) throw step;
      return step;
    };
    return { responses: { create } };
  }
}
