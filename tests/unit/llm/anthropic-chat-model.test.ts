import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { ChatModelError } from '../../../src/conversation/ports.js';
import {
  createAnthropicChatModel,
  replyJsonSchema,
} from '../../../src/llm/anthropic-chat-model.js';
import { replyContext } from '../../helpers/snapshot.js';

const validReply = {
  body: 'Abrimos de 9:00 a 14:00.',
  handoffRequested: false,
  offerContact: false,
  bookingRequested: false,
  needsRephrase: false,
  mentionedServiceIds: [],
};

function message(overrides: Partial<Anthropic.Message> & { text?: string } = {}) {
  const { text = JSON.stringify(validReply), ...rest } = overrides;
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text, citations: null }],
    ...rest,
  } as unknown as Anthropic.Message;
}

function modelWith(result: Anthropic.Message | Error) {
  const create = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const model = createAnthropicChatModel({
    model: 'claude-sonnet-5',
    effort: 'medium',
    client: { messages: { create } } as unknown as Pick<Anthropic, 'messages'>,
  });
  return { model, create };
}

const signal = () => new AbortController().signal;

describe('ChatModel de Anthropic', () => {
  it('forma de la petición: modelo, esfuerzo, formato, caché y orden de bloques', async () => {
    const { model, create } = modelWith(message());
    const s = signal();
    await expect(model.reply(replyContext(), { signal: s })).resolves.toEqual(validReply);

    const [params, options] = create.mock.calls[0] as unknown as [
      Anthropic.MessageCreateParamsNonStreaming,
      { signal: AbortSignal; timeout: number; maxRetries: number },
    ];
    expect(params.model).toBe('claude-sonnet-5');
    expect(params.max_tokens).toBe(4000);
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.output_config).toEqual({
      effort: 'medium',
      format: { type: 'json_schema', schema: replyJsonSchema() },
    });
    expect(params.stream).toBeUndefined();
    const system = params.system as Anthropic.TextBlockParam[];
    expect(system).toHaveLength(2);
    expect(system[0]?.text).toContain('asistente automático');
    expect(system[1]?.text).toMatch(/^DATOS_DEL_NEGOCIO/);
    for (const block of system) expect(block.cache_control).toEqual({ type: 'ephemeral' });
    expect(params.messages.at(-1)?.role).toBe('user');
    expect(options).toMatchObject({ signal: s, timeout: 12_000, maxRetries: 1 });
  });

  it('el JSON Schema no lleva restricciones de longitud y cierra los objetos', () => {
    const schema = replyJsonSchema();
    expect(JSON.stringify(schema)).not.toContain('maxLength');
    expect(schema).not.toHaveProperty('$schema');
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it.each<[string, Anthropic.Message | Error, string, number?]>([
    ['refusal', message({ stop_reason: 'refusal' }), 'refusal'],
    ['max_tokens', message({ stop_reason: 'max_tokens' }), 'invalid_output'],
    ['JSON inválido', message({ text: '{"body": ' }), 'invalid_output'],
    [
      'esquema incumplido',
      message({ text: JSON.stringify({ ...validReply, body: 'x'.repeat(1501) }) }),
      'invalid_output',
    ],
    ['timeout', new Anthropic.APIConnectionTimeoutError(), 'timeout'],
    [
      'error HTTP',
      new Anthropic.InternalServerError(529, { error: 'overloaded' }, 'overloaded', new Headers()),
      'api_error',
      529,
    ],
  ])('%s → ChatModelError', async (_name, result, reason, status) => {
    const { model } = modelWith(result);
    const error = await model.reply(replyContext(), { signal: signal() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatModelError);
    expect(error).toMatchObject({ reason, ...(status === undefined ? {} : { status }) });
  });

  it('una cancelación del llamante es timeout', async () => {
    const controller = new AbortController();
    controller.abort();
    const { model } = modelWith(new Anthropic.APIUserAbortError());
    await expect(model.reply(replyContext(), { signal: controller.signal })).rejects.toMatchObject({
      reason: 'timeout',
    });
  });
});
