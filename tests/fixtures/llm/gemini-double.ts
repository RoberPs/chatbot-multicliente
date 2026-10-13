/**
 * Doble del cliente de Gemini, con la forma real de su respuesta (017, R13).
 *
 * Las dos trampas que este doble reproduce a propósito:
 *
 * 1. **`thoughtsTokenCount` va aparte de `candidatesTokenCount`.** El adaptador tiene que sumarlo
 *    a los tokens de salida; si no, el consumo se subestima y el tope de gasto protege menos de lo
 *    que cree (R11).
 * 2. **No hay ningún campo de escritura de caché.** Comprobado contra `@google/genai` 2.29.0:
 *    `GenerateContentResponseUsageMetadata` solo tiene `cachedContentTokenCount`, que es lectura.
 *    Por eso Gemini es el proveedor del que `cacheWrite` sale `null` (FR-024).
 */
import type { TokenUsage } from '../../../src/usage/types.js';

/** Consumo en la forma real de Gemini. */
export interface GeminiUsageShape {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  /** Tokens de razonamiento, **fuera** de `candidatesTokenCount`. */
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

export const geminiUsage = (
  prompt: number,
  candidates: number,
  thoughts?: number,
  cachedContent?: number,
): GeminiUsageShape => ({
  promptTokenCount: prompt,
  candidatesTokenCount: candidates,
  ...(thoughts === undefined ? {} : { thoughtsTokenCount: thoughts }),
  ...(cachedContent === undefined ? {} : { cachedContentTokenCount: cachedContent }),
});

/** Tokens que el adaptador debe deducir: razonamiento sumado y escritura de caché sin dato. */
export const geminiExpected = (u: GeminiUsageShape): TokenUsage => ({
  input: u.promptTokenCount ?? 0,
  output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
  cacheWrite: null,
  cacheRead: u.cachedContentTokenCount ?? 0,
});

/** Respuesta con la forma real de `models.generateContent`. */
export interface GeminiResponseShape {
  candidates?: Array<{
    content?: { role?: string; parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: GeminiUsageShape;
}

export interface GeminiResponseOptions {
  text?: string;
  finishReason?: string;
  usage?: GeminiUsageShape | null;
}

export function geminiResponse(opts: GeminiResponseOptions = {}): GeminiResponseShape {
  const { text = '{}', finishReason = 'STOP', usage } = opts;
  return {
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason }],
    ...(usage === undefined || usage === null ? {} : { usageMetadata: usage }),
  };
}

/**
 * Bloqueo por seguridad **del prompt**: no hay candidatos, y el motivo viene en `promptFeedback`.
 * Es una de las dos señales de rechazo de Gemini (R10).
 */
export function geminiPromptBlocked(blockReason = 'SAFETY'): GeminiResponseShape {
  return { promptFeedback: { blockReason } };
}

/** Bloqueo por seguridad **del candidato**: el motivo de fin no es `STOP`. La otra señal (R10). */
export function geminiCandidateBlocked(
  finishReason = 'SAFETY',
  usage?: GeminiUsageShape,
): GeminiResponseShape {
  return {
    candidates: [{ content: { role: 'model', parts: [] }, finishReason }],
    ...(usage === undefined ? {} : { usageMetadata: usage }),
  };
}

/** Respuesta truncada por el tope de salida: `invalid_output`, no rechazo. */
export const geminiTruncated = (text = '{"body": '): GeminiResponseShape =>
  geminiResponse({ text, finishReason: 'MAX_TOKENS' });

export interface GeminiCall {
  model?: string;
  contents?: unknown;
  config?: Record<string, unknown>;
}

/** Cliente doble: devuelve lo programado, en orden, y guarda cada petición. */
export class GeminiDouble {
  readonly calls: GeminiCall[] = [];
  private readonly steps: Array<GeminiResponseShape | Error> = [];

  queue(...steps: Array<GeminiResponseShape | Error>): this {
    this.steps.push(...steps);
    return this;
  }

  /** Lo que el adaptador recibe en su opción `client`. */
  get client(): unknown {
    const generateContent = async (params: GeminiCall): Promise<GeminiResponseShape> => {
      this.calls.push(params);
      const signal = params.config?.abortSignal;
      if (signal instanceof AbortSignal && signal.aborted) throw new Error('aborted');
      const step = this.steps.shift();
      if (step === undefined) throw new Error('Doble de Gemini sin respuesta programada');
      if (step instanceof Error) throw step;
      return step;
    };
    return { models: { generateContent } };
  }
}
