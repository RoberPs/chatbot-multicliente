/**
 * Batería **común a los tres proveedores** (017, FR-014 – FR-016, FR-020;
 * contracts/llm-provider.md §3.3).
 *
 * El valor de este fichero está en que los tres pasan por el mismo guion. Las cuatro causas de
 * fallo del dominio son una tabla cerrada, y lo que cada proveedor señala de una manera distinta
 * —un rechazo, una respuesta truncada, un plazo agotado— tiene que acabar en la misma causa. Si un
 * adaptador se desvía, el responder tomará decisiones distintas según quién esté detrás, y eso es
 * exactamente lo que la costura existe para impedir.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ApiError } from '@google/genai';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { ChatModelError, type ChatModel } from '../../../src/conversation/ports.js';
import { createChatModel } from '../../../src/llm/factory.js';
import { LLM_PROVIDERS, type LlmProvider } from '../../../src/llm/provider.js';
import {
  AnthropicDouble,
  anthropicMessage,
  anthropicRefusal,
} from '../../fixtures/llm/anthropic-double.js';
import {
  GeminiDouble,
  geminiCandidateBlocked,
  geminiPromptBlocked,
  geminiResponse,
  geminiTruncated,
} from '../../fixtures/llm/gemini-double.js';
import {
  OpenAiDouble,
  openaiRefusal,
  openaiResponse,
  openaiTruncated,
} from '../../fixtures/llm/openai-double.js';
import { replyContext } from '../../helpers/snapshot.js';

const VALID_REPLY = {
  body: 'Abrimos de 9:00 a 14:00.',
  handoffRequested: false,
  offerContact: false,
  bookingRequested: false,
  needsRephrase: false,
  mentionedServiceIds: [],
};

/** Campos de la derivación (005) con su valor por defecto del dominio. */
const HANDOFF_DEFAULTS = {
  complaint: false,
  acceptsHandoff: false,
  refusesContact: false,
  contactName: null,
  contactPhone: null,
};

const MODELO = 'modelo-de-prueba';

/** Un doble de proveedor con el mismo guion para los tres. */
interface Doble {
  /** Modelo ya construido por la fábrica sobre este doble. */
  model: ChatModel;
  /** Peticiones que el adaptador ha hecho al proveedor. */
  peticiones: () => number;
  valida: (text?: string) => void;
  /** La señal de rechazo **propia** de este proveedor. */
  rechazo: () => void;
  /** Respuesta cortada por el tope de salida. */
  truncada: () => void;
  /** Respuesta que no es JSON. */
  noEsJson: () => void;
  plazoAgotado: () => void;
  falloApi: (status: number) => void;
  /** Lo que el adaptador pasó como señal de aborto, si lo pasó. */
  senal: () => AbortSignal | undefined;
  /** Política de reintentos que el adaptador pidió al SDK, si la pidió. */
  reintentos: () => unknown;
}

function construir(provider: LlmProvider, client: unknown): ChatModel {
  return createChatModel(provider, { model: MODELO, effort: 'medium', client });
}

const ESCENARIOS: Record<LlmProvider, () => Doble> = {
  anthropic: () => {
    const d = new AnthropicDouble();
    return {
      model: construir('anthropic', d.client),
      peticiones: () => d.calls.length,
      valida: (text = JSON.stringify(VALID_REPLY)) => d.queue(anthropicMessage({ text })),
      rechazo: () => d.queue(anthropicRefusal()),
      truncada: () => d.queue(anthropicMessage({ text: '{"body": ', stop_reason: 'max_tokens' })),
      noEsJson: () => d.queue(anthropicMessage({ text: 'no soy json' })),
      plazoAgotado: () => d.queue(new Anthropic.APIConnectionTimeoutError()),
      falloApi: (status) =>
        d.queue(new Anthropic.APIError(status, { error: { message: 'x' } }, 'x', undefined)),
      senal: () => d.calls[0]?.options?.signal,
      reintentos: () => d.calls[0]?.options?.maxRetries,
    };
  },
  gemini: () => {
    const d = new GeminiDouble();
    return {
      model: construir('gemini', d.client),
      peticiones: () => d.calls.length,
      valida: (text = JSON.stringify(VALID_REPLY)) => d.queue(geminiResponse({ text })),
      // Gemini tiene dos señales de rechazo (R10); aquí la del prompt, y la del candidato en su
      // propio test más abajo.
      rechazo: () => d.queue(geminiPromptBlocked()),
      truncada: () => d.queue(geminiTruncated()),
      noEsJson: () => d.queue(geminiResponse({ text: 'no soy json' })),
      plazoAgotado: () => d.queue(Object.assign(new Error('abort'), { name: 'AbortError' })),
      falloApi: (status) => d.queue(new ApiError({ message: 'x', status })),
      senal: () => {
        const signal = d.calls[0]?.config?.abortSignal;
        return signal instanceof AbortSignal ? signal : undefined;
      },
      reintentos: () => (d.calls[0]?.config?.httpOptions as { retryOptions?: unknown } | undefined)
        ?.retryOptions,
    };
  },
  openai: () => {
    const d = new OpenAiDouble();
    return {
      model: construir('openai', d.client),
      peticiones: () => d.calls.length,
      valida: (text = JSON.stringify(VALID_REPLY)) => d.queue(openaiResponse({ text })),
      rechazo: () => d.queue(openaiRefusal()),
      truncada: () => d.queue(openaiTruncated()),
      noEsJson: () => d.queue(openaiResponse({ text: 'no soy json' })),
      plazoAgotado: () => d.queue(new OpenAI.APIConnectionTimeoutError({ message: 'timeout' })),
      falloApi: (status) =>
        d.queue(new OpenAI.APIError(status, { error: { message: 'x' } }, 'x', undefined)),
      senal: () => d.calls[0]?.options?.signal,
      reintentos: () => d.calls[0]?.options?.maxRetries,
    };
  },
};

const signal = () => new AbortController().signal;

async function causaDe(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ChatModelError) return error.reason;
    return `no es ChatModelError: ${String(error)}`;
  }
  return 'no lanzó';
}

describe.each(LLM_PROVIDERS)('ChatModel de %s', (provider) => {
  const escenario = ESCENARIOS[provider];

  it('una respuesta válida se devuelve con los valores por defecto del dominio', async () => {
    const d = escenario();
    d.valida();
    await expect(d.model.reply(replyContext(), { signal: signal() })).resolves.toEqual({
      ...VALID_REPLY,
      ...HANDOFF_DEFAULTS,
    });
  });

  it('una respuesta que no es JSON → invalid_output', async () => {
    const d = escenario();
    d.noEsJson();
    expect(await causaDe(d.model.reply(replyContext(), { signal: signal() }))).toBe(
      'invalid_output',
    );
  });

  it('una respuesta que no valida con Zod → invalid_output', async () => {
    const d = escenario();
    // `body` pasa del máximo que el esquema del dominio admite: la puerta es Zod (FR-014).
    d.valida(JSON.stringify({ ...VALID_REPLY, body: 'x'.repeat(1501) }));
    expect(await causaDe(d.model.reply(replyContext(), { signal: signal() }))).toBe(
      'invalid_output',
    );
  });

  it('una respuesta truncada por el tope de salida → invalid_output', async () => {
    const d = escenario();
    d.truncada();
    expect(await causaDe(d.model.reply(replyContext(), { signal: signal() }))).toBe(
      'invalid_output',
    );
  });

  it('la señal propia de rechazo del proveedor → refusal', async () => {
    const d = escenario();
    d.rechazo();
    expect(await causaDe(d.model.reply(replyContext(), { signal: signal() }))).toBe('refusal');
  });

  it('el plazo agotado → timeout', async () => {
    const d = escenario();
    d.plazoAgotado();
    expect(await causaDe(d.model.reply(replyContext(), { signal: signal() }))).toBe('timeout');
  });

  it('cualquier otro fallo del proveedor → api_error con su código', async () => {
    const d = escenario();
    d.falloApi(529);
    try {
      await d.model.reply(replyContext(), { signal: signal() });
      throw new Error('se esperaba un fallo');
    } catch (error) {
      expect(error).toBeInstanceOf(ChatModelError);
      expect((error as ChatModelError).reason).toBe('api_error');
      expect((error as ChatModelError).status).toBe(529);
    }
  });

  // T029a (FR-020). El plazo y los reintentos son **del dominio**: los dos intentos del responder
  // comparten un único presupuesto. Un SDK que reintentara por su cuenta lo rompería sin que se
  // notase, así que aquí se comprueba que cada `reply` es **una** petición y nada más.
  it('abortar la señal del dominio corta la petición y produce timeout', async () => {
    const d = escenario();
    d.valida();
    const controller = new AbortController();
    controller.abort();
    expect(await causaDe(d.model.reply(replyContext(), { signal: controller.signal }))).toBe(
      'timeout',
    );
  });

  it('propaga la señal de aborto que recibe', async () => {
    const d = escenario();
    d.valida();
    const s = signal();
    await d.model.reply(replyContext(), { signal: s });
    expect(d.senal()).toBe(s);
  });

  it('no reintenta por su cuenta: una petición fallida deja exactamente un intento', async () => {
    const d = escenario();
    d.falloApi(500);
    await causaDe(d.model.reply(replyContext(), { signal: signal() }));
    expect(d.peticiones()).toBe(1);
  });

  it('desactiva la política de reintentos propia del SDK', async () => {
    const d = escenario();
    d.valida();
    await d.model.reply(replyContext(), { signal: signal() });
    const reintentos = d.reintentos();
    // En los SDK con `maxRetries` es 0; en Gemini, `retryOptions.attempts` es 1 (un intento).
    if (typeof reintentos === 'number') expect(reintentos).toBe(0);
    else expect(reintentos).toMatchObject({ attempts: 1 });
  });
});

describe('señales propias de cada proveedor', () => {
  it('Gemini: el bloqueo del candidato también es un rechazo (R10)', async () => {
    const d = new GeminiDouble();
    d.queue(geminiCandidateBlocked('SAFETY'));
    const model = construir('gemini', d.client);
    expect(await causaDe(model.reply(replyContext(), { signal: signal() }))).toBe('refusal');
  });

  // La trampa de R10: el rechazo de OpenAI llega con el estado en `completed`. Un adaptador que
  // mire solo el estado lo tomará por una respuesta válida vacía y el cliente final recibirá algo
  // sin sentido. Este test es el que no deja que eso pase inadvertido.
  it('OpenAI: el rechazo llega con el estado en completed y aun así es refusal', async () => {
    const d = new OpenAiDouble();
    const rechazo = openaiRefusal();
    expect(rechazo.status).toBe('completed');
    d.queue(rechazo);
    const model = construir('openai', d.client);
    expect(await causaDe(model.reply(replyContext(), { signal: signal() }))).toBe('refusal');
  });

  // La vuelta del dialecto estricto (R7): OpenAI devuelve `null` donde el dominio esperaba
  // «ausente», y el adaptador tiene que normalizarlo para que los valores por defecto se apliquen
  // igual que con los otros dos.
  it('OpenAI: los null de los campos promovidos se normalizan a ausente', async () => {
    const d = new OpenAiDouble();
    d.queue(
      openaiResponse({
        text: JSON.stringify({
          ...VALID_REPLY,
          complaint: null,
          acceptsHandoff: null,
          refusesContact: null,
          contactName: null,
          contactPhone: null,
        }),
      }),
    );
    const model = construir('openai', d.client);
    await expect(model.reply(replyContext(), { signal: signal() })).resolves.toEqual({
      ...VALID_REPLY,
      ...HANDOFF_DEFAULTS,
    });
  });

  it('OpenAI: un valor presente en un campo promovido se conserva', async () => {
    const d = new OpenAiDouble();
    d.queue(
      openaiResponse({
        text: JSON.stringify({
          ...VALID_REPLY,
          complaint: true,
          acceptsHandoff: true,
          refusesContact: null,
          contactName: 'Lucía',
          contactPhone: null,
        }),
      }),
    );
    const model = construir('openai', d.client);
    await expect(model.reply(replyContext(), { signal: signal() })).resolves.toMatchObject({
      complaint: true,
      acceptsHandoff: true,
      refusesContact: false,
      contactName: 'Lucía',
      contactPhone: null,
    });
  });
});

describe('la fábrica (regla C5)', () => {
  it('un proveedor no elegible falla antes de construir nada, con los tres nombres', () => {
    expect(() =>
      createChatModel('mistral' as LlmProvider, { model: MODELO, effort: 'medium' }),
    ).toThrow(/anthropic.*gemini.*openai/);
  });
});
