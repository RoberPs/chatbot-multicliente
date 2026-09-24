import { z } from 'zod';
import { optionalText } from './common.js';

/** Tono del bot (FR-017). */
export const toneSchema = z
  .object({
    address_form: z.enum(['informal', 'formal'], { error: 'Elige tratar de tú o de usted' }),
    style_description: optionalText(2000),
  })
  .transform((v) => ({ addressForm: v.address_form, styleDescription: v.style_description }));

export type ToneInput = z.infer<typeof toneSchema>;
