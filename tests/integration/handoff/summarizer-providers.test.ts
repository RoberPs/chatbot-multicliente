/**
 * El resumen de la derivación funciona con los tres proveedores (017, FR-013a, R12).
 *
 * Por qué este fichero existe y no es un lujo: el programa llama al proveedor por **dos** sitios,
 * y la spec solo hablaba de uno. Si únicamente se hubiese migrado el de conversación, una instancia
 * con Gemini conversaría perfectamente y fallaría **justo al derivar a una persona**, que es el
 * momento más sensible del producto y el que protege el Principio V. Así que el resumidor se prueba
 * de punta a punta, con el resumidor real construido por la fábrica sobre el doble de cada
 * proveedor, y comprobando que el resumen llega a la fila de la derivación.
 */
import { asc } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handoff as handoffTable } from '../../../src/db/schema.js';
import { createSummarizer } from '../../../src/llm/factory.js';
import { LLM_PROVIDERS, type LlmProvider } from '../../../src/llm/provider.js';
import { createTestBot, TEST_LLM_MODEL, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { AnthropicDouble, anthropicMessage } from '../../fixtures/llm/anthropic-double.js';
import { GeminiDouble, geminiResponse } from '../../fixtures/llm/gemini-double.js';
import { OpenAiDouble, openaiResponse } from '../../fixtures/llm/openai-double.js';

const RESUMEN = 'El cliente pide hablar con una persona por un problema con su pedido.';
const SALIDA = JSON.stringify({ summary: RESUMEN });
const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };

/** Doble del proveedor cargado con una respuesta de resumen válida. */
function dobleCon(provider: LlmProvider): { client: unknown; peticiones: () => number } {
  switch (provider) {
    case 'anthropic': {
      const d = new AnthropicDouble().queue(anthropicMessage({ text: SALIDA }));
      return { client: d.client, peticiones: () => d.calls.length };
    }
    case 'gemini': {
      const d = new GeminiDouble().queue(geminiResponse({ text: SALIDA }));
      return { client: d.client, peticiones: () => d.calls.length };
    }
    case 'openai': {
      const d = new OpenAiDouble().queue(openaiResponse({ text: SALIDA }));
      return { client: d.client, peticiones: () => d.calls.length };
    }
  }
}

describe('resumen de la derivación por proveedor', () => {
  let t: TestDatabase;
  let bot: TestBot | null = null;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(async () => {
    await bot?.close();
    bot = null;
  });

  it.each(LLM_PROVIDERS)('con %s el resumen llega a la derivación', async (provider) => {
    const doble = dobleCon(provider);
    const summarizer = createSummarizer(provider, { model: TEST_LLM_MODEL, client: doble.client });
    bot = await createTestBot(t, { handoffAlerts: ALERTS, realSummarizer: summarizer });

    await bot.send('Quiero hablar con una persona, tengo un problema.');
    await bot.settle();

    expect(doble.peticiones()).toBe(1);
    const rows = await t.db.select().from(handoffTable).orderBy(asc(handoffTable.startedAt));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe(RESUMEN);
    // `model`: el resumen lo hizo el modelo, no la plantilla de reserva.
    expect(rows[0]?.summarySource).toBe('model');
  });
});
