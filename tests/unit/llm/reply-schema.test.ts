/**
 * Los dialectos del JSON Schema de la respuesta (017, R7).
 *
 * El test del dialecto `anthropic` es **de regresión**: fija letra por letra el esquema que se
 * enviaba antes de que existieran los dialectos. Si la refactorización lo hubiese cambiado, una
 * instancia de Anthropic en producción empezaría a recibir un esquema distinto, y eso es justo lo
 * que el punto de control de la fase 2 (T024) existe para impedir.
 */
import { describe, expect, it } from 'vitest';
import { replyJsonSchema } from '../../../src/llm/reply-schema.js';

/** El esquema tal y como lo producía `replyJsonSchema()` antes de la 017. */
const ANTHROPIC_SCHEMA_BEFORE_017 = {
  type: 'object',
  properties: {
    body: { type: 'string' },
    handoffRequested: { type: 'boolean' },
    offerContact: { type: 'boolean' },
    bookingRequested: { type: 'boolean' },
    needsRephrase: { type: 'boolean' },
    mentionedServiceIds: { type: 'array', items: { type: 'string' } },
    complaint: { type: 'boolean' },
    acceptsHandoff: { type: 'boolean' },
    refusesContact: { type: 'boolean' },
    contactName: { type: ['string', 'null'] },
    contactPhone: { type: ['string', 'null'] },
  },
  required: [
    'body',
    'handoffRequested',
    'offerContact',
    'bookingRequested',
    'needsRephrase',
    'mentionedServiceIds',
  ],
  additionalProperties: false,
};

describe('dialecto anthropic', () => {
  it('produce exactamente el mismo esquema que antes de la 017', () => {
    expect(replyJsonSchema('anthropic')).toEqual(ANTHROPIC_SCHEMA_BEFORE_017);
  });

  it('es el dialecto por defecto', () => {
    expect(replyJsonSchema()).toEqual(replyJsonSchema('anthropic'));
  });

  it('no lleva ninguna clave que la salida estructurada no admita', () => {
    const texto = JSON.stringify(replyJsonSchema('anthropic'));
    for (const clave of ['$schema', 'maxLength', 'minLength', 'default']) {
      expect(texto).not.toContain(clave);
    }
  });

  it('deja opcionales los campos de la derivación, que el dominio rellena por defecto', () => {
    const schema = replyJsonSchema('anthropic') as { required: string[] };
    for (const campo of ['complaint', 'acceptsHandoff', 'refusesContact']) {
      expect(schema.required).not.toContain(campo);
    }
  });
});
