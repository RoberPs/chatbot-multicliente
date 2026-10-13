/**
 * Extracción del consumo por proveedor (017, FR-022 – FR-024, R11).
 *
 * Aquí viven las dos reglas más fáciles de romper de la feature, y las dos se rompen en silencio:
 *
 * - **Gemini informa los tokens de razonamiento aparte.** No sumarlos subestima el consumo de
 *   salida, y el tope de gasto acaba protegiendo menos de lo que cree.
 * - **`null` sale de la capacidad del proveedor, nunca de un campo ausente.** Una respuesta de
 *   Anthropic que no escribió caché llega con el campo ausente, y eso es un **cero medido**. Si se
 *   mapeara a `null`, el panel diría «sin dato» de un proveedor que sí informa.
 */
import { describe, expect, it } from 'vitest';
import { createChatModel } from '../../../src/llm/factory.js';
import { LLM_PROVIDERS, type LlmProvider } from '../../../src/llm/provider.js';
import type { TokenUsage } from '../../../src/usage/types.js';
import {
  AnthropicDouble,
  anthropicMessage,
  anthropicUsage,
} from '../../fixtures/llm/anthropic-double.js';
import { GeminiDouble, geminiResponse, geminiUsage } from '../../fixtures/llm/gemini-double.js';
import { OpenAiDouble, openaiResponse, openaiUsage } from '../../fixtures/llm/openai-double.js';
import { replyContext } from '../../helpers/snapshot.js';

const VALID_REPLY = JSON.stringify({
  body: 'Abrimos de 9:00 a 14:00.',
  handoffRequested: false,
  offerContact: false,
  bookingRequested: false,
  needsRephrase: false,
  mentionedServiceIds: [],
});

const MODELO = 'modelo-de-prueba';
const signal = () => new AbortController().signal;

/** Pide una respuesta al adaptador del proveedor y devuelve lo que informó por `onUsage`. */
async function consumoDe(
  provider: LlmProvider,
  programar: (d: AnthropicDouble | GeminiDouble | OpenAiDouble) => void,
): Promise<TokenUsage | null> {
  const d =
    provider === 'anthropic'
      ? new AnthropicDouble()
      : provider === 'gemini'
        ? new GeminiDouble()
        : new OpenAiDouble();
  programar(d);
  const model = createChatModel(provider, {
    model: MODELO,
    effort: 'medium',
    client: (d as { client: unknown }).client,
  });
  let informado: TokenUsage | null = null;
  let veces = 0;
  await model.reply(replyContext(), {
    signal: signal(),
    onUsage(usage) {
      veces += 1;
      informado = usage;
    },
  });
  expect(veces).toBeLessThanOrEqual(1);
  return informado;
}

describe('consumo de Anthropic', () => {
  it('los cuatro conceptos, con el razonamiento ya dentro de los tokens de salida', async () => {
    const usage = await consumoDe('anthropic', (d) =>
      (d as AnthropicDouble).queue(
        anthropicMessage({ text: VALID_REPLY, usage: anthropicUsage(1200, 300, 500, 800) }),
      ),
    );
    expect(usage).toEqual({ input: 1200, output: 300, cacheWrite: 500, cacheRead: 800 });
  });

  // T030a. La regla que más fácil es romper: el campo ausente es un CERO MEDIDO, no un «sin dato».
  it('una respuesta sin escritura de caché registra 0, NO null', async () => {
    const usage = await consumoDe('anthropic', (d) =>
      (d as AnthropicDouble).queue(
        anthropicMessage({ text: VALID_REPLY, usage: anthropicUsage(1200, 300) }),
      ),
    );
    expect(usage?.cacheWrite).toBe(0);
    expect(usage?.cacheWrite).not.toBeNull();
    expect(usage?.cacheRead).toBe(0);
  });

  it('sin información de consumo no llama a onUsage', async () => {
    const usage = await consumoDe('anthropic', (d) =>
      (d as AnthropicDouble).queue(anthropicMessage({ text: VALID_REPLY })),
    );
    expect(usage).toBeNull();
  });
});

describe('consumo de Gemini', () => {
  // La trampa de R11: `thoughtsTokenCount` NO está dentro de `candidatesTokenCount`.
  it('suma los tokens de razonamiento a los de salida', async () => {
    const usage = await consumoDe('gemini', (d) =>
      (d as GeminiDouble).queue(
        geminiResponse({ text: VALID_REPLY, usage: geminiUsage(1200, 300, 450, 800) }),
      ),
    );
    expect(usage?.output).toBe(750);
    expect(usage?.input).toBe(1200);
    expect(usage?.cacheRead).toBe(800);
  });

  it('sin tokens de razonamiento la salida es la de los candidatos', async () => {
    const usage = await consumoDe('gemini', (d) =>
      (d as GeminiDouble).queue(
        geminiResponse({ text: VALID_REPLY, usage: geminiUsage(1200, 300) }),
      ),
    );
    expect(usage?.output).toBe(300);
  });

  // T030a, la contraria: Gemini no informa del concepto NUNCA, ni cuando sí hubo lectura.
  it('la escritura de caché es null siempre, también con lectura de caché informada', async () => {
    for (const u of [geminiUsage(1200, 300), geminiUsage(1200, 300, 0, 900)]) {
      const usage = await consumoDe('gemini', (d) =>
        (d as GeminiDouble).queue(geminiResponse({ text: VALID_REPLY, usage: u })),
      );
      expect(usage?.cacheWrite).toBeNull();
    }
  });

  it('sin información de consumo no llama a onUsage', async () => {
    const usage = await consumoDe('gemini', (d) =>
      (d as GeminiDouble).queue(geminiResponse({ text: VALID_REPLY })),
    );
    expect(usage).toBeNull();
  });
});

describe('consumo de OpenAI', () => {
  // Los tokens de razonamiento ya van DENTRO de `output_tokens`: no se suman dos veces.
  it('no suma el razonamiento dos veces', async () => {
    const usage = await consumoDe('openai', (d) =>
      (d as OpenAiDouble).queue(
        openaiResponse({ text: VALID_REPLY, usage: openaiUsage(1200, 300, 500, 800, 180) }),
      ),
    );
    expect(usage?.output).toBe(300);
  });

  /**
   * **Corregido respecto a R11.** La investigación daba por hecho que OpenAI no informa de la
   * escritura de caché, y es falso con `openai` 7.32.0: `input_tokens_details.cache_write_tokens`
   * está declarado, y no opcional. Informar `null` de un concepto que el proveedor sí mide sería
   * el error de FR-024 en su versión espejo.
   */
  it('informa de la escritura de caché: es un número, no null', async () => {
    const usage = await consumoDe('openai', (d) =>
      (d as OpenAiDouble).queue(
        openaiResponse({ text: VALID_REPLY, usage: openaiUsage(1200, 300, 500, 800) }),
      ),
    );
    expect(usage).toEqual({ input: 1200, output: 300, cacheWrite: 500, cacheRead: 800 });
    expect(usage?.cacheWrite).not.toBeNull();
  });

  it('sin información de consumo no llama a onUsage', async () => {
    const usage = await consumoDe('openai', (d) =>
      (d as OpenAiDouble).queue(openaiResponse({ text: VALID_REPLY })),
    );
    expect(usage).toBeNull();
  });
});

describe('la tabla de capacidades, vista desde el consumo', () => {
  it('los tres informan de la lectura de caché', async () => {
    const lecturas: Array<number | null | undefined> = [];
    lecturas.push(
      (
        await consumoDe('anthropic', (d) =>
          (d as AnthropicDouble).queue(
            anthropicMessage({ text: VALID_REPLY, usage: anthropicUsage(1, 1, 0, 700) }),
          ),
        )
      )?.cacheRead,
    );
    lecturas.push(
      (
        await consumoDe('gemini', (d) =>
          (d as GeminiDouble).queue(
            geminiResponse({ text: VALID_REPLY, usage: geminiUsage(1, 1, 0, 700) }),
          ),
        )
      )?.cacheRead,
    );
    lecturas.push(
      (
        await consumoDe('openai', (d) =>
          (d as OpenAiDouble).queue(
            openaiResponse({ text: VALID_REPLY, usage: openaiUsage(1, 1, 0, 700) }),
          ),
        )
      )?.cacheRead,
    );
    expect(lecturas).toEqual([700, 700, 700]);
  });

  it('solo Gemini deja la escritura de caché sin dato', async () => {
    const escrituras = new Map<LlmProvider, number | null | undefined>();
    escrituras.set(
      'anthropic',
      (
        await consumoDe('anthropic', (d) =>
          (d as AnthropicDouble).queue(
            anthropicMessage({ text: VALID_REPLY, usage: anthropicUsage(1, 1, 0, 0) }),
          ),
        )
      )?.cacheWrite,
    );
    escrituras.set(
      'gemini',
      (
        await consumoDe('gemini', (d) =>
          (d as GeminiDouble).queue(
            geminiResponse({ text: VALID_REPLY, usage: geminiUsage(1, 1) }),
          ),
        )
      )?.cacheWrite,
    );
    escrituras.set(
      'openai',
      (
        await consumoDe('openai', (d) =>
          (d as OpenAiDouble).queue(
            openaiResponse({ text: VALID_REPLY, usage: openaiUsage(1, 1, 0, 0) }),
          ),
        )
      )?.cacheWrite,
    );
    for (const provider of LLM_PROVIDERS) {
      if (provider === 'gemini') expect(escrituras.get(provider)).toBeNull();
      else expect(escrituras.get(provider)).toBe(0);
    }
  });
});
