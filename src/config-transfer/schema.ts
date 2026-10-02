/**
 * Esquema de la versión 1 del fichero de configuración (008, research R3).
 *
 * Todos los objetos son estrictos: una clave desconocida es un error (FR-010). Las reglas de
 * cada campo son los primitivos del dominio que usa el panel (FR-007); las únicas diferencias
 * son las marcadas ◆ en contracts/config-file-format.md. Las reglas entre elementos (nombres
 * únicos, referencias, repetidos) están en `crossCheckConfig`, que trabaja sobre el fichero tal
 * cual para que salgan a la vez que los errores de los campos.
 */
import type { CountryCode } from 'libphonenumber-js';
import { z } from 'zod';
import { INSTANCE_ID_PATTERN } from '../config/env.js';
import { alertEmailSchema, alertWhatsappSchema } from '../handoff/schemas.js';
import { BUSINESS_NAME_MAX, businessFields } from '../knowledge/schemas/business.js';
import { isoDate, localTime, optionalLocalTime, optionalText, trimmedText } from '../knowledge/schemas/common.js';
import { dateRangeIssues } from '../knowledge/schemas/date-range-block.js';
import { faqFields } from '../knowledge/schemas/faq.js';
import {
  channelKey,
  channelTypeSchema,
  channelValueSchema,
  REPEATED_CHANNEL_MESSAGE,
} from '../knowledge/schemas/handoff.js';
import {
  MIN_ABOVE_MAX_MESSAGE,
  paymentMethodKey,
  policiesFields,
} from '../knowledge/schemas/policies.js';
import { REPEATED_SERVICES_MESSAGE, resourceNameSchema } from '../knowledge/schemas/resource.js';
import { durationMinutesSchema, serviceFields } from '../knowledge/schemas/service.js';
import { toneFields } from '../knowledge/schemas/tone.js';
import {
  refineWeeklySlots,
  sortWeeklySlots,
  WEEKDAY_MESSAGE,
  weekdaySchema,
} from '../knowledge/schemas/weekly-slots.js';
import { chatDesignFileSchema, fileContrastIssues } from '../webchat/design/schemas.js';
import {
  CAP_MESSAGE,
  MAX_ALLOWED_ORIGINS,
  MAX_ORIGINS_MESSAGE,
  MONTHLY_BELOW_DAILY_MESSAGE,
  parseOrigin,
  parsePrivacyUrl,
  REPEATED_ORIGIN_MESSAGE,
} from '../webchat/schemas.js';
import {
  FORMAT_ID,
  normalizeKey,
  type ConfigDocument,
  type ConfigFileEnvelope,
} from './format.js';

export const MISSING_MESSAGE = 'Falta este campo';
export const PRICE_MESSAGE = 'El importe debe ser un número entero de céntimos, 0 o más';
export const ON_REQUEST_PRICE_MESSAGE = 'Con precio «a consultar» el importe debe ser null';
export const REPEATED_SERVICE_NAME = 'Ya existe un servicio con ese nombre';
export const REPEATED_RESOURCE_NAME = 'Ya existe un recurso con ese nombre';
export const REPEATED_PAYMENT_METHOD = 'Forma de pago repetida';
export const HANDOFF_WITHOUT_CHANNELS =
  'Indica al menos un medio de contacto, o deja la sección en null';

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** La clave tiene que estar, con su valor o `null` (un campo que falta no se da por vacío). */
const present = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value, ctx) => {
    if (value === undefined) {
      ctx.addIssue({ code: 'custom', message: MISSING_MESSAGE });
      return z.NEVER;
    }
    return value;
  }, schema);

const slotSchema = z.strictObject({
  // En el fichero el día es un número (el formulario lo manda como texto).
  weekday: z.preprocess((value, ctx) => {
    if (typeof value !== 'number') {
      ctx.addIssue({ code: 'custom', message: WEEKDAY_MESSAGE });
      return z.NEVER;
    }
    return value;
  }, weekdaySchema),
  start: localTime,
  end: localTime,
});

const slotsSchema = z.array(slotSchema).superRefine(refineWeeklySlots).transform(sortWeeklySlots);

const blockShape = {
  startDate: isoDate,
  endDate: isoDate,
  startTime: present(optionalLocalTime),
  endTime: present(optionalLocalTime),
};

function refineBlock(
  v: { startDate: string; endDate: string; startTime: string | null; endTime: string | null },
  ctx: z.RefinementCtx,
): void {
  for (const issue of dateRangeIssues(v)) {
    ctx.addIssue({ code: 'custom', path: [issue.field], message: issue.message });
  }
}

const closureSchema = z
  .strictObject({ ...blockShape, reason: present(optionalText(200)) })
  .superRefine(refineBlock);

const absenceSchema = z.strictObject(blockShape).superRefine(refineBlock);

const businessSchema = (region: CountryCode) => {
  const f = businessFields(region);
  return z.strictObject({
    // ◆ Se admite "" (valor inicial de una instancia recién migrada).
    name: trimmedText(0, BUSINESS_NAME_MAX),
    address: present(f.address),
    directions: present(f.directions),
    mapUrl: present(f.mapUrl),
    phone: present(f.phone),
    email: present(f.email),
    timezone: f.timezone,
    currency: f.currency,
  });
};

const serviceSchema = z.strictObject({
  name: serviceFields.name,
  description: present(serviceFields.description),
  priceType: serviceFields.priceType,
  // ◆ Céntimos enteros, no el decimal del formulario.
  priceCents: present(
    z
      .number({ error: PRICE_MESSAGE })
      .int(PRICE_MESSAGE)
      .min(0, PRICE_MESSAGE)
      .max(2_147_483_647, 'Importe demasiado grande')
      .nullable(),
  ),
  durationMinutes: present(durationMinutesSchema.nullable()),
  bookable: z.boolean(),
  active: z.boolean(),
});

const resourceSchema = z.strictObject({
  name: resourceNameSchema,
  active: z.boolean(),
  services: z.array(z.string({ error: 'Indica el nombre de un servicio' })),
  hours: slotsSchema,
  absences: z.array(absenceSchema),
});

const policiesSchema = z.strictObject({
  cancellationText: present(policiesFields.cancellationText),
  cancellationNoticeMinutes: present(policiesFields.cancellationNoticeMinutes.nullable()),
  minAdvanceMinutes: present(policiesFields.minAdvanceMinutes.nullable()),
  maxAdvanceMinutes: present(policiesFields.maxAdvanceMinutes.nullable()),
  paymentMethods: z.array(policiesFields.paymentMethod.min(1, 'Este campo es obligatorio')),
});

const toneSchema = z.strictObject({
  addressForm: toneFields.addressForm,
  styleDescription: present(toneFields.styleDescription),
});

const channelSchema = (region: CountryCode) =>
  z
    .strictObject({ type: channelTypeSchema, value: z.string({ error: 'Este campo es obligatorio' }) })
    .transform((channel, ctx) => {
      const parsed = channelValueSchema(channel.type, region).safeParse(channel.value);
      if (!parsed.success) {
        ctx.addIssue({
          code: 'custom',
          path: ['value'],
          message: parsed.error.issues[0]?.message ?? 'Valor no válido',
        });
        return z.NEVER;
      }
      return { type: channel.type, value: parsed.data };
    });

const handoffSchema = (region: CountryCode) =>
  z.strictObject({ channels: z.array(channelSchema(region)), hours: slotsSchema });

const originsSchema = z
  .array(z.string({ error: 'Indica la dirección de una web' }))
  .max(MAX_ALLOWED_ORIGINS, MAX_ORIGINS_MESSAGE)
  .transform((values, ctx) => {
    const origins: string[] = [];
    values.forEach((value, i) => {
      const result = parseOrigin(value.trim());
      if ('error' in result) {
        ctx.addIssue({ code: 'custom', path: [i], message: capitalize(result.error) });
      } else if (origins.includes(result.origin)) {
        ctx.addIssue({ code: 'custom', path: [i], message: capitalize(REPEATED_ORIGIN_MESSAGE) });
      } else {
        origins.push(result.origin);
      }
    });
    return origins;
  });

const privacyUrlSchema = z
  .string({ error: 'Indica el enlace completo, empezando por https://' })
  .nullable()
  .transform((value, ctx) => {
    if (value === null || value.trim() === '') return null;
    const result = parsePrivacyUrl(value.trim());
    if ('error' in result) {
      ctx.addIssue({ code: 'custom', message: result.error });
      return z.NEVER;
    }
    return result.url;
  });

const capSchema = z.number({ error: CAP_MESSAGE }).int(CAP_MESSAGE).min(1, CAP_MESSAGE);

const webChatSchema = z.strictObject({
  allowedOrigins: originsSchema,
  privacyUrl: present(privacyUrlSchema),
  dailyCap: capSchema,
  monthlyCap: capSchema,
});

const alertDestinationsSchema = (region: CountryCode) =>
  z.strictObject({
    whatsapp: present(alertWhatsappSchema(region)),
    email: present(alertEmailSchema),
  });

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

const envelopeShape = {
  format: z.literal(FORMAT_ID, { error: 'El fichero no es una exportación de la configuración' }),
  formatVersion: z.number().int(),
  exportedAt: z
    .string()
    .regex(ISO_UTC, 'Fecha de exportación no válida (ISO 8601 en UTC, terminada en Z)')
    .refine((v) => !Number.isNaN(Date.parse(v)), 'Fecha de exportación no válida'),
  source: z.strictObject({
    instanceId: present(
      z.string().regex(INSTANCE_ID_PATTERN, 'Identificador de instancia no válido').nullable(),
    ),
    schema: z.string().trim().min(1, 'Este campo es obligatorio').max(100, 'Máximo 100 caracteres'),
  }),
  includesAlertDestinations: z.boolean(),
  info: z.strictObject({
    businessStatus: z.enum(['draft', 'active'], {
      error: 'Estado del negocio no válido: draft o active',
    }),
    webChatEnabled: z.boolean(),
  }),
};

/** Fichero completo de la versión actual: sobre y secciones. */
export const configFileSchema = (region: CountryCode) =>
  z
    .strictObject({
      ...envelopeShape,
      business: businessSchema(region),
      openingHours: slotsSchema,
      closures: z.array(closureSchema),
      services: z.array(serviceSchema),
      resources: z.array(resourceSchema),
      faqs: z.array(z.strictObject(faqFields)),
      policies: present(policiesSchema.nullable()),
      tone: present(toneSchema.nullable()),
      handoff: present(handoffSchema(region).nullable()),
      webChat: webChatSchema,
      // 011: mismas reglas que el panel; null = sin diseño (aspecto original).
      chatDesign: present(chatDesignFileSchema.nullable()),
      alertDestinations: alertDestinationsSchema(region).optional(),
    })
    .transform(
      (file): { envelope: ConfigFileEnvelope; document: ConfigDocument } => ({
        envelope: {
          format: file.format,
          formatVersion: file.formatVersion,
          exportedAt: file.exportedAt,
          source: file.source,
          includesAlertDestinations: file.includesAlertDestinations,
          info: file.info,
        },
        document: {
          business: file.business,
          openingHours: file.openingHours,
          closures: file.closures,
          services: file.services,
          resources: file.resources,
          faqs: file.faqs,
          policies: file.policies,
          tone: file.tone,
          handoff: file.handoff,
          webChat: file.webChat,
          chatDesign: file.chatDesign,
          ...(file.alertDestinations ? { alertDestinations: file.alertDestinations } : {}),
        },
      }),
    );

/** Error de una regla entre elementos, con la ruta en el fichero. */
export interface RawIssue {
  path: Array<string | number>;
  message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Posiciones de los textos repetidos según `key`, a partir de la segunda aparición. */
function repeated(values: unknown[], key: (text: string) => string): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  values.forEach((value, i) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    const k = key(value);
    if (seen.has(k)) out.push(i);
    else seen.add(k);
  });
  return out;
}

/**
 * Reglas entre elementos y entre campos (research R3), sobre el fichero tal cual: solo miran
 * los valores con el tipo correcto, así que no repiten los errores de los campos.
 */
export function crossCheckConfig(raw: unknown, region: CountryCode): RawIssue[] {
  if (!isRecord(raw)) return [];
  const issues: RawIssue[] = [];

  if (raw.includesAlertDestinations === true && raw.alertDestinations === undefined) {
    issues.push({
      path: ['alertDestinations'],
      message: 'Falta alertDestinations: el fichero dice que incluye los destinos de los avisos',
    });
  }
  if (raw.includesAlertDestinations === false && raw.alertDestinations !== undefined) {
    issues.push({
      path: ['includesAlertDestinations'],
      message: 'El fichero trae alertDestinations, así que includesAlertDestinations debe ser true',
    });
  }

  const services = listOf(raw.services);
  const serviceNames = services.map((s) => (isRecord(s) ? s.name : undefined));
  for (const i of repeated(serviceNames, normalizeKey)) {
    issues.push({ path: ['services', i, 'name'], message: REPEATED_SERVICE_NAME });
  }
  services.forEach((s, i) => {
    if (isRecord(s) && s.priceType === 'on_request' && s.priceCents !== null && s.priceCents !== undefined) {
      issues.push({ path: ['services', i, 'priceCents'], message: ON_REQUEST_PRICE_MESSAGE });
    }
  });

  const known = new Set(
    serviceNames.filter((n): n is string => typeof n === 'string').map(normalizeKey),
  );
  const resources = listOf(raw.resources);
  const resourceNames = resources.map((r) => (isRecord(r) ? r.name : undefined));
  for (const i of repeated(resourceNames, normalizeKey)) {
    issues.push({ path: ['resources', i, 'name'], message: REPEATED_RESOURCE_NAME });
  }
  resources.forEach((r, i) => {
    if (!isRecord(r)) return;
    const refs = listOf(r.services);
    refs.forEach((ref, j) => {
      if (typeof ref === 'string' && !known.has(normalizeKey(ref))) {
        issues.push({
          path: ['resources', i, 'services', j],
          message: `El servicio «${ref.trim()}» no está en el fichero`,
        });
      }
    });
    for (const j of repeated(refs, normalizeKey)) {
      issues.push({ path: ['resources', i, 'services', j], message: REPEATED_SERVICES_MESSAGE });
    }
  });

  if (isRecord(raw.policies)) {
    const p = raw.policies;
    for (const i of repeated(listOf(p.paymentMethods), (m) => paymentMethodKey(m.trim()))) {
      issues.push({ path: ['policies', 'paymentMethods', i], message: REPEATED_PAYMENT_METHOD });
    }
    if (isWhole(p.minAdvanceMinutes) && isWhole(p.maxAdvanceMinutes) && p.maxAdvanceMinutes > 0) {
      if (p.minAdvanceMinutes > p.maxAdvanceMinutes) {
        issues.push({ path: ['policies', 'minAdvanceMinutes'], message: MIN_ABOVE_MAX_MESSAGE });
      }
    }
  }

  if (isRecord(raw.handoff)) {
    const channels = listOf(raw.handoff.channels);
    if (Array.isArray(raw.handoff.channels) && channels.length === 0) {
      issues.push({ path: ['handoff', 'channels'], message: HANDOFF_WITHOUT_CHANNELS });
    }
    const seen = new Set<string>();
    channels.forEach((c, i) => {
      if (!isRecord(c) || typeof c.value !== 'string') return;
      const type = channelTypeSchema.safeParse(c.type);
      if (!type.success) return;
      const value = channelValueSchema(type.data, region).safeParse(c.value);
      if (!value.success) return;
      const key = channelKey(type.data, value.data);
      if (seen.has(key)) {
        issues.push({ path: ['handoff', 'channels', i, 'value'], message: REPEATED_CHANNEL_MESSAGE });
      }
      seen.add(key);
    });
  }

  if (isRecord(raw.webChat)) {
    const { dailyCap, monthlyCap } = raw.webChat;
    if (isWhole(dailyCap) && isWhole(monthlyCap) && dailyCap >= 1 && monthlyCap >= 1) {
      if (monthlyCap < dailyCap) {
        issues.push({ path: ['webChat', 'monthlyCap'], message: MONTHLY_BELOW_DAILY_MESSAGE });
      }
    }
  }

  // Contraste del diseño del chat (011): sobre el fichero tal cual, a la vez que los campos.
  for (const issue of fileContrastIssues(raw.chatDesign)) {
    issues.push({ path: ['chatDesign', ...issue.path], message: issue.message });
  }

  return issues;
}
