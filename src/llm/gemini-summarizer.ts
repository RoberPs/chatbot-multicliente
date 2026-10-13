/**
 * `HandoffSummarizer` sobre la API de Gemini (017, R12): mismo modelo que la respuesta, esfuerzo
 * bajo y salida estructurada `{ summary }`. Solo ve los textos del cliente.
 *
 * Este puerto es el segundo sitio por el que el programa llama al proveedor, y el más sensible: es
 * el que resume al **derivar a una persona**. Si solo se migrase el de conversación, una instancia
 * con Gemini conversaría bien y fallaría justo aquí, que es lo que protege el Principio V.
 */
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { HandoffSummarizer } from '../handoff/ports.js';
import { geminiTokenUsage } from './gemini-chat-model.js';
import { summaryInstructions, summaryUserTurn } from './summary-prompt.js';
import { reportUsage } from './token-usage.js';

export interface GeminiSummarizerOptions {
  apiKey?: string;
  model: string;
  /** Cliente ya construido (tests). */
  client?: unknown;
}

const MAX_TOKENS = 400;
const REQUEST_TIMEOUT_MS = 8_000;

/** Un solo campo y obligatorio: no sufre el problema del modo estricto de OpenAI (R12). */
const SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
  additionalProperties: false,
};

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: Parameters<typeof geminiTokenUsage>[0];
}

interface GeminiClient {
  models: { generateContent(params: Record<string, unknown>): Promise<GeminiResponse> };
}

export function createGeminiSummarizer(opts: GeminiSummarizerOptions): HandoffSummarizer {
  const client = (opts.client ?? new GoogleGenAI({ apiKey: opts.apiKey })) as GeminiClient;

  return {
    async summarize({ kind, customerTexts }, { signal, onUsage }) {
      const response = await client.models.generateContent({
        model: opts.model,
        contents: [{ role: 'user', parts: [{ text: summaryUserTurn(kind, customerTexts) }] }],
        config: {
          systemInstruction: summaryInstructions(),
          maxOutputTokens: MAX_TOKENS,
          responseMimeType: 'application/json',
          responseJsonSchema: SCHEMA,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          abortSignal: signal,
          httpOptions: { timeout: REQUEST_TIMEOUT_MS, retryOptions: { attempts: 1 } },
        },
      });
      // Hay respuesta: sus tokens cuentan aunque se descarte después (010, R1).
      reportUsage(geminiTokenUsage(response.usageMetadata), onUsage);

      if (response.promptFeedback?.blockReason !== undefined) {
        throw new Error('Resumen bloqueado por el proveedor');
      }
      const candidate = response.candidates?.[0];
      if (candidate?.finishReason !== undefined && candidate.finishReason !== 'STOP') {
        throw new Error(`Resumen sin terminar: ${candidate.finishReason}`);
      }
      const text = (candidate?.content?.parts ?? [])
        .filter((part) => part.thought !== true)
        .map((part) => part.text ?? '')
        .join('');
      const json = JSON.parse(text) as { summary?: unknown };
      if (typeof json.summary !== 'string') throw new Error('Resumen no válido');
      return { summary: json.summary };
    },
  };
}
