/** Resumidor de Anthropic: forma de la respuesta y `onUsage` (005 R4, 010 R1). */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createAnthropicSummarizer } from '../../../src/llm/anthropic-summarizer.js';

const usage = {
  input_tokens: 300,
  output_tokens: 40,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
} as unknown as Anthropic.Usage;
const expected = { input: 300, output: 40, cacheWrite: 0, cacheRead: 0 };

function message(overrides: Partial<Anthropic.Message> & { text?: string } = {}) {
  const { text = JSON.stringify({ summary: 'Quiere cambiar la cita.' }), ...rest } = overrides;
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text, citations: null }],
    usage,
    ...rest,
  } as unknown as Anthropic.Message;
}

function summarizerWith(result: Anthropic.Message | Error) {
  const create = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const summarizer = createAnthropicSummarizer({
    model: 'claude-sonnet-5-5',
    client: { messages: { create } } as unknown as Pick<Anthropic, 'messages'>,
  });
  return { summarizer, create };
}

const input = { kind: 'person' as const, customerTexts: ['Quiero hablar con alguien'] };
const signal = () => new AbortController().signal;

describe('resumidor de Anthropic', () => {
  it('devuelve el resumen y llama a onUsage una vez con los tokens mapeados', async () => {
    const { summarizer } = summarizerWith(message());
    const onUsage = vi.fn();
    await expect(summarizer.summarize(input, { signal: signal(), onUsage })).resolves.toEqual({
      summary: 'Quiere cambiar la cita.',
    });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(expected);
  });

  it.each<[string, Anthropic.Message]>([
    ['refusal', message({ stop_reason: 'refusal' })],
    ['max_tokens', message({ stop_reason: 'max_tokens' })],
    ['JSON inválido', message({ text: '{"summary": ' })],
    ['esquema incumplido', message({ text: JSON.stringify({ summary: 3 }) })],
  ])('respuesta descartada (%s): onUsage una vez y antes de lanzar', async (_name, result) => {
    const { summarizer } = summarizerWith(result);
    const order: string[] = [];
    const onUsage = vi.fn(() => order.push('usage'));
    await summarizer
      .summarize(input, { signal: signal(), onUsage })
      .catch(() => order.push('throw'));
    expect(onUsage).toHaveBeenCalledWith(expected);
    expect(order).toEqual(['usage', 'throw']);
  });

  it.each<[string, Error]>([
    ['timeout', new Anthropic.APIConnectionTimeoutError()],
    ['corte', new Anthropic.APIConnectionError({ message: 'corte' })],
    [
      'error HTTP',
      new Anthropic.InternalServerError(529, { error: 'overloaded' }, 'overloaded', new Headers()),
    ],
    ['abortado', new Anthropic.APIUserAbortError()],
  ])('sin respuesta (%s): lanza y nunca llama a onUsage', async (_name, error) => {
    const { summarizer } = summarizerWith(error);
    const onUsage = vi.fn();
    await expect(summarizer.summarize(input, { signal: signal(), onUsage })).rejects.toThrow();
    expect(onUsage).not.toHaveBeenCalled();
  });
});
