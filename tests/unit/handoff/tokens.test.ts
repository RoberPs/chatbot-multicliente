import { describe, expect, it } from 'vitest';
import {
  buttonPayload,
  createTokenCipher,
  hashToken,
  isTokenFormat,
  issueToken,
  parseButtonPayload,
} from '../../../src/handoff/tokens.js';

const SECRET = '3f9a1c7e5b2d4086a1e3c5f7092b4d6e8a0c2e4f6183a5c7e9b1d3f5a7c9e0b2';
const OTHER_SECRET = 'a1e3c5f7092b4d6e8a0c2e4f6183a5c7e9b1d3f5a7c9e0b23f9a1c7e5b2d4086';

describe('tokens de acción (R9)', () => {
  it('22 caracteres base64url y distinto en cada llamada', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => issueToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(isTokenFormat(token)).toBe(true);
    }
  });

  it('hashToken es estable y de 32 bytes', () => {
    const token = issueToken();
    expect(hashToken(token)).toHaveLength(32);
    expect(hashToken(token).equals(hashToken(token))).toBe(true);
    expect(hashToken(token).equals(hashToken(issueToken()))).toBe(false);
  });

  it('payload de los botones: h1:<acción>:<token>', () => {
    const token = issueToken();
    expect(buttonPayload('attend', token)).toBe(`h1:attend:${token}`);
    expect(parseButtonPayload(`h1:attend:${token}`)).toEqual({ action: 'attend', token });
    expect(parseButtonPayload(`h1:end:${token}`)).toEqual({ action: 'end', token });
  });

  it.each([
    ['otra versión', (t: string) => `h2:end:${t}`],
    ['acción desconocida', (t: string) => `h1:close:${t}`],
    ['token corto', (t: string) => `h1:end:${t.slice(1)}`],
    ['token largo', (t: string) => `h1:end:${t}x`],
    ['caracteres no base64url', (t: string) => `h1:end:${t.slice(1)}+`],
    ['partes de más', (t: string) => `h1:end:${t}:x`],
    ['vacío', () => ''],
  ])('rechaza un payload con %s', (_name, build) => {
    expect(parseButtonPayload(build(issueToken()))).toBeNull();
  });

  it('isTokenFormat rechaza lo que no es un token', () => {
    expect(isTokenFormat('abc')).toBe(false);
    expect(isTokenFormat('a'.repeat(21) + '=')).toBe(false);
    expect(isTokenFormat('../'.repeat(8))).toBe(false);
  });
});

describe('token cifrado (ajuste de R9)', () => {
  it('cifra y descifra con la clave derivada del secreto', () => {
    const cipher = createTokenCipher(SECRET);
    const token = issueToken();
    const sealed = cipher.encrypt(token);
    expect(sealed.toString('utf8')).not.toContain(token);
    expect(cipher.decrypt(sealed)).toBe(token);
    // Cada cifrado lleva su propio nonce.
    expect(cipher.encrypt(token).equals(sealed)).toBe(false);
  });

  it('con otro secreto o con el dato alterado → null', () => {
    const sealed = createTokenCipher(SECRET).encrypt(issueToken());
    expect(createTokenCipher(OTHER_SECRET).decrypt(sealed)).toBeNull();
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    expect(createTokenCipher(SECRET).decrypt(tampered)).toBeNull();
    expect(createTokenCipher(SECRET).decrypt(Buffer.from('corto'))).toBeNull();
  });
});
