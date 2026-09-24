import { z } from 'zod';
import { trimmedText } from './common.js';

/** Pregunta frecuente (FR-014). */
export const faqSchema = z.object({
  question: trimmedText(1, 500),
  answer: trimmedText(1, 4000),
});

export type FaqInput = z.infer<typeof faqSchema>;
