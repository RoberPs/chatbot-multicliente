/** T130 / FR-022: el token de los enlaces del email no llega a los registros de peticiones. */
import { describe, expect, it } from 'vitest';
import { loggedUrl } from '../../../src/app.js';

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';

describe('URL de los registros de peticiones', () => {
  it('sustituye el token de /handoff/<token>/…', () => {
    expect(loggedUrl(`/handoff/${TOKEN}/attend`)).toBe('/handoff/:token/attend');
    // 012: de la consulta solo quedan los nombres.
    expect(loggedUrl(`/handoff/${TOKEN}/end?x=1`)).toBe('/handoff/:token/end?x');
    expect(loggedUrl(`/handoff/${TOKEN}`)).toBe('/handoff/:token');
  });

  it('deja igual el CSS de las páginas y la ruta del resto', () => {
    expect(loggedUrl('/handoff/assets/handoff.css')).toBe('/handoff/assets/handoff.css');
    expect(loggedUrl('/admin/handoffs')).toBe('/admin/handoffs');
    expect(loggedUrl(`/chat/api/messages?t=${TOKEN}`)).toBe('/chat/api/messages?t');
  });
});
