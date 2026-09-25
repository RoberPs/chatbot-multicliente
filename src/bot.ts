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
import { createRetention, type Retention } from './conversation/retention.js';
import { createTranscriber, type Transcriber } from './conversation/transcription.js';
import type { Db } from './db/client.js';
import { createKnowledgeReader } from './knowledge/snapshot.js';
import { createAnthropicChatModel } from './llm/anthropic-chat-model.js';
import { createWhisperSpeechToText } from './speech/whisper.js';

export interface Bot extends BotHttp {
  processor: Processor;
  /** Borrado de conversaciones a los 30 días (FR-030). */
  retention: Retention;
  /** Solo con AUDIO_TRANSCRIPTION=on. */
  transcriber: Transcriber | null;
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
    audioTranscription: env.audioTranscription,
  });
  const wake = (id: string) => {
    processor.wake(id);
  };
  // Audios (R10): solo con el interruptor encendido; si no, ni se descargan.
  const transcriber =
    env.audioTranscription && env.STT_API_KEY
      ? createTranscriber({
          db,
          media: graph,
          stt: createWhisperSpeechToText({ apiKey: env.STT_API_KEY, model: env.STT_MODEL }),
          activityLog,
          wake,
        })
      : null;
  const intake = createIntake({
    db,
    reader,
    clock,
    activityLog,
    wake,
    notifyRateLimit: (id) => {
      void processor.sendRateLimitNotice(id);
    },
    ...(transcriber ? { transcriber } : {}),
  });
  return {
    whatsapp: env.whatsapp,
    audioTranscription: env.audioTranscription,
    activityLog,
    intake,
    processor,
    retention: createRetention({ db, clock, activityLog }),
    transcriber,
  };
}
