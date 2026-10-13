/**
 * `ChatModel` sobre la API de Gemini (017, R7 – R11). Salida estructurada con el JSON Schema de
 * `modelReplySchema`, revalidada con Zod: el dominio no cambia, solo la traducción.
 */
import { ApiError, GoogleGenAI, ThinkingLevel } from '@google/genai';
import { ChatModelError, type ChatModel } from '../conversation/ports.js';
import { modelReplySchema, type ModelReply, type ReplyContext } from '../conversation/types.js';
import type { TokenUsage } from '../usage/types.js';
import { buildPrompt } from './prompt.js';
import { replyJsonSchema } from './reply-schema.js';
import { reportUsage } from './token-usage.js';
import type { Effort } from './anthropic-chat-model.js';

export interface GeminiChatModelOptions {
  apiKey?: string;
  model: string;
  effort: Effort;
  /** Cliente ya construido (tests). */
  client?: unknown;
}

const MAX_TOKENS = 4000;
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * Traducción directa del esfuerzo del dominio (R8). `MINIMAL` no se usa: no hay posición del
 * dominio que le corresponda, y su documentación avisa de que no está admitido en todos sus
 * modelos.
 */
const THINKING_LEVEL: Record<Effort, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/** Motivos de fin que son un bloqueo por seguridad del candidato, no un fallo técnico (R10). */
const SAFETY_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION']);

/** Lo mínimo de la respuesta que el adaptador lee (el doble reproduce esta misma forma). */
interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

interface GeminiClient {
  models: { generateContent(params: Record<string, unknown>): Promise<GeminiResponse> };
}

/**
 * Tokens de la respuesta en la forma del dominio, o `null` si no informó nada.
 *
 * **Los tokens de razonamiento vienen aparte** en `thoughtsTokenCount` y **no** están dentro de
 * `candidatesTokenCount`: sumarlos es obligatorio (R11). Si no se suman, el consumo de salida se
 * subestima y el tope de gasto protege menos de lo que cree.
 *
 * **`cacheWrite` es `null` siempre**: comprobado contra `@google/genai` 2.29.0, su metadato de
 * consumo no tiene ningún campo de escritura de caché. Es una capacidad que el proveedor no tiene,
 * no un campo que falte en esta respuesta (FR-024).
 */
export function geminiTokenUsage(usage: GeminiResponse['usageMetadata']): TokenUsage | null {
  if (!usage) return null;
  return {
    input: usage.promptTokenCount ?? 0,
    output: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
    cacheWrite: null,
    cacheRead: usage.cachedContentTokenCount ?? 0,
  };
}

export function createGeminiChatModel(opts: GeminiChatModelOptions): ChatModel {
  const client = (opts.client ?? new GoogleGenAI({ apiKey: opts.apiKey })) as GeminiClient;
  const schema = replyJsonSchema('gemini');

  return {
    async reply(context: ReplyContext, { signal, feedback, onUsage }): Promise<ModelReply> {
      const prompt = buildPrompt(context, feedback);
      let response: GeminiResponse;
      try {
        response = await client.models.generateContent({
          model: opts.model,
          contents: prompt.messages.map((turn) => ({
            role: turn.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: turn.content }],
          })),
          config: {
            systemInstruction: prompt.system.join('\n\n'),
            maxOutputTokens: MAX_TOKENS,
            responseMimeType: 'application/json',
            responseJsonSchema: schema,
            thinkingConfig: { thinkingLevel: THINKING_LEVEL[opts.effort] },
            // FR-020: el plazo y los reintentos son del dominio. La señal de aborto que recibe
            // `reply` se propaga, y la política de reintentos del SDK se deja en un solo intento,
            // para que los dos intentos del responder sigan compartiendo un único presupuesto.
            abortSignal: signal,
            httpOptions: { timeout: REQUEST_TIMEOUT_MS, retryOptions: { attempts: 1 } },
            // R9: no se marca nada de caché. Gemini tiene caché implícita, y la explícita obligaría
            // a gestionar el ciclo de vida de un contenido en caché con vida propia en el
            // proveedor, que se desincronizaría de la información del negocio: el prompt del
            // sistema se lee en cada respuesta sin caché, por decisión del producto. Que nadie la
            // añada de buena fe.
          },
        });
      } catch (error) {
        throw toChatModelError(error, signal);
      }

      // Hay respuesta: sus tokens cuentan aunque se descarte después (010, R1).
      reportUsage(geminiTokenUsage(response.usageMetadata), onUsage);

      // R10, señal 1: bloqueo del prompt. No hay candidatos y el motivo viene aquí.
      if (response.promptFeedback?.blockReason !== undefined) throw new ChatModelError('refusal');
      const candidate = response.candidates?.[0];
      if (!candidate) throw new ChatModelError('invalid_output');
      // R10, señal 2: bloqueo del candidato por seguridad.
      if (candidate.finishReason !== undefined && SAFETY_FINISH.has(candidate.finishReason)) {
        throw new ChatModelError('refusal');
      }
      // Truncada por el tope de salida, o cualquier otro fin que no sea el normal.
      if (candidate.finishReason !== undefined && candidate.finishReason !== 'STOP') {
        throw new ChatModelError('invalid_output');
      }
      const text = (candidate.content?.parts ?? [])
        .filter((part) => part.thought !== true)
        .map((part) => part.text ?? '')
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

export function toChatModelError(error: unknown, signal: AbortSignal): ChatModelError {
  if (error instanceof ChatModelError) return error;
  if (signal.aborted) return new ChatModelError('timeout');
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new ChatModelError('timeout');
  }
  if (error instanceof ApiError) {
    const status: unknown = error.status;
    return new ChatModelError('api_error', typeof status === 'number' ? status : undefined);
  }
  return new ChatModelError('api_error');
}
