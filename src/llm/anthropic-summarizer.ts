/**
 * `HandoffSummarizer` sobre la API de Anthropic (005, R4): mismo SDK y modelo que la respuesta,
 * esfuerzo bajo y salida estructurada `{ summary }`. Solo ve los textos del cliente.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { HandoffSummarizer } from '../handoff/ports.js';
import { summaryInstructions, summaryUserTurn } from './summary-prompt.js';

export interface AnthropicSummarizerOptions {
  apiKey?: string;
  model: string;
  /** Cliente ya construido (tests). */
  client?: Pick<Anthropic, 'messages'>;
}

const MAX_TOKENS = 400;
const REQUEST_TIMEOUT_MS = 8_000;

const SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: false,
};

export function createAnthropicSummarizer(opts: AnthropicSummarizerOptions): HandoffSummarizer {
  const client =
    opts.client ?? new Anthropic({ apiKey: opts.apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 });

  return {
    async summarize({ kind, customerTexts }, { signal }) {
      const response = await client.messages.create(
        {
          model: opts.model,
          max_tokens: MAX_TOKENS,
          output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
          system: summaryInstructions(),
          messages: [{ role: 'user', content: summaryUserTurn(kind, customerTexts) }],
        },
        { signal, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 },
      );
      if (response.stop_reason !== 'end_turn') {
        throw new Error(`Resumen sin terminar: ${response.stop_reason ?? 'desconocido'}`);
      }
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const json = JSON.parse(text) as { summary?: unknown };
      if (typeof json.summary !== 'string') throw new Error('Resumen no válido');
      return { summary: json.summary };
    },
  };
}
