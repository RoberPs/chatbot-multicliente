/**
 * Secreto de salud (009, research R2): lectura de la cabecera `Authorization: Bearer` y
 * comparación sin fugas. Se compara el SHA-256 de ambos valores con `timingSafeEqual`: longitud
 * fija y tiempo constante, sin importar cuánto mida lo recibido (FR-001b).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export type BearerHeader =
  { kind: 'absent' } | { kind: 'malformed' } | { kind: 'bearer'; value: string };

/** Interpreta la cabecera `Authorization`; cualquier otra forma que `Bearer <valor>` es `malformed`. */
export function parseBearer(header: string | string[] | undefined): BearerHeader {
  if (header === undefined) return { kind: 'absent' };
  if (Array.isArray(header)) return { kind: 'malformed' };
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
  return match?.[1] ? { kind: 'bearer', value: match[1] } : { kind: 'malformed' };
}

const digest = (value: string): Buffer =>
  createHash('sha256').update(value.trim().toLowerCase(), 'utf8').digest();

/** `true` si `received` es el secreto de la instancia (en minúsculas, recortado). */
export function verifyHealthSecret(expected: string, received: string): boolean {
  if (received.trim() === '') return false;
  return timingSafeEqual(digest(expected), digest(received));
}
