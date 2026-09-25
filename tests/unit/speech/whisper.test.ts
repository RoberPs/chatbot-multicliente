/** Adaptador de voz a texto sobre la API de transcripción de OpenAI (research R10). */
import { describe, expect, it, vi } from 'vitest';
import { SpeechToTextError } from '../../../src/conversation/ports.js';
import { createWhisperSpeechToText } from '../../../src/speech/whisper.js';

const audio = { data: Buffer.from('OggS-audio'), mimeType: 'audio/ogg; codecs=opus' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function stt(respond: (init: RequestInit) => Promise<Response>, timeoutMs = 10_000) {
  const fetch = vi.fn((_url: string, init: RequestInit) => respond(init));
  const client = createWhisperSpeechToText({
    apiKey: 'sk-test',
    model: 'whisper-1',
    fetch: fetch as unknown as typeof globalThis.fetch,
    timeoutMs,
  });
  return { client, fetch };
}

const signal = () => new AbortController().signal;

describe('Whisper', () => {
  it('envía el audio como multipart/form-data con el modelo configurado', async () => {
    const { client, fetch } = stt(async () =>
      json({ text: '¿A qué hora abrís?', language: 'spanish', duration: 3.2 }),
    );
    await client.transcribe(audio, { signal: signal() });

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer sk-test');
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    const file = form.get('file') as File;
    expect(file.type).toBe('audio/ogg');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(audio.data);
  });

  it('devuelve el texto, el idioma como código ISO y la duración', async () => {
    const { client } = stt(async () =>
      json({ text: ' ¿A qué hora abrís? ', language: 'spanish', duration: 3.2 }),
    );
    await expect(client.transcribe(audio, { signal: signal() })).resolves.toEqual({
      text: '¿A qué hora abrís?',
      language: 'es',
      durationSeconds: 3.2,
    });
  });

  it('otro idioma detectado se devuelve tal cual para que el dominio lo rechace', async () => {
    const { client } = stt(async () => json({ text: 'What time?', language: 'english' }));
    await expect(client.transcribe(audio, { signal: signal() })).resolves.toMatchObject({
      language: 'en',
      durationSeconds: null,
    });
  });

  it('texto vacío', async () => {
    const { client } = stt(async () => json({ text: '   ', language: 'spanish', duration: 1 }));
    await expect(client.transcribe(audio, { signal: signal() })).resolves.toMatchObject({
      text: '',
    });
  });

  it('se corta a los 10 s (aquí, 30 ms) con reason timeout', async () => {
    const { client } = stt(
      (init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('abortado', 'AbortError'));
          });
        }),
      30,
    );
    const error = await client.transcribe(audio, { signal: signal() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpeechToTextError);
    expect(error).toMatchObject({ reason: 'timeout' });
  });

  it('un error del proveedor lleva su status', async () => {
    const { client } = stt(async () => json({ error: { message: 'x' } }, 500));
    const error = await client.transcribe(audio, { signal: signal() }).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'provider_error', status: 500 });
  });

  it('un error de red es provider_error sin status', async () => {
    const { client } = stt(() => Promise.reject(new TypeError('fetch failed')));
    const error = await client.transcribe(audio, { signal: signal() }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpeechToTextError);
    expect(error).toMatchObject({ reason: 'provider_error' });
    expect((error as SpeechToTextError).status).toBeUndefined();
  });
});
