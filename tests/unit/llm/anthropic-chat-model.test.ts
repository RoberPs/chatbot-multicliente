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

/** Campos de la derivación (005) con su valor por defecto. */
const handoffDefaults = {
  complaint: false,
  acceptsHandoff: false,
  refusesContact: false,
  contactName: null,
  contactPhone: null,
};

function message(overrides: Partial<Anthropic.Message> & { text?: string } = {}) {
  const { text = JSON.stringify(validReply), ...rest } = overrides;
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
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
    model: 'claude-sonnet-5-5',
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
    await expect(model.reply(replyContext(), { signal: s })).resolves.toEqual({
      ...validReply,
      ...handoffDefaults,
    });

    const [params, options] = create.mock.calls[0] as unknown as [
      Anthropic.MessageCreateParamsNonStreaming,
      { signal: AbortSignal; timeout: number; maxRetries: number },
    ];
    expect(params.model).toBe('claude-sonnet-5-5');
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
    expect(JSON.stringify(schema)).not.toContain('"default"');
    expect(schema).not.toHaveProperty('$schema');
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('los campos de la derivación están en el esquema pero no son obligatorios', () => {
    const schema = replyJsonSchema() as { properties: object; required: string[] };
    for (const field of Object.keys(handoffDefaults)) {
      expect(schema.properties).toHaveProperty(field);
      expect(schema.required).not.toContain(field);
    }
    expect(schema.required).toContain('handoffRequested');
  });

  it('salida sin los campos de la derivación → valores por defecto', async () => {
    const { model } = modelWith(message());
    await expect(model.reply(replyContext(), { signal: signal() })).resolves.toMatchObject(
      handoffDefaults,
    );
  });

  it('salida con los campos de la derivación → se conservan', async () => {
    const withHandoff = {
      ...validReply,
      complaint: true,
      acceptsHandoff: true,
      refusesContact: false,
      contactName: 'Lucía',
      contactPhone: '611 22 23 33',
    };
    const { model } = modelWith(message({ text: JSON.stringify(withHandoff) }));
    await expect(model.reply(replyContext(), { signal: signal() })).resolves.toEqual(withHandoff);
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

  describe('onUsage (010, R1)', () => {
    const usage = {
      input_tokens: 1200,
      output_tokens: 350,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: 900,
    } as unknown as Anthropic.Usage;
    const expected = { input: 1200, output: 350, cacheWrite: 0, cacheRead: 900 };

    it('respuesta válida: una vez, con los tokens mapeados (caché nula → 0)', async () => {
      const { model } = modelWith(message({ usage }));
      const onUsage = vi.fn();
      await model.reply(replyContext(), { signal: signal(), onUsage });
      expect(onUsage).toHaveBeenCalledTimes(1);
      expect(onUsage).toHaveBeenCalledWith(expected);
    });

    it('con escritura en caché', async () => {
      const withWrite = { ...usage, cache_creation_input_tokens: 2048 } as Anthropic.Usage;
      const { model } = modelWith(message({ usage: withWrite }));
      const onUsage = vi.fn();
      await model.reply(replyContext(), { signal: signal(), onUsage });
      expect(onUsage).toHaveBeenCalledWith({ ...expected, cacheWrite: 2048 });
    });

    it.each<[string, Anthropic.Message]>([
      ['refusal', message({ stop_reason: 'refusal', usage })],
      ['max_tokens', message({ stop_reason: 'max_tokens', usage })],
      ['JSON inválido', message({ text: '{"body": ', usage })],
      [
        'esquema incumplido',
        message({ text: JSON.stringify({ ...validReply, body: 'x'.repeat(1501) }), usage }),
      ],
    ])('respuesta descartada (%s): una vez y antes de lanzar', async (_name, result) => {
      const { model } = modelWith(result);
      const order: string[] = [];
      const onUsage = vi.fn(() => order.push('usage'));
      await model
        .reply(replyContext(), { signal: signal(), onUsage })
        .catch(() => order.push('throw'));
      expect(onUsage).toHaveBeenCalledTimes(1);
      expect(onUsage).toHaveBeenCalledWith(expected);
      expect(order).toEqual(['usage', 'throw']);
    });

    it.each<[string, Error]>([
      ['timeout', new Anthropic.APIConnectionTimeoutError()],
      ['corte', new Anthropic.APIConnectionError({ message: 'corte' })],
      [
        'error HTTP',
        new Anthropic.InternalServerError(
          529,
          { error: 'overloaded' },
          'overloaded',
          new Headers(),
        ),
      ],
      ['abortado', new Anthropic.APIUserAbortError()],
    ])('sin respuesta (%s): nunca', async (_name, error) => {
      const { model } = modelWith(error);
      const onUsage = vi.fn();
      await expect(
        model.reply(replyContext(), { signal: signal(), onUsage }),
      ).rejects.toBeInstanceOf(ChatModelError);
      expect(onUsage).not.toHaveBeenCalled();
    });

    it('sin receptor no falla', async () => {
      const { model } = modelWith(message({ usage }));
      await expect(model.reply(replyContext(), { signal: signal() })).resolves.toBeDefined();
    });
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
