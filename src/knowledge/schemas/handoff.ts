import type { CountryCode } from 'libphonenumber-js';
import { z } from 'zod';
import type { HandoffChannelType } from '../types.js';
import { email, phone } from './common.js';
import { weeklySlotsSchema } from './weekly-slots.js';

const channelType = z.enum(['phone', 'whatsapp', 'email'], { error: 'Elige el tipo de medio' });

/** Contacto de derivación (FR-018): medios con su valor normalizado y horario opcional. */
export const handoffSchema = (region: CountryCode) =>
  z
    .object({
      channels: z.preprocess(
        (v) => (v === undefined || v === null || v === '' ? [] : v),
        z.array(z.object({ type: channelType, value: z.string({ error: 'Obligatorio' }) })),
      ),
      slots: weeklySlotsSchema,
    })
    .transform((v, ctx) => {
      const channels: Array<{ type: HandoffChannelType; value: string }> = [];
      const seen = new Set<string>();
      v.channels.forEach((channel, i) => {
        const valueSchema = channel.type === 'email' ? email : phone(region);
        const parsed = valueSchema.safeParse(channel.value);
        if (!parsed.success) {
          ctx.addIssue({
            code: 'custom',
            path: ['channels', i, 'value'],
            message: parsed.error.issues[0]?.message ?? 'Valor no válido',
          });
          return;
        }
        const key = `${channel.type}:${parsed.data}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['channels', i, 'value'],
            message: 'Este medio está repetido',
          });
          return;
        }
        seen.add(key);
        channels.push({ type: channel.type, value: parsed.data });
      });
      return { channels, slots: v.slots };
    });

export type HandoffInput = z.infer<ReturnType<typeof handoffSchema>>;
