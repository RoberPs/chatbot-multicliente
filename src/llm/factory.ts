/**
 * Las dos fábricas de la costura (017, contracts/llm-provider.md §1, R12). Están separadas de
 * `./provider.js` porque son las únicas que importan SDK: así la comprobación previa y las reglas
 * de secretos pueden leer la tabla de proveedores sin cargar ningún cliente de modelo.
 */
import type { ChatModel } from '../conversation/ports.js';
import type { HandoffSummarizer } from '../handoff/ports.js';
import { createAnthropicChatModel, type Effort } from './anthropic-chat-model.js';
import { createAnthropicSummarizer } from './anthropic-summarizer.js';
import { ineligibleMessage, isLlmProvider, type LlmProvider } from './provider.js';

/** Opciones comunes a los tres proveedores. `client` existe solo para las pruebas. */
export interface ChatModelFactoryOptions {
  apiKey?: string;
  model: string;
  effort: Effort;
  client?: unknown;
}

export interface SummarizerFactoryOptions {
  apiKey?: string;
  model: string;
  client?: unknown;
}

/**
 * Fábrica del puerto de conversación. Un proveedor no elegible falla **antes** de construir nada,
 * con los tres nombres en el mensaje (regla C5).
 */
export function createChatModel(provider: LlmProvider, opts: ChatModelFactoryOptions): ChatModel {
  if (!isLlmProvider(provider)) throw new Error(ineligibleMessage(provider));
  switch (provider) {
    case 'anthropic':
      return createAnthropicChatModel({
        apiKey: opts.apiKey,
        model: opts.model,
        effort: opts.effort,
        client: opts.client as Parameters<typeof createAnthropicChatModel>[0]['client'],
      });
    default:
      throw new Error(ineligibleMessage(provider));
  }
}

/**
 * Fábrica del puerto de resumen de derivación (R12, regla C3). Se construye con el **mismo**
 * proveedor que el de conversación: si solo se migrase el primero, una instancia conversaría bien y
 * fallaría justo al derivar a una persona, que es lo que protege el Principio V.
 */
export function createSummarizer(
  provider: LlmProvider,
  opts: SummarizerFactoryOptions,
): HandoffSummarizer {
  if (!isLlmProvider(provider)) throw new Error(ineligibleMessage(provider));
  switch (provider) {
    case 'anthropic':
      return createAnthropicSummarizer({
        apiKey: opts.apiKey,
        model: opts.model,
        client: opts.client as Parameters<typeof createAnthropicSummarizer>[0]['client'],
      });
    default:
      throw new Error(ineligibleMessage(provider));
  }
}
