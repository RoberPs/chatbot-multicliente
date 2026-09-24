import { describe, expect, it, vi } from 'vitest';
import {
  createGraphClient,
  MediaTooLargeError,
} from '../../../src/channels/whatsapp/graph-client.js';
import { ChannelSendError } from '../../../src/conversation/ports.js';

const ok = (id = 'wamid.OUT') =>
  new Response(JSON.stringify({ messages: [{ id }] }), { status: 200 });
const status = (code: number) => new Response('{}', { status: code });

function client(responses: Array<Response | Error>) {
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('sin respuesta programada');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleeps: number[] = [];
  const graph = createGraphClient({
    phoneNumberId: '1098',
    accessToken: 'tok',
    graphVersion: 'v23.0',
    fetch: fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { graph, fetch, sleeps };
}

describe('cliente de la Graph API: envío', () => {
  it('envía el texto con el cuerpo y las cabeceras del contrato', async () => {
    const { graph, fetch } = client([ok('wamid.X')]);
    await expect(graph.sendText('+34600111222', 'Hola')).resolves.toEqual({
      channelMessageId: 'wamid.X',
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v23.0/1098/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer tok',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      to: '34600111222',
      type: 'text',
      text: { body: 'Hola', preview_url: false },
    });
  });

  it('reintenta ante 429, 5xx y error de red con esperas de 1, 4 y 15 s', async () => {
    const { graph, sleeps } = client([status(429), status(503), new Error('red'), ok()]);
    await expect(graph.sendText('+34600111222', 'x')).resolves.toEqual({
      channelMessageId: 'wamid.OUT',
    });
    expect(sleeps).toEqual([1000, 4000, 15000]);
  });

  it('tras agotar los reintentos lanza ChannelSendError con intentos y status', async () => {
    const { graph } = client([status(500), status(500), status(500), status(502)]);
    const error = await graph.sendText('+34600111222', 'x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelSendError);
    expect(error).toMatchObject({ attempts: 4, status: 502 });
  });

  it('un 400 no se reintenta', async () => {
    const { graph, fetch, sleeps } = client([status(400)]);
    await expect(graph.sendText('+34600111222', 'x')).rejects.toMatchObject({
      attempts: 1,
      status: 400,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('corta los reintentos cuando canRetry devuelve false', async () => {
    const { graph, fetch } = client([status(503), status(503), ok()]);
    // La ventana se cierra después del segundo intento.
    const error = await graph
      .sendText('+34600111222', 'x', { canRetry: () => fetch.mock.calls.length < 2 })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ attempts: 2, status: 503 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('cliente de la Graph API: audios', () => {
  it('descarga el audio con el mismo token', async () => {
    const { graph, fetch } = client([
      new Response(JSON.stringify({ url: 'https://cdn.test/a', mime_type: 'audio/ogg' })),
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } }),
    ]);
    const audio = await graph.fetchAudio('m-1', 100);
    expect(audio).toEqual({ data: Buffer.from([1, 2, 3]), mimeType: 'audio/ogg' });
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]?.[0]).toBe('https://graph.facebook.com/v23.0/m-1');
    expect(calls[1]?.[1].headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('rechaza un audio grande sin descargarlo entero', async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const { graph } = client([
      new Response(JSON.stringify({ url: 'https://cdn.test/a' })),
      new Response(body, { headers: { 'content-length': String(3 * 1024 * 1024) } }),
    ]);
    await expect(graph.fetchAudio('m-1', 2 * 1024 * 1024)).rejects.toBeInstanceOf(
      MediaTooLargeError,
    );
    expect(pulls).toBeLessThanOrEqual(1);
  });
});
