import { describe, expect, it } from 'vitest';
import { parseBearer, verifyHealthSecret } from '../../../src/health/secret.js';

const SECRET = '7d1e9b3f5a2c4086e1a3c5f7092b4d6e8a0c2e4f6183a5c7e9b1d3f5a7c9e0b5';

describe('verifyHealthSecret (009, R2)', () => {
  it('acepta el secreto exacto', () => {
    expect(verifyHealthSecret(SECRET, SECRET)).toBe(true);
  });

  it('acepta el secreto en mayúsculas (el entorno se normaliza a minúsculas)', () => {
    expect(verifyHealthSecret(SECRET, SECRET.toUpperCase())).toBe(true);
  });

  it.each([
    ['otro valor', SECRET.replace(/.$/, '0')],
    ['más corto', SECRET.slice(0, 32)],
    ['más largo', `${SECRET}00`],
    ['vacío', ''],
  ])('rechaza %s sin lanzar', (_name, received) => {
    expect(verifyHealthSecret(SECRET, received)).toBe(false);
  });
});

describe('parseBearer', () => {
  it('sin cabecera → absent', () => {
    expect(parseBearer(undefined)).toEqual({ kind: 'absent' });
  });

  it('Bearer <valor> → el valor', () => {
    expect(parseBearer(`Bearer ${SECRET}`)).toEqual({ kind: 'bearer', value: SECRET });
    expect(parseBearer(`bearer   ${SECRET}  `)).toEqual({ kind: 'bearer', value: SECRET });
  });

  it.each([['Basic dXNlcjpwYXNz'], ['Bearer'], ['Bearer   '], [''], [SECRET], ['Bearer a b']])(
    '«%s» → malformed',
    (header) => {
      expect(parseBearer(header)).toEqual({ kind: 'malformed' });
    },
  );

  it('varias cabeceras → malformed', () => {
    expect(parseBearer(['Bearer a', 'Bearer b'])).toEqual({ kind: 'malformed' });
  });
});
