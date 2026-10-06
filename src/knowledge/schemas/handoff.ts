import type { CountryCode } from 'libphonenumber-js';
import { z } from 'zod';
import type { HandoffChannelType } from '../types.js';
import { checkbox, email, phone } from './common.js';
import { weeklySlotsSchema } from './weekly-slots.js';

/** Tipo de medio de contacto de derivación. */
export const channelTypeSchema = z.enum(['phone', 'whatsapp', 'email'], {
  error: 'Elige el tipo de medio',
});

/** Valor de un medio: email o teléfono (E.164) según su tipo (formulario y fichero, 008). */
export const channelValueSchema = (type: HandoffChannelType, region: CountryCode) =>
  type === 'email' ? email : phone(region);

export const REPEATED_CHANNEL_MESSAGE = 'Este medio está repetido';

/** Clave para detectar medios repetidos: tipo y valor normalizado. */
export const channelKey = (type: HandoffChannelType, value: string): string => `${type}:${value}`;

/**
 * Contacto de derivación (FR-018): medios con su valor normalizado y horario opcional.
 * Las filas marcadas con "Quitar" (003, FR-001) se descartan sin validar su valor; los errores
 * del resto conservan el índice del formulario.
 */
export const handoffSchema = (region: CountryCode) =>
  z
    .object({
      channels: z.preprocess(
        (v) => (v === undefined || v === null || v === '' ? [] : v),
        z.array(
          z.object({
            type: channelTypeSchema,
            value: z.string({ error: 'Obligatorio' }),
            remove: checkbox,
          }),
        ),
      ),
      slots: weeklySlotsSchema,
    })
    .transform((v, ctx) => {
      const channels: Array<{ type: HandoffChannelType; value: string }> = [];
      const seen = new Set<string>();
      v.channels.forEach((channel, i) => {
        if (channel.remove) return;
        const parsed = channelValueSchema(channel.type, region).safeParse(channel.value);
        if (!parsed.success) {
          ctx.addIssue({
            code: 'custom',
            path: ['channels', i, 'value'],
            message: parsed.error.issues[0]?.message ?? 'Valor no válido',
          });
          return;
        }
        const key = channelKey(channel.type, parsed.data);
        if (seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['channels', i, 'value'],
            message: REPEATED_CHANNEL_MESSAGE,
          });
          return;
        }
        seen.add(key);
        channels.push({ type: channel.type, value: parsed.data });
      });
      return { channels, slots: v.slots };
    });

export type HandoffInput = z.infer<ReturnType<typeof handoffSchema>>;
