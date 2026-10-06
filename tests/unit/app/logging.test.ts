/**
 * Registros sin datos (012, US8, SC-009; contracts/logging-and-startup.md § Registros): el
 * serializador de errores deja solo tipo, código y estado HTTP, y la URL registrada solo los
 * nombres de los parámetros de la consulta.
 */
import { describe, expect, it } from 'vitest';
import { loggedUrl, serializeError } from '../../../src/app.js';

const PHONE = '+34600111222';
const EMAIL = 'ana@ejemplo.com';
const TEXT = 'Quiero cambiar mi cita del jueves';
const TOKEN = 'EAAGm4Kq7pX2vR9tL4wN8bZ3cY6dF1hJ5sQ0uE7gT2kM9n';

describe('serializador de errores', () => {
  it('solo { type, code?, statusCode? } aunque el error lleve datos en todas partes', () => {
    const error = Object.assign(new TypeError(`Fallo con ${PHONE} y ${EMAIL}: ${TEXT}`), {
      code: 'E_FALLO',
      statusCode: 502,
      phone: PHONE,
      body: TEXT,
      token: TOKEN,
      cause: new Error(`causa con ${TOKEN}`),
    });
    const serialized = serializeError(error);
    expect(serialized).toEqual({ type: 'TypeError', code: 'E_FALLO', statusCode: 502 });
    const text = JSON.stringify(serialized);
    for (const value of [PHONE, EMAIL, TEXT, TOKEN, 'stack']) expect(text).not.toContain(value);
  });

  it('sin código ni estado, solo el tipo; valores que no son errores, su tipo', () => {
    expect(serializeError(new Error(TEXT))).toEqual({ type: 'Error' });
    expect(serializeError(Object.assign(new Error('x'), { code: 23505 }))).toEqual({
      type: 'Error',
      code: '23505',
    });
    expect(serializeError(TEXT)).toEqual({ type: 'string' });
    expect(serializeError(null)).toEqual({ type: 'object' });
  });
});

describe('URL registrada', () => {
  it('solo los nombres de los parámetros de la consulta', () => {
    expect(
      loggedUrl(
        `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${TOKEN}&hub.challenge=123`,
      ),
    ).toBe('/webhooks/whatsapp?hub.mode&hub.verify_token&hub.challenge');
    expect(loggedUrl(`/chat/api/messages?after=${TOKEN}`)).toBe('/chat/api/messages?after');
    expect(loggedUrl('/admin/usage?month=2026-09')).toBe('/admin/usage?month');
    expect(loggedUrl('/admin?')).toBe('/admin');
    expect(loggedUrl('/admin')).toBe('/admin');
  });

  it('el token de /handoff/<token> sigue sustituido', () => {
    expect(loggedUrl(`/handoff/${TOKEN}/attend?x=1`)).toBe('/handoff/:token/attend?x');
  });
});
