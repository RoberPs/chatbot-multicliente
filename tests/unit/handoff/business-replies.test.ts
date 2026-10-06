/** Acuses y ayuda al negocio (005, contracts/business-alerts.md). */
import { describe, expect, it } from 'vitest';
import {
  BUSINESS_HELP,
  businessReply,
  INVALID_BUTTON,
} from '../../../src/handoff/business-replies.js';

const LUCIA = { name: 'Lucía', phone: '+34611222333' };

describe('acuses de los botones', () => {
  it('«Le atiendo» y «Terminado» hechos', () => {
    expect(businessReply('attend', 'done', LUCIA)).toBe(
      'Anotado: atiendes a Lucía. Pulsa «Terminado» cuando acabes.',
    );
    expect(businessReply('end', 'done', LUCIA)).toBe(
      'Anotado: derivación de Lucía terminada. El asistente vuelve a atenderle.',
    );
  });

  it('ya confirmada, ya terminada (con el teléfono) y botón no válido', () => {
    expect(businessReply('attend', 'already_confirmed', LUCIA)).toBe(
      'Ya estaba anotado que atiendes a Lucía.',
    );
    for (const action of ['attend', 'end'] as const) {
      expect(businessReply(action, 'already_ended', LUCIA)).toBe(
        'Esa derivación ya había terminado y la conversación ha vuelto al asistente; no se ha ' +
          'cambiado nada. Si aún no has contactado con Lucía, su teléfono es +34 611 22 23 33.',
      );
    }
    expect(businessReply('end', 'invalid', null)).toBe(INVALID_BUTTON);
    expect(INVALID_BUTTON).toBe('No reconozco ese botón; no se ha cambiado nada.');
  });

  it('ayuda al número de avisos', () => {
    expect(BUSINESS_HELP).toBe(
      'Este número es el del asistente automático y no reenvía lo que escribes al cliente. ' +
        'Contesta al cliente desde tu teléfono y usa los botones «Le atiendo» y «Terminado» de ' +
        'cada aviso.',
    );
  });
});
