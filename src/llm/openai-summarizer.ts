/**
 * `HandoffSummarizer` sobre la API de OpenAI (017, R12): mismo modelo que la respuesta, esfuerzo
 * bajo y salida estructurada `{ summary }`. Solo ve los textos del cliente.
 *
 * Su esquema **no** sufre el problema del modo estricto (R7): su único campo es obligatorio, así
 * que no hay nada que promover ni ningún `null` que normalizar a la vuelta.
 */
import OpenAI from 'openai';
import type { HandoffSummarizer } from '../handoff/ports.js';
import { openAiTokenUsage } from './openai-chat-model.js';
import { summaryInstructions, summaryUserTurn } from './summary-prompt.js';
import { reportUsage } from './token-usage.js';

export interface OpenAiSummarizerOptions {
  apiKey?: string;
  model: string;
  /** Cliente ya construido (tests). */
  client?: unknown;
}

const MAX_TOKENS = 400;
const REQUEST_TIMEOUT_MS = 8_000;
const FORMAT_NAME = 'resumen_de_derivacion';

const SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: false,
};

interface OpenAiResponse {
  status?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
  usage?: Parameters<typeof openAiTokenUsage>[0];
}

interface OpenAiClient {
  responses: {
    create(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number },
    ): Promise<OpenAiResponse>;
  };
}

export function createOpenAiSummarizer(opts: OpenAiSummarizerOptions): HandoffSummarizer {
  const client = (opts.client ??
    new OpenAI({
      apiKey: opts.apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    })) as OpenAiClient;

  return {
    async summarize({ kind, customerTexts }, { signal, onUsage }) {
      const response = await client.responses.create(
        {
          model: opts.model,
          instructions: summaryInstructions(),
          input: [{ role: 'user', content: summaryUserTurn(kind, customerTexts) }],
          max_output_tokens: MAX_TOKENS,
          text: { format: { type: 'json_schema', name: FORMAT_NAME, strict: true, schema: SCHEMA } },
          reasoning: { effort: 'low' },
        },
        { signal, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 },
      );
      // Hay respuesta: sus tokens cuentan aunque se descarte después (010, R1).
      reportUsage(openAiTokenUsage(response.usage), onUsage);

      const content = (response.output ?? []).flatMap((item) => item.content ?? []);
      // R10: el rechazo está en el tipo del elemento de contenido, no en el estado.
      if (content.some((part) => part.type === 'refusal')) {
        throw new Error('Resumen rechazado por el proveedor');
      }
      if (response.status !== undefined && response.status !== 'completed') {
        throw new Error(`Resumen sin terminar: ${response.status}`);
      }
      const text = content
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text ?? '')
        .join('');
      const json = JSON.parse(text) as { summary?: unknown };
      if (typeof json.summary !== 'string') throw new Error('Resumen no válido');
      return { summary: json.summary };
    },
  };
}
