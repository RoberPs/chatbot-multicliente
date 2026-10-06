import { z } from 'zod';
import { optionalText } from './common.js';

/** Reglas de cada campo del tono (formulario y fichero, 008). */
export const toneFields = {
  addressForm: z.enum(['informal', 'formal'], { error: 'Elige tratar de tú o de usted' }),
  styleDescription: optionalText(2000),
};

/** Tono del bot (FR-017). */
export const toneSchema = z
  .object({
    address_form: toneFields.addressForm,
    style_description: toneFields.styleDescription,
  })
  .transform((v) => ({ addressForm: v.address_form, styleDescription: v.style_description }));

export type ToneInput = z.infer<typeof toneSchema>;
