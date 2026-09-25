/**
 * Raíz de composición del bot: une el dominio de conversación con sus adaptadores reales
 * (Claude, WhatsApp si está configurado) y la base de conocimiento. Desde la 004 basta la clave
 * del modelo para tener bot ("Probar el bot" y chat web); WhatsApp es un canal opcional (R11).
 */
import type { BotHttp } from './app.js';
import { createGraphClient } from './channels/whatsapp/graph-client.js';
import type { Env } from './config/env.js';
import { createActivityLog, type LoggerLike } from './conversation/activity-log.js';
import { buildChannelPolicies } from './conversation/channels.js';
import { createIntake } from './conversation/intake.js';
import { systemClock, type Clock } from './conversation/ports.js';
import { createProcessor, type Processor } from './conversation/processor.js';
import { createRetention, type Retention } from './conversation/retention.js';
import { createTranscriber, type Transcriber } from './conversation/transcription.js';
import type { Db } from './db/client.js';
import { createKnowledgeReader } from './knowledge/snapshot.js';
import { createAnthropicChatModel } from './llm/anthropic-chat-model.js';
import { createWhisperSpeechToText } from './speech/whisper.js';
import { createQuotaWatch } from './webchat/usage.js';

export interface Bot extends BotHttp {
  processor: Processor;
  /** Borrado de conversaciones a los 30 días (FR-030). */
  retention: Retention;
  /** Solo con WhatsApp y AUDIO_TRANSCRIPTION=on. */
  transcriber: Transcriber | null;
}

export interface CreateBotOptions {
  env: Env;
  db: Db;
  logger: LoggerLike;
  clock?: Clock;
}

export function createBot({ env, db, logger, clock = systemClock }: CreateBotOptions): Bot | null {
  if (env.ANTHROPIC_API_KEY === undefined) {
    logger.warn(
      { channel: 'bot' },
      'Sin ANTHROPIC_API_KEY: la instancia arranca solo con el panel y el chat web no disponible',
    );
    return null;
  }
  const activityLog = createActivityLog(logger, env.SESSION_SECRET);
  const reader = createKnowledgeReader(db);
  const graph = env.whatsapp ? createGraphClient(env.whatsapp) : null;
  const policies = buildChannelPolicies({ whatsappSender: graph });
  const quotaWatch = createQuotaWatch(activityLog);
  const chatModel = createAnthropicChatModel({
    apiKey: env.ANTHROPIC_API_KEY,
    model: env.LLM_MODEL,
    effort: env.LLM_EFFORT,
  });
  const processor = createProcessor({
    db,
    reader,
    chatModel,
    policies,
    clock,
    activityLog,
    emergencyContactPhone: env.emergencyContactPhone,
    audioTranscription: env.audioTranscription,
    quotaWatch,
  });
  const wake = (id: string) => {
    processor.wake(id);
  };
  // Audios (R10): solo WhatsApp los envía, y solo con el interruptor encendido.
  const transcriber =
    graph && env.audioTranscription && env.STT_API_KEY
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
    policies,
    wake,
    notifyRateLimit: (id) => {
      void processor.sendRateLimitNotice(id);
    },
    quotaWatch,
    ...(transcriber ? { transcriber } : {}),
  });
  return {
    whatsapp: env.whatsapp,
    audioTranscription: env.audioTranscription,
    activityLog,
    intake,
    reader,
    emergencyContactPhone: env.emergencyContactPhone,
    clock,
    processor,
    retention: createRetention({ db, clock, activityLog }),
    transcriber,
  };
}
