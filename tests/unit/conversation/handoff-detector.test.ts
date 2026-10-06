/** Detector determinista de petición de persona (contracts/bot-replies.md, SC-008). */
import { describe, expect, it } from 'vitest';
import { detectsHandoffRequest } from '../../../src/conversation/handoff-detector.js';

describe('detectsHandoffRequest', () => {
  it.each([
    'Quiero hablar con una persona',
    'quiero hablar con alguien',
    'Pásame con el encargado',
    'pasame con la encargada, por favor',
    'Póngame con el responsable',
    'ponme con alguien de la tienda',
    '¿Puedo hablar con un humano?',
    'Que me llamen, por favor',
    'que me llame alguien',
    '¿Me podéis llamar?',
    'Necesito atención al cliente',
    'ATENCIÓN PERSONAL',
    'No quiero hablar con un bot',
    'no quiero hablar con una maquina',
    'Quiero una persona real',
    'hablar con un ser humano',
  ])('detecta "%s"', (text) => {
    expect(detectsHandoffRequest(text)).toBe(true);
  });

  it.each([
    '¿Cuánto cuesta?',
    'Una persona me dijo que abríais el domingo',
    '¿Cuántas personas caben?',
    'Gracias',
    'Vale, muchas gracias 👍',
    'Hola, buenos días',
    '¿Llamáis vosotros para confirmar la cita?',
    '',
  ])('no detecta "%s"', (text) => {
    expect(detectsHandoffRequest(text)).toBe(false);
  });
});
