/**
 * Transcripción de audios (research R10; solo con AUDIO_TRANSCRIPTION=on).
 *
 * Se lanza desde la recepción sin esperar, en paralelo con la espera de agrupado: descarga el
 * audio (≤ 2 MB), lo transcribe y guarda solo el texto. El audio no sale de esta función ni se
 * escribe en BD o en disco. Si algo falla, el audio queda como no entendido (FR-028).
 */
import type { Db } from '../db/client.js';
import type { KnowledgeReader } from '../knowledge/types.js';
import type { UsageMeter } from '../usage/meter.js';
import { canTranscribe, checkProtection, type ProtectionConfig } from '../usage/protection.js';
import { resolveAudioMs } from '../usage/transcription-cost.js';
import type { ActivityLog, EventContext, TranscriptionFailure } from './activity-log.js';
import type { Channel } from './channels.js';
import {
  MediaTooLargeError,
  SpeechToTextError,
  type Clock,
  type MediaFetcher,
  type SpeechToText,
} from './ports.js';
import { setTranscription } from './repositories/message.js';
import { conversationSettings, type ConversationSettings } from './settings.js';

/** Protección y consumo de la transcripción (012, R6). Sin ella se transcribe como en la 002. */
export interface TranscriptionProtection {
  config: ProtectionConfig;
  /** Zona horaria del negocio (snapshot sin caché). */
  reader: KnowledgeReader;
  clock: Clock;
  /** Registro del consumo; sin él no se mide. */
  meter?: UsageMeter;
}

export interface TranscriptionJob {
  messageId: string;
  mediaId: string;
  conversationId: string;
  /** Solo para los registros (`via` y seudónimo). */
  channel: Channel;
  customerKey: string;
}

export interface TranscriberDeps {
  db: Db;
  media: MediaFetcher;
  stt: SpeechToText;
  activityLog: ActivityLog;
  /** Avisa al procesador de que la conversación puede estar lista. */
  wake: (conversationId: string) => void;
  settings?: ConversationSettings;
  protection?: TranscriptionProtection;
}

export interface Transcriber {
  /** Transcribe un audio; nunca lanza. */
  transcribe(job: TranscriptionJob): Promise<void>;
  /** Espera a las transcripciones en curso (tests y cierre). */
  idle(): Promise<void>;
  /** Cancela las transcripciones en curso y espera a que terminen. */
  stop(): Promise<void>;
}

/** Lo que hace falta para registrar el consumo de una transcripción que el proveedor atendió. */
interface Billable {
  providerSeconds: number | null;
  bytes: Buffer;
}

class Rejected extends Error {
  constructor(
    readonly reason: TranscriptionFailure,
    /** El proveedor respondió: su consumo se registra aunque se rechace (012, R6). */
    readonly billable: Billable | null = null,
  ) {
    super(reason);
  }
}

export function createTranscriber(deps: TranscriberDeps): Transcriber {
  const { db, media, stt, activityLog } = deps;
  const settings = deps.settings ?? conversationSettings;
  const inFlight = new Set<Promise<void>>();
  const stopping = new AbortController();

  async function textOf(mediaId: string): Promise<{ text: string; billable: Billable }> {
    const signal = AbortSignal.any([
      stopping.signal,
      AbortSignal.timeout(settings.transcriptionTimeoutMs),
    ]);
    let audio: { data: Buffer; mimeType: string };
    try {
      audio = await media.fetchAudio(mediaId, settings.audioMaxBytes, { signal });
    } catch (error) {
      if (error instanceof MediaTooLargeError) throw new Rejected('too_large');
      throw new Rejected(signal.aborted ? 'timeout' : 'provider_error');
    }
    let billable: Billable | null = null;
    try {
      const transcript = await stt.transcribe(audio, { signal });
      billable = { providerSeconds: transcript.durationSeconds, bytes: audio.data };
      if ((transcript.durationSeconds ?? 0) > settings.audioMaxSeconds) {
        throw new Rejected('too_long', billable);
      }
      if (transcript.text.trim() === '') throw new Rejected('empty', billable);
      if (transcript.language !== 'es') throw new Rejected('language', billable);
      return { text: transcript.text.trim(), billable };
    } catch (error) {
      if (error instanceof Rejected) throw error;
      if (error instanceof SpeechToTextError && error.responded) {
        billable = { providerSeconds: error.durationSeconds, bytes: audio.data };
      }
      if (signal.aborted) throw new Rejected('timeout', billable);
      throw new Rejected(
        error instanceof SpeechToTextError ? error.reason : 'provider_error',
        billable,
      );
    }
  }

  /** Consumo de la transcripción (012, R6); nunca impide seguir (el medidor no lanza). */
  async function recordUsage(job: TranscriptionJob, billable: Billable, logContext: EventContext) {
    const protection = deps.protection;
    if (!protection?.meter || protection.config.sttModel === null) return;
    let timezone: string;
    try {
      timezone = (await protection.reader.getSnapshot()).business.timezone;
    } catch {
      activityLog.log({ event: 'transcription_usage_failed' }, logContext);
      return;
    }
    await protection.meter
      .recordTranscription(
        {
          channel: job.channel,
          model: protection.config.sttModel,
          audioMs: resolveAudioMs(
            billable.providerSeconds,
            billable.bytes,
            settings.audioMaxSeconds,
          ),
          at: protection.clock.now(),
          timezone,
        },
        logContext,
      )
      .catch(() => {
        activityLog.log({ event: 'transcription_usage_failed' }, logContext);
      });
  }

  /**
   * ¿Se puede descargar y transcribir ahora? (012, R6): con un motivo de solo contacto, el tope
   * de gasto o el tope diario del canal alcanzados, no. Sin snapshot legible tampoco.
   */
  async function allowed(job: TranscriptionJob, logContext: EventContext): Promise<boolean> {
    const protection = deps.protection;
    if (!protection || job.channel === 'playground') return true;
    let timezone: string;
    try {
      timezone = (await protection.reader.getSnapshot()).business.timezone;
    } catch {
      return false;
    }
    const state = await checkProtection(
      db,
      { ...protection.config, now: protection.clock.now(), timezone },
      activityLog,
      logContext,
    );
    return canTranscribe(state, job.channel).ok;
  }

  async function run(job: TranscriptionJob): Promise<void> {
    const logContext = {
      channel: job.channel,
      customerKey: job.customerKey,
      conversationId: job.conversationId,
    };
    try {
      if (!(await allowed(job, logContext))) throw new Rejected('blocked');
      let result: { text: string; billable: Billable };
      try {
        result = await textOf(job.mediaId);
      } catch (error) {
        if (error instanceof Rejected && error.billable) {
          await recordUsage(job, error.billable, logContext);
        }
        throw error;
      }
      await recordUsage(job, result.billable, logContext);
      await setTranscription(db, job.messageId, 'done', result.text);
    } catch (error) {
      const reason = error instanceof Rejected ? error.reason : 'provider_error';
      activityLog.log({ event: 'transcription_failed', reason }, logContext);
      await setTranscription(db, job.messageId, 'failed', null).catch(() => {
        // BD no disponible: el audio sigue `pending` y a los 10 s se trata como no entendido.
      });
    }
    deps.wake(job.conversationId);
  }

  return {
    transcribe(job) {
      const promise = run(job).finally(() => inFlight.delete(promise));
      inFlight.add(promise);
      return promise;
    },
    async idle() {
      await Promise.all(inFlight);
    },
    async stop() {
      stopping.abort();
      await Promise.all(inFlight);
    },
  };
}
