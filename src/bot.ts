/**
 * Raíz de composición del bot: une el dominio de conversación con sus adaptadores reales
 * (Claude, WhatsApp si está configurado) y la base de conocimiento. Desde la 004 basta la clave
 * del modelo para tener bot ("Probar el bot" y chat web); WhatsApp es un canal opcional (R11).
 */
import type { BotHttp } from './app.js';
import { createGraphClient } from './channels/whatsapp/graph-client.js';
import { protectionConfigFromEnv, type Env } from './config/env.js';
import { createActivityLog, type LoggerLike } from './conversation/activity-log.js';
import { buildChannelPolicies } from './conversation/channels.js';
import { createIntake } from './conversation/intake.js';
import { systemClock, type Clock } from './conversation/ports.js';
import { createProcessor, type Processor } from './conversation/processor.js';
import { createRetention, type Retention } from './conversation/retention.js';
import { createTranscriber, type Transcriber } from './conversation/transcription.js';
import type { Db } from './db/client.js';
import { createAlertRoutesProvider } from './handoff/routes-provider.js';
import { createHandoffService } from './handoff/service.js';
import { createSimulatedRoute } from './handoff/simulated-route.js';
import { createTokenCipher } from './handoff/tokens.js';
import { createKnowledgeReader } from './knowledge/snapshot.js';
import {
  createCredentialWatcher,
  type CredentialWatcher,
} from './llm/credential-probe.js';
import { createChatModel, createSummarizer } from './llm/factory.js';
import { createSmtpMailer, smtpTransport } from './mail/smtp-mailer.js';
import { createTemplateSender } from './channels/whatsapp/template-sender.js';
import { createBusinessRouter, withBusinessRouter } from './channels/whatsapp/business-router.js';
import type { CountryCode } from 'libphonenumber-js';
import { createWhisperSpeechToText } from './speech/whisper.js';
import { createUsageMeter } from './usage/meter.js';
import { createQuotaWatch } from './webchat/usage.js';

export interface Bot extends BotHttp {
  processor: Processor;
  /** Borrado de conversaciones a los 30 días (FR-030). */
  retention: Retention;
  /** Solo con WhatsApp y AUDIO_TRANSCRIPTION=on. */
  transcriber: Transcriber | null;
  /** 017: vigilante de la credencial del modelo; el arranque lo cierra en `stop()`. */
  credentialWatcher: CredentialWatcher;
}

export interface CreateBotOptions {
  env: Env;
  db: Db;
  logger: LoggerLike;
  clock?: Clock;
}

export function createBot({ env, db, logger, clock = systemClock }: CreateBotOptions): Bot | null {
  // 017: la credencial y su variable las resuelve el entorno a partir del proveedor declarado
  // (FR-005). Aquí ya no se nombra ninguna: el aviso usa la del proveedor que la instancia eligió.
  if (env.llmApiKey === undefined) {
    logger.warn(
      { channel: 'bot' },
      `Sin ${env.llmKeyVariable}: la instancia arranca solo con el panel y el chat web no disponible`,
    );
    return null;
  }
  const activityLog = createActivityLog(logger, env.SESSION_SECRET);
  const reader = createKnowledgeReader(db);
  const graph = env.whatsapp ? createGraphClient(env.whatsapp) : null;
  const policies = buildChannelPolicies({ whatsappSender: graph });
  const quotaWatch = createQuotaWatch(activityLog);
  // Consumo del modelo (010): respuestas y resúmenes, con el modelo configurado.
  const usage = { meter: createUsageMeter({ db, activityLog }), model: env.LLM_MODEL };
  /**
   * 017 (FR-005a/b/c): comprobación de la credencial al arrancar.
   *
   * **No bloquea el arranque y nunca es fatal.** Es la lección del Fallo 1 de la 016: un proceso
   * que muere al arrancar porque una dependencia no está produce un bucle de reinicio y 502 para
   * todo el mundo. Y el Principio V exige salida a una persona: el degradado la da, el bucle de
   * reinicio no.
   */
  const credentialWatcher = createCredentialWatcher({
    provider: env.LLM_PROVIDER,
    apiKey: env.llmApiKey,
    log: (message) => {
      logger.warn({ channel: 'bot' }, message);
    },
  });
  void credentialWatcher.check().then((verdict) => {
    // `inconclusive`: se arranca con normalidad y se deja constancia. No degrada nada, porque la
    // ausencia de veredicto no es un veredicto (FR-005c).
    if (verdict === 'inconclusive') {
      logger.warn(
        { channel: 'bot' },
        `No se pudo comprobar la credencial de ${env.llmKeyVariable} al arrancar: la instancia funciona con normalidad y no se degrada nada.`,
      );
    }
  });
  // Protección frente a abuso (012): producción y modelos, calculados una vez del entorno.
  // 017: el estado de la credencial se consulta en cada comprobación, no se captura: el vigilante
  // sale del degradado solo y el panel tiene que verlo sin reiniciar.
  const protection = {
    ...protectionConfigFromEnv(env),
    credentialRejected: () => credentialWatcher.state() === 'rejected',
  };
  // Los **dos** puertos del proveedor se construyen por fábrica y con el mismo proveedor (regla
  // C3, FR-013a): si solo se migrase el de conversación, la instancia conversaría bien y fallaría
  // justo al derivar a una persona.
  const chatModel = createChatModel(env.LLM_PROVIDER, {
    apiKey: env.llmApiKey,
    model: env.LLM_MODEL,
    effort: env.LLM_EFFORT,
    // FR-017: la degradación declarada del esfuerzo deja constancia en el registro de la
    // instancia, no en la salida estándar. Es lo que la hace encontrable cuando el operador se
    // pregunta por qué su LLM_EFFORT no parece hacer nada.
    log: (message) => {
      logger.warn({ channel: 'bot' }, message);
    },
  });
  // Derivación al negocio (005): vías según lo que la instancia puede enviar (R16).
  const templateLanguage = env.WHATSAPP_TEMPLATE_LANG;
  const smtp = env.smtp;
  const baseUrl = env.PUBLIC_BASE_URL;
  const transport = smtp && baseUrl !== undefined ? smtpTransport(smtp.url) : null;
  const handoff = createHandoffService({
    db,
    clock,
    reader,
    activityLog,
    routes: createAlertRoutesProvider({
      whatsapp: graph
        ? (to) => createTemplateSender({ graph, language: templateLanguage, clock }, to)
        : null,
      email:
        smtp && transport && baseUrl !== undefined
          ? (to) => createSmtpMailer({ transport, from: smtp.from, baseUrl, clock }, to)
          : null,
      simulated: createSimulatedRoute(clock),
    }),
    summarizer: createSummarizer(env.LLM_PROVIDER, {
      apiKey: env.llmApiKey,
      model: env.LLM_MODEL,
    }),
    cipher: createTokenCipher(env.SESSION_SECRET),
    phoneRegion: env.DEFAULT_PHONE_REGION as CountryCode,
    policies,
    usage,
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
    handoff,
    usage,
    protection,
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
          protection: { config: protection, reader, clock, meter: usage.meter },
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
    protection,
    ...(transcriber ? { transcriber } : {}),
  });
  // Lo que escribe el negocio (botones y su número de avisos) no entra como cliente (005, R10).
  const routedIntake = graph
    ? withBusinessRouter(
        intake,
        createBusinessRouter({ db, handoff, sender: graph, activityLog, clock }),
      )
    : intake;
  return {
    whatsapp: env.whatsapp,
    audioTranscription: env.audioTranscription,
    activityLog,
    intake: routedIntake,
    reader,
    emergencyContactPhone: env.emergencyContactPhone,
    // 016: para la disculpa con contacto durante un corte de la base de datos.
    whatsappSender: graph,
    clock,
    handoff,
    processor,
    retention: createRetention({ db, clock, activityLog }),
    transcriber,
    credentialWatcher,
  };
}
