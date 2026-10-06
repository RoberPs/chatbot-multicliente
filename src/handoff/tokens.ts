/**
 * Tokens de acción de la derivación (005, R9). Un token de 128 bits por derivación liga los
 * botones de WhatsApp y los enlaces del email a ella. En la BD se busca por `sha256(token)` y se
 * guarda además cifrado (AES-256-GCM, clave derivada de SESSION_SECRET) para poder poner los
 * mismos botones en los reenvíos y el recordatorio.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

export type HandoffButtonAction = 'attend' | 'end';

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const PAYLOAD_RE = /^h1:(attend|end):([A-Za-z0-9_-]{22})$/;

/** Token nuevo: 16 bytes aleatorios en base64url (22 caracteres). */
export function issueToken(): string {
  return randomBytes(16).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Formato de un token (rutas `/handoff/:token/:action`); no dice si existe. */
export function isTokenFormat(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** Payload de un botón de respuesta rápida: `h1:<acción>:<token>`. */
export function buttonPayload(action: HandoffButtonAction, token: string): string {
  return `h1:${action}:${token}`;
}

export function parseButtonPayload(
  payload: string,
): { action: HandoffButtonAction; token: string } | null {
  const match = PAYLOAD_RE.exec(payload);
  if (!match) return null;
  return { action: match[1] as HandoffButtonAction, token: match[2] ?? '' };
}

export interface TokenCipher {
  encrypt(token: string): Buffer;
  /** `null` si no se puede descifrar (otro secreto o dato alterado). */
  decrypt(sealed: Buffer): string | null;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Cifrado del token con una clave derivada de SESSION_SECRET (sin secreto nuevo, como R17). */
export function createTokenCipher(sessionSecret: string): TokenCipher {
  const key = Buffer.from(
    hkdfSync('sha256', Buffer.from(sessionSecret, 'hex'), '', 'handoff-token', 32),
  );
  return {
    encrypt(token) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]);
    },
    decrypt(sealed) {
      if (sealed.length <= NONCE_BYTES + TAG_BYTES) return null;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, NONCE_BYTES));
        decipher.setAuthTag(sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
        const token = Buffer.concat([
          decipher.update(sealed.subarray(NONCE_BYTES + TAG_BYTES)),
          decipher.final(),
        ]).toString('utf8');
        return isTokenFormat(token) ? token : null;
      } catch {
        return null;
      }
    },
  };
}
