/**
 * `ChatModel` sobre la API de Anthropic (research R7, contracts/chat-model.md).
 * Salida estructurada con el JSON Schema de `modelReplySchema`, revalidada con Zod.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { ChatModelError, type ChatModel } from '../conversation/ports.js';
import { modelReplySchema, type ModelReply, type ReplyContext } from '../conversation/types.js';
import { buildPrompt } from './prompt.js';

export type Effort = 'low' | 'medium' | 'high';

export interface AnthropicChatModelOptions {
  apiKey?: string;
  model: string;
  effort: Effort;
  /** Cliente ya construido (tests). */
  client?: Pick<Anthropic, 'messages'>;
}

const MAX_TOKENS = 4000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RETRIES = 1;

/**
 * JSON Schema para `output_config.format`. Las restricciones de longitud no se admiten en
 * salida estructurada: se quitan aquí y las comprueba Zod al recibir la respuesta.
 */
export function replyJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(modelReplySchema) as Record<string, unknown>;
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (node === null || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '$schema' || key === 'maxLength' || key === 'minLength') continue;
      out[key] = clean(value);
    }
    if (out.type === 'object') out.additionalProperties = false;
    return out;
  };
  return clean(schema) as Record<string, unknown>;
}

export function createAnthropicChatModel(opts: AnthropicChatModelOptions): ChatModel {
  const client =
    opts.client ??
    new Anthropic({ apiKey: opts.apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
  const schema = replyJsonSchema();

  return {
    async reply(context: ReplyContext, { signal, feedback }): Promise<ModelReply> {
      const prompt = buildPrompt(context, feedback);
      let response: Anthropic.Message;
      try {
        response = await client.messages.create(
          {
            model: opts.model,
            max_tokens: MAX_TOKENS,
            thinking: { type: 'adaptive' },
            output_config: { effort: opts.effort, format: { type: 'json_schema', schema } },
            system: prompt.system.map((text) => ({
              type: 'text' as const,
              text,
              cache_control: { type: 'ephemeral' as const },
            })),
            messages: prompt.messages,
          },
          { signal, timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES },
        );
      } catch (error) {
        throw toChatModelError(error, signal);
      }

      if (response.stop_reason === 'refusal') throw new ChatModelError('refusal');
      if (response.stop_reason !== 'end_turn') throw new ChatModelError('invalid_output');
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ChatModelError('invalid_output');
      }
      const parsed = modelReplySchema.safeParse(json);
      if (!parsed.success) throw new ChatModelError('invalid_output');
      return parsed.data;
    },
  };
}

function toChatModelError(error: unknown, signal: AbortSignal): ChatModelError {
  if (error instanceof ChatModelError) return error;
  if (signal.aborted || error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ChatModelError('timeout');
  }
  if (error instanceof Anthropic.APIUserAbortError) return new ChatModelError('timeout');
  if (error instanceof Anthropic.APIError) {
    const status: unknown = error.status;
    return new ChatModelError('api_error', typeof status === 'number' ? status : undefined);
  }
  return new ChatModelError('api_error');
}
