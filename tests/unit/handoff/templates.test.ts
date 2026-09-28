/** Respuestas de la derivación al cliente (005, contracts/handoff-flow.md § Respuestas). */
import { describe, expect, it } from 'vitest';
import {
  askContactReply,
  confirmedReply,
  phoneRetryReply,
} from '../../../src/handoff/templates.js';

const BUSINESS = 'Peluquería Tijeras';

describe('R-HANDOFF-ASK', () => {
  it.each([
    [
      ['name', 'phone'] as const,
      'tu',
      'Para que Peluquería Tijeras pueda contactarte, ¿me dices tu nombre y un teléfono?',
    ],
    [
      ['name', 'phone'] as const,
      'usted',
      'Para que Peluquería Tijeras pueda contactarle, ¿me dice su nombre y un teléfono?',
    ],
    [
      ['name'] as const,
      'tu',
      'Para pasarle tu consulta a Peluquería Tijeras, ¿me dices tu nombre?',
    ],
    [
      ['name'] as const,
      'usted',
      'Para pasarle su consulta a Peluquería Tijeras, ¿me dice su nombre?',
    ],
    [
      ['phone'] as const,
      'tu',
      '¿Me dices un teléfono en el que Peluquería Tijeras pueda contactarte?',
    ],
    [
      ['phone'] as const,
      'usted',
      '¿Me dice un teléfono en el que Peluquería Tijeras pueda contactarle?',
    ],
  ])('pide %j en forma %s', (missing, form, text) => {
    expect(askContactReply([...missing], BUSINESS, form as 'tu' | 'usted')).toBe(text);
  });
});

describe('R-HANDOFF-PHONE', () => {
  it('tú y usted', () => {
    expect(phoneRetryReply('tu')).toBe(
      'Ese teléfono no parece válido. ¿Me lo escribes de nuevo, con el prefijo internacional si no es un número nacional?',
    );
    expect(phoneRetryReply('usted')).toBe(
      'Ese teléfono no parece válido. ¿Me lo escribe de nuevo, con el prefijo internacional si no es un número nacional?',
    );
  });
});

describe('R-HANDOFF-OK con el negocio abierto', () => {
  it('tú y usted, con el teléfono legible', () => {
    expect(confirmedReply(BUSINESS, '+34611222333', 'tu')).toBe(
      'He avisado a Peluquería Tijeras. Te contactarán en el +34 611 22 23 33 lo antes posible.',
    );
    expect(confirmedReply(BUSINESS, '+34611222333', 'usted')).toBe(
      'He avisado a Peluquería Tijeras. Le contactarán en el +34 611 22 23 33 lo antes posible.',
    );
  });

  it('no lleva datos del negocio salvo el nombre', () => {
    const text = confirmedReply(BUSINESS, '+34611222333', 'tu');
    expect(text.replace(BUSINESS, '').replace('+34 611 22 23 33', '')).not.toMatch(/\d|@|http/);
  });
});
