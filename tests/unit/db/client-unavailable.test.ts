/**
 * `isDbUnavailable` (016, T003; data-model §2, research R2): reconocer «la base de datos no
 * está» **por código**, nunca por texto, y a través de los envoltorios de Drizzle.
 */
import { describe, expect, it } from 'vitest';
import { isDbUnavailable } from '../../../src/db/client.js';

/** Error con código, como los de `pg` y los de red de Node. */
const coded = (code: string, message = 'fallo'): Error =>
  Object.assign(new Error(message), { code });

/** Envuelve un error en `cause` tantos niveles como Drizzle llegue a envolverlo. */
const wrap = (error: unknown, levels: number): Error => {
  let e: unknown = error;
  for (let i = 0; i < levels; i++) e = new Error(`nivel ${i}`, { cause: e });
  return e as Error;
};

describe('isDbUnavailable', () => {
  const unavailable = [
    // Red de Node: el servidor no está, se cayó la conexión o no resuelve.
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
    'EPIPE',
    // Socket Unix que no existe: la forma de producción cuando PostgreSQL no está.
    'ENOENT',
    // SQLSTATE clase 08: fallos de conexión.
    '08000',
    '08003',
    '08006',
    '08001',
    '08004',
    '08007',
    '08P01',
    // El servidor se está apagando o cancela la sesión del administrador.
    '57P01',
    '57P02',
    '57P03',
  ];

  it.each(unavailable)('reconoce %s', (code) => {
    expect(isDbUnavailable(coded(code))).toBe(true);
  });

  it('reconoce el pool agotado (isPoolBusy), que también es «no contesta»', () => {
    expect(isDbUnavailable(new Error('timeout exceeded when trying to connect'))).toBe(true);
  });

  it.each([1, 2, 3, 4])('atraviesa %i niveles de cause', (levels) => {
    expect(isDbUnavailable(wrap(coded('ECONNREFUSED'), levels))).toBe(true);
  });

  it('no mira más allá de cinco niveles', () => {
    expect(isDbUnavailable(wrap(coded('ECONNREFUSED'), 9))).toBe(false);
  });

  const available: Array<[string, unknown]> = [
    ['error de sintaxis SQL', coded('42601')],
    ['violación de unicidad', coded('23505')],
    ['columna inexistente', coded('42703')],
    ['plazo de sentencia agotado', coded('57014')],
    ['error sin código', new Error('algo')],
    ['código que no es texto', Object.assign(new Error('x'), { code: 42 })],
    ['null', null],
    ['undefined', undefined],
    ['texto suelto', 'ECONNREFUSED'],
  ];

  it.each(available)('no toma por indisponibilidad: %s', (_name, error) => {
    expect(isDbUnavailable(error)).toBe(false);
  });
});
