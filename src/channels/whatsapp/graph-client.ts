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

/** Resultado de un `POST /messages` con sus reintentos. */
export type GraphPostResult =
  | { ok: true; id: string }
  | {
      ok: false;
      attempts: number;
      /** Status HTTP del último intento; `undefined` si falló la red. */
      status?: number;
      /** `error.code` de la Graph API, si lo devolvió. */
      errorCode?: number;
    };

export interface GraphPostOptions extends SendOptions {
  /** Plazo del envío: corta la petición en curso y los reintentos. */
  signal?: AbortSignal;
}

/** Cliente de la Graph API: texto, cualquier mensaje (plantillas, 005) y audios. */
export interface GraphClient extends ChannelSender, MediaFetcher {
  /** `POST /{phone-number-id}/messages` con los reintentos de `sendText`; no lanza. */
  postMessage(payload: Record<string, unknown>, opts?: GraphPostOptions): Promise<GraphPostResult>;
}

export function createGraphClient(opts: GraphClientOptions): GraphClient {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const delays = opts.retryDelaysMs ?? conversationSettings.sendRetryDelaysMs;
  const base = `${opts.baseUrl ?? 'https://graph.facebook.com'}/${opts.graphVersion}`;
  const auth = { Authorization: `Bearer ${opts.accessToken}` };

  async function postOnce(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ id?: string; status?: number; errorCode?: number }> {
    try {
      const res = await doFetch(`${base}/${opts.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
        ...(signal ? { signal } : {}),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
        const code = json?.error?.code;
        return { status: res.status, ...(typeof code === 'number' ? { errorCode: code } : {}) };
      }
      const json = (await res.json()) as { messages?: Array<{ id?: string }> };
      const id = json.messages?.[0]?.id;
      return id ? { id } : { status: res.status };
    } catch {
      return {};
    }
  }

  async function postMessage(
    payload: Record<string, unknown>,
    postOpts: GraphPostOptions = {},
  ): Promise<GraphPostResult> {
    const { signal } = postOpts;
    const canRetry = () => !signal?.aborted && (postOpts.canRetry?.() ?? true);
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const result = await postOnce(payload, signal);
      if (result.id) return { ok: true, id: result.id };
      const delay = delays[attempts - 1];
      if (!retryable(result.status) || delay === undefined || !canRetry()) {
        return { ok: false, attempts, status: result.status, errorCode: result.errorCode };
      }
      await sleep(delay);
      if (!canRetry()) {
        return { ok: false, attempts, status: result.status, errorCode: result.errorCode };
      }
    }
  }

  return {
    postMessage,

    async sendText(to: string, body: string, sendOpts: SendOptions = {}) {
      const result = await postMessage(
        { to: to.replace(/^\+/, ''), type: 'text', text: { body, preview_url: false } },
        sendOpts,
      );
      if (result.ok) return { channelMessageId: result.id };
      throw new ChannelSendError(result.attempts, result.status);
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
