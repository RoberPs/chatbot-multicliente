/**
 * Token de sesión del visitante (004 US3, research R4): firmado por la instancia, sin tabla de
 * sesiones. El identificador del cliente en el canal es el hash del id, nunca el token.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueWebSession, verifyWebSession } from '../../../src/webchat/session-token.js';

const SECRET = '3f9a1c7e5b2d4086a1e3c5f7092b4d6e8a0c2e4f6183a5c7e9b1d3f5a7c9e0b2';
const OTRO = 'ff'.repeat(32);

describe('token de sesión del chat web', () => {
  it('el token es dos partes base64url y verifica con el mismo secreto', () => {
    const { token, channelUserId } = issueWebSession(SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(channelUserId).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyWebSession(SECRET, token)).toBe(channelUserId);
  });

  it('el channel_user_id es SHA-256 del id y es estable', () => {
    const { token, channelUserId } = issueWebSession(SECRET);
    const id = token.split('.')[0] ?? '';
    expect(channelUserId).toBe(
      createHash('sha256').update(Buffer.from(id, 'base64url')).digest('hex'),
    );
    expect(verifyWebSession(SECRET, token)).toBe(verifyWebSession(SECRET, token));
  });

  it('dos sesiones dan identificadores distintos', () => {
    const a = issueWebSession(SECRET);
    const b = issueWebSession(SECRET);
    expect(a.token).not.toBe(b.token);
    expect(a.channelUserId).not.toBe(b.channelUserId);
  });

  it('rechaza la firma alterada, el formato inválido y otro secreto', () => {
    const { token } = issueWebSession(SECRET);
    const [id = '', signature = ''] = token.split('.');
    const otraFirma = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;

    expect(verifyWebSession(SECRET, `${id}.${otraFirma}`)).toBeNull();
    expect(verifyWebSession(SECRET, id)).toBeNull();
    expect(verifyWebSession(SECRET, `${id}.${signature}.extra`)).toBeNull();
    expect(verifyWebSession(SECRET, '')).toBeNull();
    expect(verifyWebSession(SECRET, '.')).toBeNull();
    expect(verifyWebSession(SECRET, `${id}.`)).toBeNull();
    // Un id de otra longitud no vale aunque se firme bien.
    const largo = issueWebSession(SECRET);
    expect(verifyWebSession(SECRET, `${largo.token}x`)).toBeNull();
    expect(verifyWebSession(OTRO, token)).toBeNull();
  });
});
