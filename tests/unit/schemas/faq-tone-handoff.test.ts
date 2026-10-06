import { describe, expect, it } from 'vitest';
import { faqSchema } from '../../../src/knowledge/schemas/faq.js';
import { handoffSchema } from '../../../src/knowledge/schemas/handoff.js';
import { toneSchema } from '../../../src/knowledge/schemas/tone.js';
import { errorsOf, parseOk } from '../../helpers/schema.js';

describe('faqSchema', () => {
  it('pregunta 1–500 y respuesta 1–4000', () => {
    expect(errorsOf(faqSchema, { question: '', answer: 'x' })).toHaveProperty('question');
    expect(errorsOf(faqSchema, { question: 'x'.repeat(501), answer: 'x' })).toHaveProperty(
      'question',
    );
    expect(errorsOf(faqSchema, { question: 'x', answer: 'x'.repeat(4001) })).toHaveProperty(
      'answer',
    );
    expect(parseOk(faqSchema, { question: ' ¿Hay parking? ', answer: 'Sí' })).toEqual({
      question: '¿Hay parking?',
      answer: 'Sí',
    });
  });
});

describe('toneSchema', () => {
  it('el tratamiento es obligatorio y el estilo como mucho 2000 caracteres', () => {
    expect(errorsOf(toneSchema, {})).toHaveProperty('address_form');
    expect(
      errorsOf(toneSchema, { address_form: 'formal', style_description: 'x'.repeat(2001) }),
    ).toHaveProperty('style_description');
    expect(parseOk(toneSchema, { address_form: 'formal', style_description: '' })).toEqual({
      addressForm: 'formal',
      styleDescription: null,
    });
  });
});

describe('handoffSchema', () => {
  const schema = handoffSchema('ES');

  it('normaliza teléfono/WhatsApp a E.164 y email a minúsculas', () => {
    expect(
      parseOk(schema, {
        channels: [
          { type: 'whatsapp', value: '611 222 333' },
          { type: 'email', value: 'Ayuda@Ejemplo.es' },
        ],
        slots: [{ weekday: '1', start: '10:00', end: '13:00' }],
      }),
    ).toEqual({
      channels: [
        { type: 'whatsapp', value: '+34611222333' },
        { type: 'email', value: 'ayuda@ejemplo.es' },
      ],
      slots: [{ weekday: 1, start: '10:00', end: '13:00' }],
    });
  });

  it('valida el valor según el tipo', () => {
    expect(errorsOf(schema, { channels: [{ type: 'phone', value: 'foo@bar.es' }] })).toEqual({
      'channels[0].value': 'Teléfono no válido',
    });
    expect(errorsOf(schema, { channels: [{ type: 'email', value: 'foo@' }] })).toHaveProperty([
      'channels[0].value',
    ]);
  });

  it('(tipo, valor) duplicado → error en channels[i].value', () => {
    expect(
      errorsOf(schema, {
        channels: [
          { type: 'phone', value: '600123456' },
          { type: 'phone', value: '+34 600 123 456' },
        ],
      }),
    ).toEqual({ 'channels[1].value': 'Este medio está repetido' });
  });

  it('el mismo número como teléfono y como WhatsApp es válido', () => {
    expect(
      errorsOf(schema, {
        channels: [
          { type: 'phone', value: '600123456' },
          { type: 'whatsapp', value: '600123456' },
        ],
      }),
    ).toEqual({});
  });

  it('valida las franjas con las reglas semanales', () => {
    expect(
      errorsOf(schema, { slots: [{ weekday: '1', start: '13:00', end: '10:00' }] }),
    ).toHaveProperty(['slots[0].end']);
  });

  it('sin medios es válido (se elimina el contacto)', () => {
    expect(parseOk(schema, {})).toEqual({ channels: [], slots: [] });
  });
});
