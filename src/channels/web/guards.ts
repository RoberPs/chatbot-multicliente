/**
 * Comprobaciones del chat web que dependen de cabeceras HTTP (004, FR-027,
 * contracts/web-chat-http.md). Lo que conoce el navegador vive aquí, no en `src/webchat`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ActivityLog } from '../../conversation/activity-log.js';
import type { WebChatSettings } from '../../webchat/settings.js';
import { verifyWebSession } from '../../webchat/session-token.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Visitante del chat web tras comprobar la firma del token (solo en `/chat/api`). */
    webVisitor?: { channelUserId: string };
  }
}

/** Ningún origen puede incrustar el frame. */
export const NO_ANCESTORS = "'none'";

/**
 * Valor de `frame-ancestors` para la CSP del frame: los orígenes permitidos cuando el chat
 * está activado, `'none'` en cualquier otro caso (el navegador impide la incrustación).
 */
export function frameAncestors(settings: WebChatSettings | null): string {
  if (!settings?.enabled || settings.allowedOrigins.length === 0) return NO_ANCESTORS;
  return settings.allowedOrigins.join(' ');
}

/** Origen de una URL de cabecera (`Referer`, `Origin`) en minúsculas; `null` si no es una URL. */
export function headerOrigin(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * El `Referer`, cuando llega, viene de una web permitida (FR-027). Si no llega no se puede
 * comprobar y se deja pasar: `frame-ancestors` es lo que de verdad impide la incrustación.
 */
export function refererAllowed(
  referer: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  const origin = headerOrigin(referer);
  return origin === null || allowedOrigins.includes(origin);
}

/**
 * Origen de esta instancia: `PUBLIC_BASE_URL` si la hay, o el de la propia petición. Se
 * normaliza con `URL` igual que el de la cabecera, para que `:80` y `:443` no descuadren la
 * comparación (el navegador nunca los manda).
 */
export function instanceOrigin(request: FastifyRequest): string {
  return (
    request.server.env.PUBLIC_BASE_URL ??
    headerOrigin(`${request.protocol}://${request.host}`) ??
    ''
  );
}

export interface GuardDeps {
  /** Registro técnico del bot; sin bot no hay dónde anotar los rechazos. */
  activityLog: ActivityLog | null;
}

/**
 * Los `POST` de la API tienen que venir del propio iframe (FR-027): `Origin` igual al de la
 * instancia y, si el navegador la manda, `Sec-Fetch-Site: same-origin`.
 */
export function requireSameOrigin({ activityLog }: GuardDeps) {
  return async function sameOrigin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (request.method !== 'POST') return;
    const site = request.headers['sec-fetch-site'];
    const sameSite = typeof site !== 'string' || site === 'same-origin';
    if (headerOrigin(request.headers.origin) === instanceOrigin(request) && sameSite) return;
    activityLog?.log({ event: 'web_rejected', reason: 'origin' });
    await reply.code(403).send({ error: 'forbidden' });
  };
}

/**
 * Sesión del visitante en `Authorization: Bearer` (R4). Deja el `channelUserId` en la petición;
 * el token no se guarda ni se registra en ninguna parte.
 */
export function requireWebSession({ secret, activityLog }: GuardDeps & { secret: string }) {
  return async function webSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    const raw =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const channelUserId = raw === '' ? null : verifyWebSession(secret, raw);
    if (channelUserId === null) {
      activityLog?.log({ event: 'web_rejected', reason: 'session' });
      await reply.code(401).send({ error: 'session' });
      return;
    }
    request.webVisitor = { channelUserId };
  };
}
