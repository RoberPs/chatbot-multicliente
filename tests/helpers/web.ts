/** Cliente del chat web público para los tests (004 US3, contracts/web-chat-http.md). */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

/** Origen con el que responde `fastify.inject` (host `localhost:80`). */
export const WEB_ORIGIN = 'http://localhost:80';

/** Cabeceras de una petición hecha desde el iframe de la propia instancia. */
export const webHeaders = (token?: string): Record<string, string> => ({
  origin: WEB_ORIGIN,
  'sec-fetch-site': 'same-origin',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

const json = (res: LightMyRequestResponse): Record<string, unknown> =>
  res.body === '' ? {} : (JSON.parse(res.body) as Record<string, unknown>);

export interface WebResponse {
  statusCode: number;
  headers: LightMyRequestResponse['headers'];
  body: Record<string, unknown>;
  raw: LightMyRequestResponse;
}

const wrap = (res: LightMyRequestResponse): WebResponse => ({
  statusCode: res.statusCode,
  headers: res.headers,
  body: json(res),
  raw: res,
});

/** `POST /chat/api/session`; devuelve el token cuando el chat está disponible. */
export async function createWebSession(
  app: FastifyInstance,
  headers: Record<string, string> = {},
  ip?: string,
): Promise<WebResponse & { token: string | null }> {
  const res = wrap(
    await app.inject({
      method: 'POST',
      url: '/chat/api/session',
      headers: { ...webHeaders(), ...headers },
      ...(ip ? { remoteAddress: ip } : {}),
    }),
  );
  const token = typeof res.body.token === 'string' ? res.body.token : null;
  return { ...res, token };
}

/** Token de una sesión nueva; falla si el chat no está disponible. */
export async function webToken(app: FastifyInstance): Promise<string> {
  const { token, statusCode, body } = await createWebSession(app);
  if (token === null) throw new Error(`Sin token (${statusCode}): ${JSON.stringify(body)}`);
  return token;
}

export async function postWebMessage(
  app: FastifyInstance,
  token: string,
  text: string,
  opts: { clientMessageId?: string; headers?: Record<string, string>; ip?: string } = {},
): Promise<WebResponse> {
  return wrap(
    await app.inject({
      method: 'POST',
      url: '/chat/api/messages',
      ...(opts.ip ? { remoteAddress: opts.ip } : {}),
      headers: {
        ...webHeaders(token),
        'content-type': 'application/json',
        ...opts.headers,
      },
      payload: JSON.stringify({
        clientMessageId: opts.clientMessageId ?? randomUUID(),
        text,
      }),
    }),
  );
}

export async function getWebMessages(
  app: FastifyInstance,
  token: string,
  after?: string | null,
  ip?: string,
): Promise<WebResponse> {
  const query = after ? `?after=${encodeURIComponent(after)}` : '';
  return wrap(
    await app.inject({
      method: 'GET',
      url: `/chat/api/messages${query}`,
      headers: webHeaders(token),
      ...(ip ? { remoteAddress: ip } : {}),
    }),
  );
}

export async function getWebState(
  app: FastifyInstance,
  token: string,
  ip?: string,
): Promise<WebResponse> {
  return wrap(
    await app.inject({
      method: 'GET',
      url: '/chat/api/state',
      headers: webHeaders(token),
      ...(ip ? { remoteAddress: ip } : {}),
    }),
  );
}

export interface WebMessage {
  id: string;
  from: 'visitor' | 'bot';
  text: string;
  at: string;
}

/** Mensajes de una respuesta de `GET /chat/api/messages`. */
export const messagesOf = (res: WebResponse): WebMessage[] =>
  Array.isArray(res.body.messages) ? (res.body.messages as WebMessage[]) : [];
