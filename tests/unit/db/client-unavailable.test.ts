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

  /**
   * Así llega el fallo de verdad cuando el servidor no está: Node intenta IPv4 e IPv6 y agrupa
   * los dos `ECONNREFUSED` en un `AggregateError` cuyo propio `code` no dice nada. Mirar solo
   * `cause` dejaba fuera el caso de producción, y lo destapó la prueba del corte real, no estas.
   */
  it('atraviesa los errors de un AggregateError', () => {
    const aggregate = new AggregateError(
      [coded('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5432'), coded('ECONNREFUSED')],
      'no se pudo conectar',
    );
    expect(isDbUnavailable(aggregate)).toBe(true);
    // Y también envuelto por Drizzle, que es como llega al dominio.
    expect(isDbUnavailable(new Error('fallo de consulta', { cause: aggregate }))).toBe(true);
  });

  it('un AggregateError cuyos errores no son de disponibilidad no cuenta', () => {
    expect(isDbUnavailable(new AggregateError([coded('42601'), new Error('x')], 'varios'))).toBe(
      false,
    );
  });

  /**
   * Los dos textos para los que `pg` no da código. Es como llega el fallo en producción cuando
   * se reutiliza una conexión ociosa que el servidor ya cerró, y por eso hace falta mirarlos:
   * lo destapó la prueba del corte real, no estas.
   */
  it.each([
    'Connection terminated unexpectedly',
    'Client has encountered a connection error and is not queryable',
  ])('reconoce el texto sin código de pg: %s', (message) => {
    expect(isDbUnavailable(new Error(message))).toBe(true);
    // Y envuelto por Drizzle, que es como llega al dominio.
    expect(
      isDbUnavailable(new Error('Failed query: select 1', { cause: new Error(message) })),
    ).toBe(true);
  });

  it('con código, manda el código: un texto parecido con código de sintaxis no cuenta', () => {
    const e = Object.assign(new Error('Connection terminated unexpectedly'), { code: '42601' });
    expect(isDbUnavailable(e)).toBe(false);
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
