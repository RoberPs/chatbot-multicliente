/**
 * Adaptador de salida de la WhatsApp Cloud API (contracts/whatsapp-webhook.md):
 * envío de texto con reintentos y descarga de audios con límite de tamaño.
 */
import {
  ChannelSendError,
  MediaTooLargeError,
  type ChannelSender,
  type MediaFetcher,
  type SendOptions,
} from '../../conversation/ports.js';
import { conversationSettings } from '../../conversation/settings.js';

export interface GraphClientOptions {
  phoneNumberId: string;
  accessToken: string;
  graphVersion: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
  baseUrl?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 429, 5xx o error de red se reintentan; cualquier otro 4xx no. */
const retryable = (status: number | undefined) =>
  status === undefined || status === 429 || status >= 500;

export { MediaTooLargeError };

export function createGraphClient(opts: GraphClientOptions): ChannelSender & MediaFetcher {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const delays = opts.retryDelaysMs ?? conversationSettings.sendRetryDelaysMs;
  const base = `${opts.baseUrl ?? 'https://graph.facebook.com'}/${opts.graphVersion}`;
  const auth = { Authorization: `Bearer ${opts.accessToken}` };

  async function sendOnce(to: string, body: string): Promise<{ id?: string; status?: number }> {
    try {
      const res = await doFetch(`${base}/${opts.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to.replace(/^\+/, ''),
          type: 'text',
          text: { body, preview_url: false },
        }),
      });
      if (!res.ok) return { status: res.status };
      const json = (await res.json()) as { messages?: Array<{ id?: string }> };
      const id = json.messages?.[0]?.id;
      return id ? { id } : { status: res.status };
    } catch {
      return {};
    }
  }

  return {
    async sendText(to: string, body: string, sendOpts: SendOptions = {}) {
      let attempts = 0;
      let lastStatus: number | undefined;
      for (;;) {
        attempts += 1;
        const result = await sendOnce(to, body);
        if (result.id) return { channelMessageId: result.id };
        lastStatus = result.status;
        const delay = delays[attempts - 1];
        if (!retryable(lastStatus) || delay === undefined) break;
        if (sendOpts.canRetry && !sendOpts.canRetry()) break;
        await sleep(delay);
        if (sendOpts.canRetry && !sendOpts.canRetry()) break;
      }
      throw new ChannelSendError(attempts, lastStatus);
    },

    async fetchAudio(mediaId: string, maxBytes: number) {
      const meta = await doFetch(`${base}/${encodeURIComponent(mediaId)}`, { headers: auth });
      if (!meta.ok) throw new Error(`No se pudo consultar el audio (${meta.status})`);
      const info = (await meta.json()) as { url?: string; mime_type?: string; file_size?: number };
      if (!info.url) throw new Error('El audio no tiene URL de descarga');
      if (info.file_size !== undefined && info.file_size > maxBytes) throw new MediaTooLargeError();

      const res = await doFetch(info.url, { headers: auth });
      if (!res.ok || !res.body) throw new Error(`No se pudo descargar el audio (${res.status})`);
      const declared = Number(res.headers.get('content-length') ?? NaN);
      if (declared > maxBytes) {
        await res.body.cancel();
        throw new MediaTooLargeError();
      }
      // Lectura con tope: sin Content-Length fiable, se corta al pasar el límite.
      const chunks: Uint8Array[] = [];
      let size = 0;
      // Salir del bucle con throw cancela la descarga.
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new MediaTooLargeError();
        chunks.push(chunk);
      }
      return {
        data: Buffer.concat(chunks),
        mimeType: info.mime_type ?? res.headers.get('content-type') ?? 'application/octet-stream',
      };
    },
  };
}
