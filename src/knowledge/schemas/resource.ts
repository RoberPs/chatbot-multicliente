import { z } from 'zod';
import { checkbox, formList, trimmedText } from './common.js';
import { dateRangeBlockSchema } from './date-range-block.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nombre de un recurso (formulario y fichero, 008). */
export const resourceNameSchema = trimmedText(1, 200);

export const REPEATED_SERVICES_MESSAGE = 'Hay servicios repetidos';

/** Recurso (FR-010, FR-011, FR-011b). */
export const resourceSchema = z
  .object({
    name: resourceNameSchema,
    service_ids: formList(z.string().trim()),
    active: checkbox,
  })
  .superRefine((v, ctx) => {
    if (v.service_ids.some((id) => !UUID_RE.test(id))) {
      ctx.addIssue({
        code: 'custom',
        path: ['service_ids'],
        message: 'Algún servicio no es válido',
      });
    } else if (new Set(v.service_ids.map((id) => id.toLowerCase())).size !== v.service_ids.length) {
      ctx.addIssue({ code: 'custom', path: ['service_ids'], message: REPEATED_SERVICES_MESSAGE });
    }
  })
  .transform((v) => ({
    name: v.name,
    serviceIds: v.service_ids.map((id) => id.toLowerCase()),
    active: v.active,
  }));

export type ResourceInput = z.infer<typeof resourceSchema>;

/** Ausencia de un recurso: un bloque de fechas sin motivo (FR-012). */
export const absenceSchema = dateRangeBlockSchema;
