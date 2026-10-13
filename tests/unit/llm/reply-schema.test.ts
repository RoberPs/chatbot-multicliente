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

/** Los campos de la derivación (005), que el dominio deja opcionales. */
const OPCIONALES = ['complaint', 'acceptsHandoff', 'refusesContact', 'contactName', 'contactPhone'];
const OBLIGATORIOS = [
  'body',
  'handoffRequested',
  'offerContact',
  'bookingRequested',
  'needsRephrase',
  'mentionedServiceIds',
];

interface Esquema {
  type: string;
  properties: Record<string, { type?: unknown }>;
  required: string[];
  additionalProperties?: boolean;
}

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

describe('dialecto gemini', () => {
  it('es la misma limpieza que anthropic', () => {
    // Su documentación dice que ignora las propiedades que no admite, así que quitarlas es
    // inofensivo y deja un esquema más pequeño (R7).
    expect(replyJsonSchema('gemini')).toEqual(replyJsonSchema('anthropic'));
  });

  it('deja los opcionales fuera de required, como el dominio', () => {
    const schema = replyJsonSchema('gemini') as unknown as Esquema;
    for (const campo of OPCIONALES) expect(schema.required).not.toContain(campo);
  });
});

describe('dialecto openai (R7)', () => {
  // El modo estricto de OpenAI **no admite propiedades opcionales**, y `modelReplySchema` tiene
  // opcionales. Se resuelve aquí —promover a requerido admitiendo `null`—, no en el dominio.
  it('promueve TODO opcional a requerido', () => {
    const schema = replyJsonSchema('openai') as unknown as Esquema;
    for (const campo of [...OBLIGATORIOS, ...OPCIONALES]) {
      expect(schema.required).toContain(campo);
    }
    expect([...schema.required].sort()).toEqual(
      [...Object.keys(schema.properties)].sort(),
    );
  });

  it('cada opcional promovido admite null', () => {
    const schema = replyJsonSchema('openai') as unknown as Esquema;
    for (const campo of OPCIONALES) {
      const tipo = schema.properties[campo]?.type;
      expect(Array.isArray(tipo) ? tipo : [tipo]).toContain('null');
    }
  });

  it('no cambia el tipo de los que ya eran obligatorios', () => {
    const openai = replyJsonSchema('openai') as unknown as Esquema;
    const anthropic = replyJsonSchema('anthropic') as unknown as Esquema;
    for (const campo of OBLIGATORIOS) {
      expect(openai.properties[campo]).toEqual(anthropic.properties[campo]);
    }
  });

  it('pone additionalProperties: false en cada objeto', () => {
    const schema = replyJsonSchema('openai');
    const objetos: Array<Record<string, unknown>> = [];
    const recorrer = (nodo: unknown): void => {
      if (Array.isArray(nodo)) {
        for (const hijo of nodo) recorrer(hijo);
        return;
      }
      if (nodo === null || typeof nodo !== 'object') return;
      const obj = nodo as Record<string, unknown>;
      if (obj.type === 'object') objetos.push(obj);
      for (const valor of Object.values(obj)) recorrer(valor);
    };
    recorrer(schema);
    expect(objetos.length).toBeGreaterThan(0);
    for (const obj of objetos) expect(obj.additionalProperties).toBe(false);
  });

  it('sigue sin llevar claves que la salida estructurada no admita', () => {
    const texto = JSON.stringify(replyJsonSchema('openai'));
    for (const clave of ['$schema', 'maxLength', 'minLength', '"default"']) {
      expect(texto).not.toContain(clave);
    }
  });
});
