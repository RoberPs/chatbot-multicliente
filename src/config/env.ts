import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';
import { isValidTimezone } from '../knowledge/schemas/common.js';

/** Texto opcional: vacío o solo espacios cuenta como ausente (líneas `VAR=` de `.env`). */
const optionalText = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Origen de una URL pública (`https://host[:puerto]`), o `null` si tiene ruta, consulta,
 * credenciales o es `http` fuera de localhost.
 */
function publicOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:';
  const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (!secure && !local) return null;
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
  return url.origin;
}

/** Variables de la instancia. Cada cliente tiene su propio despliegue con sus valores. */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria'),
  OPERATOR_USER: z.string().trim().min(1, 'OPERATOR_USER es obligatorio'),
  OPERATOR_PASSWORD_HASH: z
    .string()
    .startsWith(
      '$argon2id$',
      'OPERATOR_PASSWORD_HASH debe ser un hash Argon2id (pnpm operator:hash-password)',
    ),
  // Clave aleatoria de 32 bytes en hexadecimal (openssl rand -hex 32). Se usa directamente
  // como clave de cifrado de la cookie; un texto elegido a mano no se acepta.
  SESSION_SECRET: z
    .string()
    .trim()
    .regex(
      /^[0-9a-f]{64}$/i,
      'SESSION_SECRET debe ser 32 bytes aleatorios en hexadecimal (openssl rand -hex 32)',
    )
    .refine((s) => new Set(s.toLowerCase()).size > 8, 'SESSION_SECRET no parece aleatoria'),
  DEFAULT_PHONE_REGION: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'DEFAULT_PHONE_REGION debe ser un código de país de 2 letras')
    .default('ES'),
  DEFAULT_TIMEZONE: z
    .string()
    .refine(isValidTimezone, 'DEFAULT_TIMEZONE no es una zona horaria IANA válida')
    .default('Europe/Madrid'),
  DEFAULT_CURRENCY: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'DEFAULT_CURRENCY debe ser un código ISO 4217')
    .default('EUR'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test'], {
    error: 'NODE_ENV es obligatoria: development, production o test',
  }),
  /**
   * Proxies de confianza para obtener la IP del cliente: número de saltos (p. ej. 1) o
   * IP/CIDR separadas por comas. Vacío = ninguno. Nunca `true`: permitiría falsear la IP.
   */
  TRUST_PROXY: z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '' || v === 'false') return false;
      if (/^\d+$/.test(v)) return Number(v);
      if (v === 'true') {
        ctx.addIssue({
          code: 'custom',
          message: 'TRUST_PROXY no admite true: indica saltos o IP/CIDR',
        });
        return z.NEVER;
      }
      return v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    }),

  // --- Atención por WhatsApp (feature 002) ---
  WHATSAPP_PHONE_NUMBER_ID: optionalText,
  WHATSAPP_ACCESS_TOKEN: optionalText,
  WHATSAPP_APP_SECRET: optionalText,
  WHATSAPP_VERIFY_TOKEN: optionalText,
  WHATSAPP_GRAPH_VERSION: optionalText,
  EMERGENCY_CONTACT_PHONE: optionalText,
  ANTHROPIC_API_KEY: optionalText,
  LLM_MODEL: optionalText.transform((v) => v ?? 'claude-sonnet-5'),
  LLM_EFFORT: optionalText.pipe(
    z
      .enum(['low', 'medium', 'high'], { error: 'LLM_EFFORT debe ser low, medium o high' })
      .default('medium'),
  ),
  AUDIO_TRANSCRIPTION: optionalText.pipe(
    z.enum(['on', 'off'], { error: 'AUDIO_TRANSCRIPTION debe ser on u off' }).default('off'),
  ),
  STT_API_KEY: optionalText,
  STT_MODEL: optionalText.transform((v) => v ?? 'whisper-1'),

  // --- Canal web (feature 004) ---
  /** URL pública de la instancia para escribir el fragmento del chat web; sin barra final. */
  PUBLIC_BASE_URL: optionalText.pipe(
    z
      .string()
      .optional()
      .transform((v, ctx) => {
        if (v === undefined) return undefined;
        const origin = publicOrigin(v);
        if (origin === null) {
          ctx.addIssue({
            code: 'custom',
            message:
              'PUBLIC_BASE_URL debe ser una URL https sin ruta (http solo con localhost o 127.0.0.1)',
          });
          return z.NEVER;
        }
        return origin;
      }),
  ),

  // --- Avisos de derivación al negocio (feature 005) ---
  /** Servidor SMTP de los avisos por email: `smtp://` (STARTTLS) o `smtps://`. */
  SMTP_URL: optionalText.pipe(
    z
      .string()
      .optional()
      .refine(
        (v) => v === undefined || isSmtpUrl(v),
        'SMTP_URL debe ser una URL smtp:// o smtps:// con servidor (smtps://usuario:clave@host:465)',
      ),
  ),
  /** Remitente de los avisos por email. */
  SMTP_FROM: optionalText.pipe(
    z
      .email({ error: 'SMTP_FROM debe ser un email válido' })
      .transform((v) => v.toLowerCase())
      .optional(),
  ),
  /** Idioma de las plantillas de WhatsApp de los avisos (`xx` o `xx_XX`). */
  WHATSAPP_TEMPLATE_LANG: optionalText.pipe(
    z
      .string()
      .regex(/^[a-z]{2}(_[A-Z]{2})?$/, 'WHATSAPP_TEMPLATE_LANG debe tener el formato xx o xx_XX')
      .default('es'),
  ),
});

function isSmtpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'smtp:' || url.protocol === 'smtps:') && url.hostname !== '';
  } catch {
    return false;
  }
}

export interface SmtpEnv {
  url: string;
  from: string;
}

const WHATSAPP_VARS = [
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'WHATSAPP_GRAPH_VERSION',
] as const;

export interface WhatsAppEnv {
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  graphVersion: string;
}

/** Normaliza un teléfono a E.164 o devuelve `null` si no es válido. */
function toE164(value: string): string | null {
  const phone = parsePhoneNumberFromString(value);
  return phone?.isValid() ? phone.number : null;
}

/**
 * Agrupa las variables del bot: con la clave del modelo hay bot y es obligatorio el contacto de
 * emergencia (004, R11); WhatsApp es opcional, va entero o no va y exige la clave del modelo.
 */
const botSchema = envSchema.transform((raw, ctx) => {
  const present = WHATSAPP_VARS.filter((k) => raw[k] !== undefined);
  let whatsapp: WhatsAppEnv | null = null;
  if (present.length === WHATSAPP_VARS.length) {
    whatsapp = {
      phoneNumberId: raw.WHATSAPP_PHONE_NUMBER_ID ?? '',
      accessToken: raw.WHATSAPP_ACCESS_TOKEN ?? '',
      appSecret: raw.WHATSAPP_APP_SECRET ?? '',
      verifyToken: raw.WHATSAPP_VERIFY_TOKEN ?? '',
      graphVersion: raw.WHATSAPP_GRAPH_VERSION ?? '',
    };
  } else if (present.length > 0) {
    const missing = WHATSAPP_VARS.filter((k) => raw[k] === undefined);
    ctx.addIssue({
      code: 'custom',
      message: `Las variables WHATSAPP_* van juntas; faltan: ${missing.join(', ')}`,
    });
  }

  let emergencyContactPhone: string | null = null;
  if (raw.EMERGENCY_CONTACT_PHONE !== undefined) {
    emergencyContactPhone = toE164(raw.EMERGENCY_CONTACT_PHONE);
    if (emergencyContactPhone === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'EMERGENCY_CONTACT_PHONE debe ser un teléfono en formato E.164 (+34...)',
      });
    }
  } else if (raw.ANTHROPIC_API_KEY !== undefined || whatsapp) {
    // Con bot, todos los canales necesitan una salida a una persona (research R11).
    ctx.addIssue({
      code: 'custom',
      message: 'EMERGENCY_CONTACT_PHONE es obligatoria con ANTHROPIC_API_KEY',
    });
  }

  if (whatsapp && raw.ANTHROPIC_API_KEY === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'ANTHROPIC_API_KEY es obligatoria con el canal de WhatsApp',
    });
  }

  const audioTranscription = raw.AUDIO_TRANSCRIPTION === 'on';
  if (audioTranscription && raw.STT_API_KEY === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'STT_API_KEY es obligatoria con AUDIO_TRANSCRIPTION=on',
    });
  }

  // SMTP de los avisos de derivación (005, R7): las dos variables juntas o ninguna.
  let smtp: SmtpEnv | null = null;
  if (raw.SMTP_URL !== undefined && raw.SMTP_FROM !== undefined) {
    smtp = { url: raw.SMTP_URL, from: raw.SMTP_FROM };
  } else if (raw.SMTP_URL !== undefined || raw.SMTP_FROM !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'SMTP_URL y SMTP_FROM van juntas: indica las dos o ninguna',
    });
  }

  return { ...raw, whatsapp, emergencyContactPhone, audioTranscription, smtp };
});

export type Env = z.infer<typeof botSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = botSchema.safeParse(source);
  if (!result.success) {
    const detail = result.error.issues.map((i) => `- ${i.message}`).join('\n');
    throw new Error(`Configuración de la instancia no válida:\n${detail}`);
  }
  return result.data;
}

/** Carga `.env` si existe (desarrollo local). En producción las variables llegan del entorno. */
export function loadDotEnvIfPresent(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Sin fichero .env: se usan las variables del entorno.
  }
}
