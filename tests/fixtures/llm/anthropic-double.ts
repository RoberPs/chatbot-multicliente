/**
 * Doble del cliente de Anthropic, con la forma real de su respuesta (017, R13).
 *
 * Extraído de lo que ya usaban las pruebas del adaptador, para que los tres proveedores compartan
 * forma de uso: `queue(...)`, `calls` y el mismo `client` que el adaptador acepta.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { TokenUsage } from '../../../src/usage/types.js';

/** Consumo en la forma real de Anthropic, que informa de los **cuatro** conceptos. */
export interface AnthropicUsageShape {
  input_tokens: number;
  output_tokens: number;
  /** Ausente cuando la respuesta no escribió caché: es un **cero medido**, no un «sin dato». */
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export const anthropicUsage = (
  input: number,
  output: number,
  cacheWrite?: number | null,
  cacheRead?: number | null,
): AnthropicUsageShape => ({
  input_tokens: input,
  output_tokens: output,
  ...(cacheWrite === undefined ? {} : { cache_creation_input_tokens: cacheWrite }),
  ...(cacheRead === undefined ? {} : { cache_read_input_tokens: cacheRead }),
});

/** Tokens que el adaptador debe deducir de `anthropicUsage(...)`. */
export const anthropicExpected = (u: AnthropicUsageShape): TokenUsage => ({
  input: u.input_tokens,
  output: u.output_tokens,
  cacheWrite: u.cache_creation_input_tokens ?? 0,
  cacheRead: u.cache_read_input_tokens ?? 0,
});

export interface AnthropicMessageOptions {
  text?: string;
  stop_reason?: string;
  usage?: AnthropicUsageShape | null;
}

/** Respuesta con la forma real de `messages.create`. */
export function anthropicMessage(opts: AnthropicMessageOptions = {}): Anthropic.Message {
  const { text = '{}', stop_reason = 'end_turn', usage } = opts;
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'modelo-de-prueba',
    stop_reason,
    content: [{ type: 'text', text, citations: null }],
    ...(usage === undefined || usage === null ? {} : { usage }),
  } as unknown as Anthropic.Message;
}

/** Bloqueo por seguridad de Anthropic: su señal propia de rechazo (R10). */
export const anthropicRefusal = (usage?: AnthropicUsageShape): Anthropic.Message =>
  anthropicMessage({ stop_reason: 'refusal', ...(usage ? { usage } : {}) });

export interface AnthropicCall {
  params: Anthropic.MessageCreateParamsNonStreaming;
  options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number };
}

/** Cliente doble: devuelve lo programado, en orden, y guarda cada petición. */
export class AnthropicDouble {
  readonly calls: AnthropicCall[] = [];
  private readonly steps: Array<Anthropic.Message | Error> = [];

  queue(...steps: Array<Anthropic.Message | Error>): this {
    this.steps.push(...steps);
    return this;
  }

  /** Lo que el adaptador recibe en su opción `client`. */
  get client(): Pick<Anthropic, 'messages'> {
    const create = async (
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: AnthropicCall['options'],
    ): Promise<Anthropic.Message> => {
      this.calls.push({ params, ...(options === undefined ? {} : { options }) });
      if (options?.signal?.aborted === true) throw new Error('aborted');
      const step = this.steps.shift();
      if (step === undefined) throw new Error('Doble de Anthropic sin respuesta programada');
      if (step instanceof Error) throw step;
      return step;
    };
    return { messages: { create } } as unknown as Pick<Anthropic, 'messages'>;
  }
}
