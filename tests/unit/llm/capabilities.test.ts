/**
 * Una prueba por fila de la tabla de capacidades y por proveedor (017, FR-021, T068;
 * data-model.md §1).
 *
 * El objetivo no es cubrir código: es que **la documentación y el código no puedan separarse**.
 * Hay tres piezas que dicen lo mismo —`src/llm/capabilities.ts`, los tres adaptadores y la tabla
 * de `docs/operacion-multicliente.md`— y este fichero las ata:
 *
 * 1. La tabla publicada se compara, celda a celda, con la que genera el código.
 * 2. Cada fila se comprueba **contra el comportamiento real** del adaptador, con los dobles.
 *
 * Así, cambiar un adaptador sin actualizar la declaración y el documento rompe la suite, que es lo
 * que FR-021 pide: que ninguna diferencia entre proveedores quede sin escribir.
 */
import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChatModel } from '../../../src/conversation/ports.js';
import type { TokenUsage } from '../../../src/usage/types.js';
import {
  capabilityTableMarkdown,
  CAPABILITY_TABLE,
  PROVIDER_CAPABILITIES,
} from '../../../src/llm/capabilities.js';
import { createChatModel } from '../../../src/llm/factory.js';
import { replyJsonSchema } from '../../../src/llm/reply-schema.js';
import { LLM_PROVIDERS, type LlmProvider } from '../../../src/llm/provider.js';
import {
  anthropicExpected,
  anthropicMessage,
  anthropicRefusal,
  anthropicUsage,
  AnthropicDouble,
  type AnthropicUsageShape,
} from '../../fixtures/llm/anthropic-double.js';
import {
  geminiCandidateBlocked,
  geminiExpected,
  geminiPromptBlocked,
  geminiResponse,
  geminiUsage,
  GeminiDouble,
  type GeminiUsageShape,
} from '../../fixtures/llm/gemini-double.js';
import {
  openaiExpected,
  openaiRefusal,
  openaiResponse,
  openaiUsage,
  OpenAiDouble,
  type OpenAiUsageShape,
} from '../../fixtures/llm/openai-double.js';
import { replyContext } from '../../helpers/snapshot.js';

const MODELO = 'modelo-de-prueba';
const VALID = JSON.stringify({
  body: 'Abrimos de 9:00 a 14:00.',
  handoffRequested: false,
  offerContact: false,
  bookingRequested: false,
  needsRephrase: false,
  mentionedServiceIds: [],
});
const signal = () => new AbortController().signal;

const DOC = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/operacion-multicliente.md',
);

// ---------------------------------------------------------------------------
// 1. El documento y el código dicen lo mismo
// ---------------------------------------------------------------------------

describe('la tabla publicada y la declarada no pueden separarse', () => {
  const doc = readFileSync(DOC, 'utf8');

  it('la tabla de docs/operacion-multicliente.md es exactamente la que genera el código', () => {
    expect(doc).toContain(capabilityTableMarkdown());
  });

  it('las siete filas de data-model.md §1 están, en su orden', () => {
    expect(CAPABILITY_TABLE.map((r) => r.label)).toEqual([
      'Esquema de salida obligado',
      'Mando de esfuerzo',
      'Razonamiento interno',
      'Marca explícita de caché',
      'Tokens de lectura de caché',
      'Tokens de escritura de caché',
      'Señal propia de rechazo',
    ]);
  });

  it.each(CAPABILITY_TABLE.map((r) => [r.label, r] as const))(
    'la fila «%s» tiene una celda por proveedor, ninguna vacía',
    (_label, row) => {
      for (const provider of LLM_PROVIDERS) {
        expect(row.cells[provider]).not.toBe('');
      }
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Cada fila, contra el comportamiento real del adaptador
// ---------------------------------------------------------------------------

/** Petición que el adaptador acabó enviando, en la forma de cada proveedor. */
interface Enviado {
  /** Esquema que viajó en la petición. */
  schema: unknown;
  /** Lo que se envió como mando de esfuerzo, si se envió. */
  effort: unknown;
  /** Lo que se envió sobre el razonamiento interno, si se envió. */
  reasoning: unknown;
  /** ¿Hay alguna marca explícita de caché en la petición? */
  cacheMarked: boolean;
}

interface Escenario {
  model: ChatModel;
  /** Encola una respuesta válida con el consumo indicado. */
  responde: (usage?: unknown) => void;
  /** Encola la señal propia de rechazo del proveedor. */
  rechaza: () => void;
  enviado: () => Enviado;
  /** Consumo de ejemplo del proveedor y lo que el adaptador debe deducir de él. */
  consumo: () => { usage: unknown; esperado: TokenUsage };
}

const ESCENARIOS: Record<LlmProvider, () => Escenario> = {
  anthropic: () => {
    const d = new AnthropicDouble();
    const u = anthropicUsage(1200, 300, 500, 800);
    return {
      model: createChatModel('anthropic', { model: MODELO, effort: 'medium', client: d.client }),
      responde: (usage) =>
        d.queue(
          anthropicMessage({
            text: VALID,
            ...(usage === undefined ? {} : { usage: usage as AnthropicUsageShape }),
          }),
        ),
      rechaza: () => d.queue(anthropicRefusal()),
      enviado: () => {
        const p = d.calls[0]?.params as Record<string, unknown> | undefined;
        const output = p?.output_config as
          | { effort?: unknown; format?: { schema?: unknown } }
          | undefined;
        const system = (p?.system ?? []) as Array<Record<string, unknown>>;
        return {
          schema: output?.format?.schema,
          effort: output?.effort,
          reasoning: p?.thinking,
          cacheMarked: system.some((block) => block.cache_control !== undefined),
        };
      },
      consumo: () => ({ usage: u, esperado: anthropicExpected(u) }),
    };
  },
  gemini: () => {
    const d = new GeminiDouble();
    const u = geminiUsage(1200, 300, 90, 800);
    return {
      model: createChatModel('gemini', { model: MODELO, effort: 'medium', client: d.client }),
      responde: (usage) =>
        d.queue(
          geminiResponse({
            text: VALID,
            ...(usage === undefined ? {} : { usage: usage as GeminiUsageShape }),
          }),
        ),
      rechaza: () => d.queue(geminiPromptBlocked()),
      enviado: () => {
        const config = d.calls[0]?.config ?? {};
        const thinking = config.thinkingConfig as { thinkingLevel?: unknown } | undefined;
        return {
          schema: config.responseJsonSchema,
          effort: thinking?.thinkingLevel,
          reasoning: config.thinkingConfig,
          // Gemini marcaría la caché con un contenido en caché propio: no se usa (R9).
          cacheMarked:
            config.cachedContent !== undefined || config.cached_content !== undefined,
        };
      },
      consumo: () => ({ usage: u, esperado: geminiExpected(u) }),
    };
  },
  openai: () => {
    const d = new OpenAiDouble();
    const u = openaiUsage(1200, 300, 500, 800, 40);
    return {
      model: createChatModel('openai', { model: MODELO, effort: 'medium', client: d.client }),
      responde: (usage) =>
        d.queue(
          openaiResponse({
            text: VALID,
            ...(usage === undefined ? {} : { usage: usage as OpenAiUsageShape }),
          }),
        ),
      rechaza: () => d.queue(openaiRefusal()),
      enviado: () => {
        const p = d.calls[0]?.params ?? {};
        const text = p.text as { format?: Record<string, unknown> } | undefined;
        const reasoning = p.reasoning as { effort?: unknown } | undefined;
        return {
          schema: text?.format?.schema,
          effort: reasoning?.effort,
          reasoning: p.reasoning,
          // OpenAI no tiene nada que marcar: su caché es automática (R9).
          cacheMarked: p.prompt_cache_key !== undefined,
        };
      },
      consumo: () => ({ usage: u, esperado: openaiExpected(u) }),
    };
  },
};

/** Lanza una respuesta válida y devuelve lo que el adaptador envió. */
async function enviarUna(e: Escenario): Promise<Enviado> {
  e.responde();
  await e.model.reply(replyContext(), { signal: signal() });
  return e.enviado();
}

describe.each(LLM_PROVIDERS)('capacidades declaradas de %s', (provider) => {
  const capabilities = PROVIDER_CAPABILITIES[provider];
  const escenario = () => ESCENARIOS[provider]();

  // Fila 1. El esquema viaja siempre, en el dialecto que le toca, y Zod sigue siendo la puerta.
  it('fila 1 · obliga el esquema de salida, en su dialecto', async () => {
    const enviado = await enviarUna(escenario());
    expect(enviado.schema).toEqual(replyJsonSchema(provider));
    // El modo estricto de OpenAI no admite opcionales: su dialecto promueve **todas** las
    // propiedades a requeridas, admitiendo `null`. Los dialectos tolerantes dejan opcionales.
    const schema = enviado.schema as {
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    const propiedades = Object.keys(schema.properties ?? {}).length;
    expect(propiedades).toBeGreaterThan(0);
    if (capabilities.schema === 'strict') {
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required).toHaveLength(propiedades);
    } else {
      expect((schema.required ?? []).length).toBeLessThan(propiedades);
    }
  });

  // Fila 2. `LLM_EFFORT` se traduce directo en los tres y **se envía**: no se silencia nunca.
  // Cada proveedor nombra las posiciones a su manera —Gemini las escribe en mayúsculas—, así que
  // lo que se fija es que el valor del dominio llega traducido, no su caja.
  it('fila 2 · envía el mando de esfuerzo traducido', async () => {
    const enviado = await enviarUna(escenario());
    expect(String(enviado.effort).toLowerCase()).toBe('medium');
  });

  // Fila 3. El razonamiento interno se usa donde existe, sin cambiar la forma de la respuesta.
  it('fila 3 · pide el razonamiento interno y la respuesta sigue teniendo la misma forma', async () => {
    const e = escenario();
    e.responde();
    const reply = await e.model.reply(replyContext(), { signal: signal() });
    expect(e.enviado().reasoning).toBeDefined();
    expect(reply.body).toBe('Abrimos de 9:00 a 14:00.');
  });

  // Fila 4. La marca explícita solo la tiene Anthropic, y se conserva; en los otros dos, nada.
  it('fila 4 · marca la caché explícitamente solo si la tiene', async () => {
    const enviado = await enviarUna(escenario());
    expect(enviado.cacheMarked).toBe(capabilities.explicitCacheMark);
  });

  // Filas 5 y 6. Lo que el proveedor informa de la caché, tal como lo deduce el adaptador.
  it('filas 5 y 6 · informa de la lectura de caché, y de la escritura solo si la tiene', async () => {
    const e = escenario();
    const { usage, esperado } = e.consumo();
    let medido: TokenUsage | null = null;
    e.responde(usage);
    await e.model.reply(replyContext(), {
      signal: signal(),
      onUsage: (u) => {
        medido = u;
      },
    });
    expect(medido).toEqual(esperado);
    const tokens = medido as unknown as TokenUsage;
    expect(tokens.cacheRead === null).toBe(!capabilities.reportsCacheRead);
    // La regla que más fácil es romper: `null` solo donde el proveedor **no informa** del
    // concepto. Donde sí informa, un cero es un cero medido, nunca «sin dato» (FR-024).
    expect(tokens.cacheWrite === null).toBe(!capabilities.reportsCacheWrite);
  });

  it('fila 6 · sin escritura de caché en la respuesta, quien informa registra 0 y quien no, null', async () => {
    const e = escenario();
    let medido: TokenUsage | null = null;
    // Consumo sin ningún campo de caché: lo que llega cuando esa respuesta no usó caché.
    const sinCache: Record<LlmProvider, unknown> = {
      anthropic: anthropicUsage(1200, 300),
      gemini: geminiUsage(1200, 300),
      openai: openaiUsage(1200, 300),
    };
    e.responde(sinCache[provider]);
    await e.model.reply(replyContext(), {
      signal: signal(),
      onUsage: (u) => {
        medido = u;
      },
    });
    const tokens = medido as unknown as TokenUsage;
    expect(tokens.cacheWrite).toBe(capabilities.reportsCacheWrite ? 0 : null);
  });

  // Fila 7. Tres señales distintas, una sola causa del dominio.
  it('fila 7 · su señal propia de rechazo acaba en la causa refusal', async () => {
    const e = escenario();
    e.rechaza();
    await expect(e.model.reply(replyContext(), { signal: signal() })).rejects.toMatchObject({
      reason: 'refusal',
    });
  });
});

// Gemini tiene **dos** señales de rechazo: el bloqueo del prompt y el del candidato. La tabla
// declara una sola fila, así que las dos tienen que acabar en la misma causa.
describe('fila 7 · las dos señales de rechazo de gemini', () => {
  it.each([
    ['bloqueo del prompt', geminiPromptBlocked],
    ['bloqueo del candidato', geminiCandidateBlocked],
  ])('%s → refusal', async (_name, build) => {
    const d = new GeminiDouble();
    const model = createChatModel('gemini', { model: MODELO, effort: 'medium', client: d.client });
    d.queue(build());
    await expect(model.reply(replyContext(), { signal: signal() })).rejects.toMatchObject({
      reason: 'refusal',
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Degradación declarada del esfuerzo y razonamiento interno (T069, FR-017, FR-018)
// ---------------------------------------------------------------------------

/**
 * La diferencia entre «degradado declarado» y «ajuste silenciado» es todo lo que FR-017 pide: el
 * valor no se rechaza —la instancia sigue atendiendo— y no se silencia —queda una línea en el
 * registro, una sola, y la decisión se recuerda—.
 */
describe('degradación declarada del esfuerzo (FR-017)', () => {
  /** Rechazo del proveedor por no admitir el parámetro de razonamiento. */
  const rechazaElEsfuerzo = () =>
    new OpenAI.BadRequestError(
      400,
      { error: { message: "Unsupported parameter: 'reasoning.effort'" } },
      'x',
      new Headers(),
    );

  const construir = () => {
    const d = new OpenAiDouble();
    const lines: string[] = [];
    const model = createChatModel('openai', {
      model: MODELO,
      effort: 'medium',
      client: d.client,
      log: (line) => lines.push(line),
    });
    return { d, lines, model };
  };

  const efortsEnviados = (d: OpenAiDouble) =>
    d.calls.map((c) => (c.params.reasoning as { effort?: unknown } | undefined)?.effort);

  it('el proveedor lo rechaza: una línea, un reintento sin él, y sigue atendiendo', async () => {
    const { d, lines, model } = construir();
    d.queue(rechazaElEsfuerzo(), openaiResponse({ text: VALID }));
    const reply = await model.reply(replyContext(), { signal: signal() });

    // No se rechaza: el cliente recibe su respuesta.
    expect(reply.body).toBe('Abrimos de 9:00 a 14:00.');
    // No se silencia: queda constancia, y **una** sola línea.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no admite el ajuste de esfuerzo');
    expect(lines[0]).toContain('LLM_EFFORT');
    // Un intento con el parámetro y uno sin él: ni más reintentos ni adivinar por el nombre.
    expect(efortsEnviados(d)).toEqual(['medium', undefined]);
  });

  it('la decisión se recuerda: las respuestas siguientes no vuelven a intentarlo ni a avisar', async () => {
    const { d, lines, model } = construir();
    d.queue(rechazaElEsfuerzo(), openaiResponse({ text: VALID }));
    await model.reply(replyContext(), { signal: signal() });
    d.queue(openaiResponse({ text: VALID }), openaiResponse({ text: VALID }));
    await model.reply(replyContext(), { signal: signal() });
    await model.reply(replyContext(), { signal: signal() });

    expect(lines).toHaveLength(1);
    expect(efortsEnviados(d)).toEqual(['medium', undefined, undefined, undefined]);
  });

  // Un 400 que no es por el parámetro de razonamiento **no** degrada nada: degradar por cualquier
  // petición mal formada dejaría la instancia sin esfuerzo para siempre por un error ajeno.
  it('otro 400 no degrada el esfuerzo ni deja constancia', async () => {
    const { d, lines, model } = construir();
    d.queue(
      new OpenAI.BadRequestError(400, { error: { message: 'bad input' } }, 'x', new Headers()),
    );
    await expect(model.reply(replyContext(), { signal: signal() })).rejects.toMatchObject({
      reason: 'api_error',
    });
    expect(lines).toEqual([]);
    expect(efortsEnviados(d)).toEqual(['medium']);
  });

  // En Anthropic y en Gemini el mando está siempre: no hay nada que degradar, y por tanto no puede
  // aparecer ninguna línea de degradación en una instancia de esos dos.
  it.each(['anthropic', 'gemini'] as const)(
    '%s no degrada nunca: el mando está siempre',
    async (provider) => {
      expect(PROVIDER_CAPABILITIES[provider].effort).toBe('always');
      const e = ESCENARIOS[provider]();
      e.responde();
      await e.model.reply(replyContext(), { signal: signal() });
      expect(String(e.enviado().effort).toLowerCase()).toBe('medium');
    },
  );
});

/**
 * FR-018: el razonamiento interno se usa donde existe y se prescinde de él donde no, **sin que eso
 * cambie la forma de la respuesta**. Es la garantía de que el responder no tiene que saber quién
 * contestó.
 */
describe('razonamiento interno (FR-018)', () => {
  it('la respuesta de los tres tiene exactamente la misma forma', async () => {
    const formas = await Promise.all(
      LLM_PROVIDERS.map(async (provider) => {
        const e = ESCENARIOS[provider]();
        e.responde();
        return e.model.reply(replyContext(), { signal: signal() });
      }),
    );
    const [primera] = formas;
    for (const forma of formas) expect(forma).toEqual(primera);
  });

  it('sin el parámetro de esfuerzo, la respuesta sigue teniendo la misma forma', async () => {
    const d = new OpenAiDouble();
    const model = createChatModel('openai', { model: MODELO, effort: 'medium', client: d.client });
    const e = ESCENARIOS['anthropic']();
    e.responde();
    const conRazonamiento = await e.model.reply(replyContext(), { signal: signal() });

    d.queue(
      new OpenAI.BadRequestError(
        400,
        { error: { message: 'reasoning not supported' } },
        'x',
        new Headers(),
      ),
      openaiResponse({ text: VALID }),
    );
    const sinRazonamiento = await model.reply(replyContext(), { signal: signal() });
    expect(sinRazonamiento).toEqual(conRazonamiento);
  });
});
