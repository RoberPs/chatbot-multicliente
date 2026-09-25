import { describe, expect, it } from 'vitest';
import {
  contactBlock,
  emergencyContact,
  errorReply,
  formatWeeklyHours,
  greeting,
  joinParts,
  safeReply,
} from '../../../src/conversation/templates.js';
import { activeSnapshot } from '../../helpers/snapshot.js';
import { slot, typicalWeek } from '../../helpers/state.js';

const T = '2026-09-24T10:00:00.000000Z';

describe('plantillas: CONTACTO', () => {
  it('un canal y sin horario', () => {
    expect(contactBlock(activeSnapshot())).toBe(
      'Para hablar con una persona de Negocio Demo: WhatsApp +34 611 22 23 33.',
    );
  });

  it('varios canales con etiquetas genéricas y horario agrupado', () => {
    const snapshot = activeSnapshot({
      handoff: {
        channels: [
          { id: 'a', type: 'phone', value: '+34911223344', sortOrder: 0 },
          { id: 'b', type: 'whatsapp', value: '+34611222333', sortOrder: 1 },
          { id: 'c', type: 'email', value: 'hola@example.com', sortOrder: 2 },
        ],
        hours: [
          ...([1, 2, 3, 4, 5] as const).map((d) => slot(d, '09:00', '14:00')),
          slot(6, '10:00', '13:00'),
        ],
        updatedAt: T,
      },
    });
    expect(contactBlock(snapshot)).toBe(
      'Para hablar con una persona de Negocio Demo: teléfono +34 911 22 33 44, ' +
        'WhatsApp +34 611 22 23 33 y correo hola@example.com. ' +
        'Horario de atención: lunes a viernes de 9:00 a 14:00; sábado de 10:00 a 13:00.',
    );
  });

  it('con el teléfono del negocio como contacto efectivo', () => {
    const snapshot = activeSnapshot({ handoff: null });
    expect(contactBlock(snapshot)).toBe(
      'Para hablar con una persona de Negocio Demo: teléfono +34 910 00 00 00.',
    );
  });
});

describe('plantillas: horario semanal', () => {
  it('agrupa días con las mismas franjas', () => {
    expect(formatWeeklyHours(typicalWeek())).toBe(
      'lunes a viernes de 9:00 a 14:00 y de 16:00 a 20:00; sábado de 10:00 a 14:00',
    );
  });

  it('días no consecutivos y pares de días', () => {
    expect(
      formatWeeklyHours([
        slot(1, '09:00', '13:00'),
        slot(3, '09:00', '13:00'),
        slot(6, '09:00', '13:00'),
        slot(7, '09:00', '13:00'),
      ]),
    ).toBe('lunes, miércoles, sábado y domingo de 9:00 a 13:00');
  });

  it('sin franjas → null', () => {
    expect(formatWeeklyHours([])).toBeNull();
  });
});

describe('plantillas fijas', () => {
  it('variante usted', () => {
    expect(errorReply('tu')).toContain('vuelve a escribirme');
    expect(errorReply('usted')).toContain('vuelva a escribirme');
  });

  it('contacto de emergencia en formato legible', () => {
    expect(emergencyContact('+34600111222')).toBe(
      'Si necesitas hablar con una persona: teléfono +34 600 11 12 22.',
    );
  });

  it('ninguna plantilla contiene cifras propias', () => {
    for (const text of [
      safeReply('tu'),
      safeReply('usted'),
      errorReply('tu'),
      errorReply('usted'),
    ]) {
      expect(text).not.toMatch(/\d/);
    }
    expect(emergencyContact('+34600111222').replace(/\+34 600 11 12 22/, '')).not.toMatch(/\d/);
  });
});

describe('joinParts', () => {
  it('separa las partes con una línea en blanco en el orden del contrato', () => {
    expect(
      joinParts({ greeting: 'Hola.', body: 'Cuerpo.', fileNotice: 'Aviso.', contact: 'Contacto.' }),
    ).toEqual({ text: 'Hola.\n\nCuerpo.\n\nAviso.\n\nContacto.', truncated: false });
    expect(joinParts({ body: 'Solo cuerpo.' }).text).toBe('Solo cuerpo.');
  });

  it('recorta el cuerpo a 4096 conservando saludo y contacto', () => {
    const contact = contactBlock(activeSnapshot());
    const result = joinParts({ greeting: 'Hola.', body: 'x'.repeat(5000), contact });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(4096);
    expect(result.text.startsWith('Hola.\n\n')).toBe(true);
    expect(result.text.endsWith(contact)).toBe(true);
  });
});

describe('plantillas: SALUDO (US4, FR-020)', () => {
  it('en tú, con el nombre del negocio y lo que atiende', () => {
    expect(greeting('Negocio Demo', 'tu')).toBe(
      '¡Hola! Soy el asistente automático de Negocio Demo. Puedo informarte sobre horario, ' +
        'ubicación, servicios, precios y dudas frecuentes.',
    );
  });

  it('en usted', () => {
    expect(greeting('Negocio Demo', 'usted')).toBe(
      '¡Hola! Soy el asistente automático de Negocio Demo. Puedo informarle sobre horario, ' +
        'ubicación, servicios, precios y dudas frecuentes.',
    );
  });

  it('sin cifras propias', () => {
    expect(greeting('Negocio', 'tu')).not.toMatch(/\d/);
  });
});
