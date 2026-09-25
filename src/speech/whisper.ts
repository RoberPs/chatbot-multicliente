/**
 * Voz a texto sobre la API de transcripción de OpenAI (research R10). Solo se usa con
 * AUDIO_TRANSCRIPTION=on. El audio viaja en memoria; aquí no se guarda nada.
 */
import { SpeechToTextError, type SpeechToText, type Transcript } from '../conversation/ports.js';
import { conversationSettings } from '../conversation/settings.js';

export interface WhisperOptions {
  apiKey: string;
  /** STT_MODEL (por defecto whisper-1). */
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

/** `verbose_json` da el idioma por su nombre en inglés; el dominio trabaja con códigos ISO. */
const LANGUAGE_CODES: Record<string, string> = {
  spanish: 'es',
  english: 'en',
  catalan: 'ca',
  galician: 'gl',
  basque: 'eu',
  portuguese: 'pt',
  french: 'fr',
  german: 'de',
  italian: 'it',
};

const EXTENSIONS: Record<string, string> = {
  ogg: 'ogg',
  opus: 'ogg',
  mpeg: 'mp3',
  mp3: 'mp3',
  mp4: 'm4a',
  aac: 'm4a',
  wav: 'wav',
  webm: 'webm',
  amr: 'amr',
};

function languageCode(language: string | undefined): string {
  const value = (language ?? '').trim().toLowerCase();
  return LANGUAGE_CODES[value] ?? value;
}

export function createWhisperSpeechToText(opts: WhisperOptions): SpeechToText {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? conversationSettings.transcriptionTimeoutMs;
  const url = `${opts.baseUrl ?? 'https://api.openai.com'}/v1/audio/transcriptions`;

  return {
    async transcribe(audio, { signal }): Promise<Transcript> {
      const mimeType = audio.mimeType.split(';')[0]?.trim() || 'audio/ogg';
      const extension = EXTENSIONS[mimeType.split('/')[1] ?? ''] ?? 'ogg';
      const form = new FormData();
      form.append('file', new Blob([audio.data], { type: mimeType }), `audio.${extension}`);
      form.append('model', opts.model);
      form.append('response_format', 'verbose_json');

      const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${opts.apiKey}` },
          body: form,
          signal: deadline,
        });
      } catch {
        throw new SpeechToTextError(deadline.aborted ? 'timeout' : 'provider_error');
      }
      if (!res.ok) throw new SpeechToTextError('provider_error', res.status);

      const json = (await res.json().catch(() => null)) as {
        text?: unknown;
        language?: unknown;
        duration?: unknown;
      } | null;
      if (!json || typeof json.text !== 'string') {
        throw new SpeechToTextError('provider_error', res.status);
      }
      return {
        text: json.text.trim(),
        language: languageCode(typeof json.language === 'string' ? json.language : undefined),
        durationSeconds: typeof json.duration === 'number' ? json.duration : null,
      };
    },
  };
}
