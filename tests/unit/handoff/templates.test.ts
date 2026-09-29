/** Respuestas de la derivación al cliente (005, contracts/handoff-flow.md § Respuestas). */
import { describe, expect, it } from 'vitest';
import { contactBlock } from '../../../src/conversation/templates.js';
import {
  askContactReply,
  confirmedReply,
  lateReply,
  lateReplyWithContact,
  offerQuestion,
  phoneRetryReply,
} from '../../../src/handoff/templates.js';
import { activeSnapshot } from '../../helpers/snapshot.js';

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

describe('R-HANDOFF-OK con el negocio cerrado (US5, FR-010)', () => {
  it('con la próxima franja, en tú y usted', () => {
    const closed = { open: false, from: 'el lunes 5 de octubre a las 9:00' } as const;
    expect(confirmedReply(BUSINESS, '+34611222333', 'tu', closed)).toBe(
      'He avisado a Peluquería Tijeras. Ahora mismo no están atendiendo; te contactarán en el ' +
        '+34 611 22 23 33 a partir del lunes 5 de octubre a las 9:00.',
    );
    expect(confirmedReply(BUSINESS, '+34611222333', 'usted', closed)).toBe(
      'He avisado a Peluquería Tijeras. Ahora mismo no están atendiendo; le contactarán en el ' +
        '+34 611 22 23 33 a partir del lunes 5 de octubre a las 9:00.',
    );
  });

  it('sin franja en 60 días: "en cuanto puedan"', () => {
    const closed = { open: false, from: null } as const;
    expect(confirmedReply(BUSINESS, '+34611222333', 'tu', closed)).toBe(
      'He avisado a Peluquería Tijeras. Ahora mismo no están atendiendo; te contactarán en el ' +
        '+34 611 22 23 33 en cuanto puedan.',
    );
    expect(confirmedReply(BUSINESS, '+34611222333', 'usted', closed)).toContain(
      'le contactarán en el +34 611 22 23 33 en cuanto puedan.',
    );
  });

  it('"hoy" y "mañana" sin contracción', () => {
    expect(
      confirmedReply(BUSINESS, '+34611222333', 'tu', { open: false, from: 'mañana a las 9:00' }),
    ).toContain('a partir de mañana a las 9:00.');
  });

  it('abierto: igual que sin indicar el horario', () => {
    expect(confirmedReply(BUSINESS, '+34611222333', 'tu', { open: true })).toBe(
      confirmedReply(BUSINESS, '+34611222333', 'tu'),
    );
  });
});

describe('R-HANDOFF-LATE (US5, FR-019)', () => {
  it('tú y usted, sin datos del negocio salvo el nombre (el CONTACTO se añade aparte)', () => {
    expect(lateReply(BUSINESS, 'tu')).toBe(
      'Peluquería Tijeras todavía no ha podido responderte. Si lo prefieres, puedes contactar directamente:',
    );
    expect(lateReply(BUSINESS, 'usted')).toBe(
      'Peluquería Tijeras todavía no ha podido responderle. Si lo prefiere, puede contactar directamente:',
    );
  });

  it('con el bloque CONTACTO del snapshot', () => {
    const snapshot = activeSnapshot();
    expect(lateReplyWithContact(snapshot)).toBe(
      `${lateReply('Negocio Demo', 'tu')}

${contactBlock(snapshot)}`,
    );
  });
});

describe('OFERTA (US2, FR-002)', () => {
  it('tú y usted, sin datos del negocio salvo el nombre', () => {
    expect(offerQuestion(BUSINESS, 'tu')).toBe(
      '¿Quieres que le pase tu consulta a Peluquería Tijeras para que te contacte?',
    );
    expect(offerQuestion(BUSINESS, 'usted')).toBe(
      '¿Quiere que le pase su consulta a Peluquería Tijeras para que le contacte?',
    );
  });
});
