/**
 * Sesión anónima del visitante del chat web (004 US3, research R4, FR-018, FR-029).
 *
 * No hay tabla de sesiones: el token es `base64url(id) . base64url(HMAC(id))` con una clave
 * derivada de `SESSION_SECRET`. La base de datos guarda solo `hex(SHA-256(id))`, así que ni el
 * token ni nada que permita reconstruirlo llegan a persistirse (ni a los registros).
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** Bytes del identificador de sesión. */
const ID_BYTES = 16;
/** Separa el HMAC del chat de cualquier otro uso del mismo secreto (R11 de la 002). */
const INFO = 'web-session';

export interface WebSession {
  /** Lo que guarda el navegador y manda en `Authorization: Bearer`. */
  token: string;
  /** Identificador del cliente en el canal `web`: 64 hex. */
  channelUserId: string;
}

/** Clave del HMAC derivada del secreto de la instancia. */
function signingKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), INFO, 32));
}

const sign = (secret: string, id: Buffer): string =>
  createHmac('sha256', signingKey(secret)).update(id).digest('base64url');

const userIdOf = (id: Buffer): string => createHash('sha256').update(id).digest('hex');

/** Crea una sesión nueva; el token no se guarda en ningún sitio. */
export function issueWebSession(secret: string): WebSession {
  const id = randomBytes(ID_BYTES);
  return {
    token: `${id.toString('base64url')}.${sign(secret, id)}`,
    channelUserId: userIdOf(id),
  };
}

/** `channelUserId` si el token lo firmó esta instancia; `null` en cualquier otro caso. */
export function verifyWebSession(secret: string, token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [rawId = '', signature = ''] = parts;
  if (rawId === '' || signature === '') return null;

  const id = Buffer.from(rawId, 'base64url');
  // `Buffer.from` ignora lo que no sea base64url: se exige la longitud exacta.
  if (id.length !== ID_BYTES || id.toString('base64url') !== rawId) return null;

  const expected = Buffer.from(sign(secret, id), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  if (expected.length !== received.length) return null;
  if (!timingSafeEqual(expected, received)) return null;
  return userIdOf(id);
}
