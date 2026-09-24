/**
 * Raíz de composición del bot: une el dominio de conversación con sus adaptadores reales
 * (WhatsApp, Claude) y la base de conocimiento. Sin canal configurado, no hay bot.
 */
import type { BotHttp } from './app.js';
import { createGraphClient } from './channels/whatsapp/graph-client.js';
import type { Env } from './config/env.js';
import { createActivityLog, type LoggerLike } from './conversation/activity-log.js';
import { createIntake } from './conversation/intake.js';
import { systemClock, type Clock } from './conversation/ports.js';
import { createProcessor, type Processor } from './conversation/processor.js';
import type { Db } from './db/client.js';
import { createKnowledgeReader } from './knowledge/snapshot.js';
import { createAnthropicChatModel } from './llm/anthropic-chat-model.js';

export interface Bot extends BotHttp {
  processor: Processor;
}

export interface CreateBotOptions {
  env: Env;
  db: Db;
  logger: LoggerLike;
  clock?: Clock;
}

export function createBot({ env, db, logger, clock = systemClock }: CreateBotOptions): Bot | null {
  if (!env.whatsapp) {
    logger.warn(
      { channel: 'bot' },
      'Canal de WhatsApp sin configurar: la instancia arranca solo con el panel',
    );
    return null;
  }
  const activityLog = createActivityLog(logger, env.SESSION_SECRET);
  const reader = createKnowledgeReader(db);
  const graph = createGraphClient(env.whatsapp);
  const chatModel = createAnthropicChatModel({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.LLM_MODEL,
    effort: env.LLM_EFFORT,
  });
  const processor = createProcessor({
    db,
    reader,
    chatModel,
    sender: graph,
    clock,
    activityLog,
    emergencyContactPhone: env.emergencyContactPhone,
  });
  const intake = createIntake({
    db,
    reader,
    clock,
    activityLog,
    wake: (id) => {
      processor.wake(id);
    },
  });
  return {
    whatsapp: env.whatsapp,
    audioTranscription: env.audioTranscription,
    activityLog,
    intake,
    processor,
  };
}
