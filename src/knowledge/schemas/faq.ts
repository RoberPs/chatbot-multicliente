import { z } from 'zod';
import { trimmedText } from './common.js';

/** Reglas de cada campo de una pregunta frecuente (formulario y fichero, 008). */
export const faqFields = {
  question: trimmedText(1, 500),
  answer: trimmedText(1, 4000),
};

/** Pregunta frecuente (FR-014). */
export const faqSchema = z.object(faqFields);

export type FaqInput = z.infer<typeof faqSchema>;
