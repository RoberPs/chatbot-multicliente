/**
 * `ChatModel` sobre la API de OpenAI (017, R7 – R11). Salida estructurada con el JSON Schema de
 * `modelReplySchema` en su dialecto estricto, revalidada con Zod: el dominio no cambia, solo la
 * traducción de ida y la normalización de vuelta.
 */
import OpenAI from 'openai';
import { ChatModelError, type ChatModel } from '../conversation/ports.js';
import { modelReplySchema, type ModelReply, type ReplyContext } from '../conversation/types.js';
import type { TokenUsage } from '../usage/types.js';
import type { Effort } from './anthropic-chat-model.js';
import { buildPrompt } from './prompt.js';
import { replyJsonSchema } from './reply-schema.js';
import { reportUsage } from './token-usage.js';

export interface OpenAiChatModelOptions {
  apiKey?: string;
  model: string;
  effort: Effort;
  /** Cliente ya construido (tests). */
  client?: unknown;
  /** Destino de la línea de la degradación declarada del esfuerzo (FR-017). */
  log?: (message: string) => void;
}

const MAX_TOKENS = 4000;
const REQUEST_TIMEOUT_MS = 12_000;
/** Nombre del formato: lo exige la API y no viaja a ninguna parte más. */
const FORMAT_NAME = 'respuesta_del_asistente';

/** Lo mínimo de la respuesta que el adaptador lee (el doble reproduce esta misma forma). */
interface OpenAiResponse {
  status?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
  incomplete_details?: { reason?: string } | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  };
}

interface OpenAiClient {
  responses: {
    create(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number },
    ): Promise<OpenAiResponse>;
  };
}

/**
 * Tokens de la respuesta en la forma del dominio, o `null` si no informó nada.
 *
 * Los de razonamiento (`output_tokens_details.reasoning_tokens`) ya van **dentro** de
 * `output_tokens`, así que **no** se suman aparte: hacerlo los contaría dos veces.
 *
 * **Los cuatro conceptos son números.** Corregido respecto a R11, que daba por hecho que OpenAI no
 * informa de la escritura de caché: `openai` 7.32.0 declara
 * `input_tokens_details.cache_write_tokens`, y no como opcional. Informar `null` de un concepto que
 * el proveedor sí mide sería el error de FR-024 en su versión espejo.
 */
export function openAiTokenUsage(usage: OpenAiResponse['usage']): TokenUsage | null {
  if (!usage) return null;
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    cacheWrite: usage.input_tokens_details?.cache_write_tokens ?? 0,
    cacheRead: usage.input_tokens_details?.cached_tokens ?? 0,
  };
}

/**
 * Quita del objeto recibido las claves con valor `null` (R7).
 *
 * Es la vuelta del dialecto estricto: su modo no admite propiedades opcionales, así que los campos
 * de la derivación (005) se promueven a requeridos admitiendo `null`, y el modelo devuelve `null`
 * donde los otros dos proveedores **omiten** la clave. Convertir ese `null` en «ausente» es lo que
 * hace que los valores por defecto del dominio se apliquen igual con los tres.
 */
export function normalizeNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeNulls);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, normalizeNulls(v)]),
  );
}

export function createOpenAiChatModel(opts: OpenAiChatModelOptions): ChatModel {
  const client = (opts.client ??
    new OpenAI({
      apiKey: opts.apiKey,
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    })) as OpenAiClient;
  const schema = replyJsonSchema('openai');
  const log = opts.log ?? ((message: string) => {
    console.warn(message);
  });
  /**
   * Degradación declarada del esfuerzo (FR-017, R8). No se adivina por el nombre del modelo si
   * admite razonamiento: se envía y, si el proveedor lo rechaza por parámetro no admitido, se anota
   * **una** vez, se reintenta **una** vez sin él, y la decisión se recuerda para el resto de la
   * vida del proceso.
   */
  let effortSupported = true;

  return {
    async reply(context: ReplyContext, { signal, feedback, onUsage }): Promise<ModelReply> {
      const prompt = buildPrompt(context, feedback);
      const params = (withEffort: boolean): Record<string, unknown> => ({
        model: opts.model,
        instructions: prompt.system.join('\n\n'),
        input: prompt.messages.map((turn) => ({ role: turn.role, content: turn.content })),
        max_output_tokens: MAX_TOKENS,
        text: {
          format: { type: 'json_schema', name: FORMAT_NAME, strict: true, schema },
        },
        // R9: no se marca nada de caché. OpenAI tiene caché automática y no hay nada que marcar.
        ...(withEffort ? { reasoning: { effort: opts.effort } } : {}),
      });
      // FR-020: el plazo y los reintentos son del dominio. La señal de aborto que recibe `reply` se
      // propaga, y la política de reintentos del SDK se desactiva, para que los dos intentos del
      // responder sigan compartiendo un único presupuesto.
      const options = { signal, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 };

      let response: OpenAiResponse;
      try {
        response = await client.responses.create(params(effortSupported), options);
      } catch (error) {
        if (effortSupported && rejectsEffort(error)) {
          effortSupported = false;
          log(
            'El modelo configurado no admite el ajuste de esfuerzo: se deja de enviar en lo que ' +
              'queda de vida del proceso. LLM_EFFORT no se rechaza ni se silencia (FR-017).',
          );
          try {
            response = await client.responses.create(params(false), options);
          } catch (retryError) {
            throw toChatModelError(retryError, signal);
          }
        } else {
          throw toChatModelError(error, signal);
        }
      }

      // Hay respuesta: sus tokens cuentan aunque se descarte después (010, R1).
      reportUsage(openAiTokenUsage(response.usage), onUsage);

      const content = (response.output ?? []).flatMap((item) => item.content ?? []);
      // R10, la trampa: el rechazo llega como un elemento de contenido y **el estado sigue siendo
      // `completed`**. Un adaptador que mire solo el estado lo tomará por una respuesta válida
      // vacía, y el cliente final recibirá algo sin sentido.
      if (content.some((part) => part.type === 'refusal')) throw new ChatModelError('refusal');
      if (response.status !== undefined && response.status !== 'completed') {
        // Truncada por el tope de salida, filtrada o incompleta: no es un rechazo.
        throw new ChatModelError('invalid_output');
      }
      const text = content
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text ?? '')
        .join('');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new ChatModelError('invalid_output');
      }
      const parsed = modelReplySchema.safeParse(normalizeNulls(json));
      if (!parsed.success) throw new ChatModelError('invalid_output');
      return parsed.data;
    },
  };
}

/** `true` si el proveedor rechazó la petición por no admitir el parámetro de esfuerzo. */
function rejectsEffort(error: unknown): boolean {
  if (!(error instanceof OpenAI.BadRequestError)) return false;
  const text = JSON.stringify(error.error ?? error.message);
  return text.includes('reasoning') || text.includes('effort');
}

export function toChatModelError(error: unknown, signal: AbortSignal): ChatModelError {
  if (error instanceof ChatModelError) return error;
  if (signal.aborted || error instanceof OpenAI.APIConnectionTimeoutError) {
    return new ChatModelError('timeout');
  }
  if (error instanceof OpenAI.APIUserAbortError) return new ChatModelError('timeout');
  if (error instanceof OpenAI.APIError) {
    const status: unknown = error.status;
    return new ChatModelError('api_error', typeof status === 'number' ? status : undefined);
  }
  return new ChatModelError('api_error');
}
