/**
 * Clave común de los límites por dirección (012, FR-020; contracts/public-routes-and-login.md):
 * una IPv6 cuenta por su bloque /64, así que cambiar de dirección dentro del mismo bloque no da
 * un límite nuevo.
 */
import { describe, expect, it } from 'vitest';
import { clientKey } from '../../../src/channels/client-key.js';

describe('clientKey', () => {
  it.each([
    ['IPv4 tal cual', '203.0.113.7', '203.0.113.7'],
    ['IPv4 mapeada en IPv6', '::ffff:203.0.113.7', '203.0.113.7'],
    ['IPv4 mapeada en mayúsculas', '::FFFF:203.0.113.7', '203.0.113.7'],
    ['IPv4 mapeada en hexadecimal', '::ffff:cb00:7107', '203.0.113.7'],
    ['IPv6 reducida a su /64', '2001:db8:1:2:aaaa::1', '2001:db8:1:2::/64'],
    ['otra dirección del mismo /64', '2001:db8:1:2:ffff:ffff:ffff:fffe', '2001:db8:1:2::/64'],
    [
      'forma expandida con ceros',
      '2001:0db8:0001:0002:ffff:0000:0000:0001',
      '2001:db8:1:2::/64',
    ],
    ['en mayúsculas', '2001:DB8:1:2::AB', '2001:db8:1:2::/64'],
    ['con ceros dentro del /64', '2001:db8::5', '2001:db8::/64'],
    ['con zona', 'fe80::1%eth0', 'fe80::/64'],
    ['bucle local', '::1', '::/64'],
    ['entrada no válida: la cadena tal cual', 'no-es-una-ip', 'no-es-una-ip'],
    ['vacía', '', ''],
  ])('%s', (_name, ip, key) => {
    expect(clientKey(ip)).toBe(key);
  });

  it('dos /64 distintos dan claves distintas', () => {
    expect(clientKey('2001:db8:1:2::1')).not.toBe(clientKey('2001:db8:1:3::1'));
  });
});
