/** 003, FR-001 – FR-004: casilla "Quitar" en cada medio del contacto de derivación. */
import { describe, expect, it } from 'vitest';
import { handoffSchema } from '../../../src/knowledge/schemas/handoff.js';
import { errorsOf, parseOk } from '../../helpers/schema.js';

describe('handoffSchema: channels[i].remove', () => {
  const schema = handoffSchema('ES');

  it('una fila marcada se descarta aunque su valor no sea válido', () => {
    expect(
      parseOk(schema, {
        channels: [
          { type: 'phone', value: 'abc', remove: 'on' },
          { type: 'whatsapp', value: '611 222 333' },
        ],
      }),
    ).toEqual({ channels: [{ type: 'whatsapp', value: '+34611222333' }], slots: [] });
  });

  it('los errores de las filas no marcadas conservan su índice original', () => {
    expect(
      errorsOf(schema, {
        channels: [
          { type: 'phone', value: '611 222 333' },
          { type: 'phone', value: 'abc', remove: 'on' },
          { type: 'phone', value: 'xyz' },
        ],
      }),
    ).toEqual({ 'channels[2].value': 'Teléfono no válido' });
  });

  it('mantiene el orden de los medios restantes', () => {
    expect(
      parseOk(schema, {
        channels: [
          { type: 'email', value: 'a@b.es' },
          { type: 'phone', value: '600 111 222', remove: 'on' },
          { type: 'whatsapp', value: '611 222 333' },
          { type: 'phone', value: '600 333 444' },
        ],
      }).channels,
    ).toEqual([
      { type: 'email', value: 'a@b.es' },
      { type: 'whatsapp', value: '+34611222333' },
      { type: 'phone', value: '+34600333444' },
    ]);
  });

  it('marcar todas → sin medios', () => {
    expect(
      parseOk(schema, {
        channels: [
          { type: 'email', value: 'a@b.es', remove: 'on' },
          { type: 'phone', value: '600 111 222', remove: 'on' },
        ],
      }).channels,
    ).toEqual([]);
  });

  it('un medio repetido con la copia marcada no da error de repetido', () => {
    expect(
      parseOk(schema, {
        channels: [
          { type: 'phone', value: '600 111 222' },
          { type: 'phone', value: '600111222', remove: 'on' },
        ],
      }).channels,
    ).toEqual([{ type: 'phone', value: '+34600111222' }]);
  });

  it('sin la casilla la fila se guarda como hasta ahora', () => {
    expect(
      parseOk(schema, { channels: [{ type: 'phone', value: '600 111 222' }] }).channels,
    ).toEqual([{ type: 'phone', value: '+34600111222' }]);
  });
});
