/**
 * Transcripción de audios (research R10; solo con AUDIO_TRANSCRIPTION=on).
 *
 * Se lanza desde la recepción sin esperar, en paralelo con la espera de agrupado: descarga el
 * audio (≤ 2 MB), lo transcribe y guarda solo el texto. El audio no sale de esta función ni se
 * escribe en BD o en disco. Si algo falla, el audio queda como no entendido (FR-028).
 */
import type { Db } from '../db/client.js';
import type { ActivityLog, TranscriptionFailure } from './activity-log.js';
import {
  MediaTooLargeError,
  SpeechToTextError,
  type MediaFetcher,
  type SpeechToText,
} from './ports.js';
import { setTranscription } from './repositories/message.js';
import { conversationSettings, type ConversationSettings } from './settings.js';

export interface TranscriptionJob {
  messageId: string;
  mediaId: string;
  conversationId: string;
  /** Solo para los registros (seudonimizado). */
  phone: string;
}

export interface TranscriberDeps {
  db: Db;
  media: MediaFetcher;
  stt: SpeechToText;
  activityLog: ActivityLog;
  /** Avisa al procesador de que la conversación puede estar lista. */
  wake: (conversationId: string) => void;
  settings?: ConversationSettings;
}

export interface Transcriber {
  /** Transcribe un audio; nunca lanza. */
  transcribe(job: TranscriptionJob): Promise<void>;
  /** Espera a las transcripciones en curso (tests y cierre). */
  idle(): Promise<void>;
  /** Cancela las transcripciones en curso y espera a que terminen. */
  stop(): Promise<void>;
}

class Rejected extends Error {
  constructor(readonly reason: TranscriptionFailure) {
    super(reason);
  }
}

export function createTranscriber(deps: TranscriberDeps): Transcriber {
  const { db, media, stt, activityLog } = deps;
  const settings = deps.settings ?? conversationSettings;
  const inFlight = new Set<Promise<void>>();
  const stopping = new AbortController();

  async function textOf(mediaId: string): Promise<string> {
    const signal = AbortSignal.any([
      stopping.signal,
      AbortSignal.timeout(settings.transcriptionTimeoutMs),
    ]);
    let audio: { data: Buffer; mimeType: string };
    try {
      audio = await media.fetchAudio(mediaId, settings.audioMaxBytes);
    } catch (error) {
      throw new Rejected(error instanceof MediaTooLargeError ? 'too_large' : 'provider_error');
    }
    try {
      const transcript = await stt.transcribe(audio, { signal });
      if ((transcript.durationSeconds ?? 0) > settings.audioMaxSeconds) {
        throw new Rejected('too_long');
      }
      if (transcript.text.trim() === '') throw new Rejected('empty');
      if (transcript.language !== 'es') throw new Rejected('language');
      return transcript.text.trim();
    } catch (error) {
      if (error instanceof Rejected) throw error;
      if (signal.aborted) throw new Rejected('timeout');
      throw new Rejected(error instanceof SpeechToTextError ? error.reason : 'provider_error');
    }
  }

  async function run(job: TranscriptionJob): Promise<void> {
    const logContext = { phone: job.phone, conversationId: job.conversationId };
    try {
      const text = await textOf(job.mediaId);
      await setTranscription(db, job.messageId, 'done', text);
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
