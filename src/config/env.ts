import { isAbsolute } from 'node:path';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';
import { isValidTimezone } from '../knowledge/schemas/common.js';
import {
  ineligibleMessage,
  keyVariableOf,
  LLM_PROVIDERS,
  providerDescriptor,
  type LlmProvider,
} from '../llm/provider.js';
import type { ProtectionConfig } from '../usage/protection.js';
import { checkSecrets, secretFindingText } from './secret-rules.js';

// Reutilizado por las herramientas de aprovisionamiento (007) con las mismas reglas del arranque.
export { isValidTimezone };

/** Texto opcional: vacío o solo espacios cuenta como ausente (líneas `VAR=` de `.env`). */
const optionalText = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** Identificador de instancia (006): el mismo patrón que el nombre de las copias. */
export const INSTANCE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const HEX_KEY = /^[0-9a-f]{64}$/i;
const RETENTION_MESSAGE = 'BACKUP_RETENTION_DAYS debe estar entre 1 y 30 días (máximo 30)';

/**
 * Origen de una URL pública (`https://host[:puerto]`), o `null` si tiene ruta, consulta,
 * credenciales o es `http` fuera de localhost.
 */
export function publicOrigin(value: string): string | null {
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
          params: { rule: 'trust_proxy_all' },
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
  /**
   * Proveedor del modelo de la instancia (017, FR-001). Ausente equivale a `anthropic`, que es lo
   * que hace que los entornos ya desplegados sigan funcionando sin tocarlos (FR-003).
   */
  LLM_PROVIDER: optionalText.pipe(
    z.enum(LLM_PROVIDERS as unknown as [LlmProvider, ...LlmProvider[]], {
      error: (issue) => ineligibleMessage(issue.input),
    }).default('anthropic'),
  ),
  /**
   * Las tres variables de credencial (017). **Única excepción a la regla C1** de que solo
   * `src/llm/` nombra una variable de credencial, y es deliberada: este módulo es la frontera cuyo
   * trabajo es declarar variables de entorno, y un esquema construido a partir de la tabla
   * metería una firma de índice en el tipo `Env`, debilitando el tipado de **todas** las demás.
   *
   * Lo que importa es que nadie **decide** aquí: el proveedor declarado dice cuál de las tres se
   * usa, y el resto del programa lee `llmApiKey` y `llmKeyVariable` sin saber de quién son.
   */
  ANTHROPIC_API_KEY: optionalText,
  GEMINI_API_KEY: optionalText,
  OPENAI_API_KEY: optionalText,
  /** Obligatoria salvo con `anthropic`, que conserva su valor por defecto (R2); ver `botSchema`. */
  LLM_MODEL: optionalText,
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
            params: { rule: 'public_url_invalid' },
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

  // --- Copias de seguridad (feature 006) ---
  /** Identificador de la instancia: va dentro de cada copia y en su nombre. */
  INSTANCE_ID: optionalText.pipe(
    z
      .string()
      .regex(
        INSTANCE_ID_PATTERN,
        'INSTANCE_ID debe tener de 1 a 40 caracteres: minúsculas, cifras y guiones (sin guion al principio ni al final)',
      )
      .optional(),
  ),
  /** Directorio de las copias: ruta absoluta de un volumen persistente. */
  BACKUP_DIR: optionalText.pipe(
    z.string().refine(isAbsolute, 'BACKUP_DIR debe ser una ruta absoluta').optional(),
  ),
  /** Clave de las copias: 32 bytes aleatorios en hexadecimal, distinta de SESSION_SECRET. */
  BACKUP_KEY: optionalText.pipe(
    z
      .string()
      .regex(
        HEX_KEY,
        'BACKUP_KEY debe ser 32 bytes aleatorios en hexadecimal (openssl rand -hex 32)',
      )
      .refine(looksRandom, 'BACKUP_KEY no parece aleatoria')
      .transform((v) => v.toLowerCase())
      .optional(),
  ),
  /** Claves anteriores, solo para leer copias antiguas (research R4). */
  BACKUP_KEYS_PREVIOUS: optionalText.pipe(
    z
      .string()
      .optional()
      .transform((v, ctx) => {
        if (v === undefined) return [];
        const keys = v
          .split(',')
          .map((k) => k.trim().toLowerCase())
          .filter(Boolean);
        if (keys.some((k) => !HEX_KEY.test(k))) {
          ctx.addIssue({
            code: 'custom',
            message:
              'BACKUP_KEYS_PREVIOUS debe ser una lista de claves de 64 hex separadas por comas',
          });
          return z.NEVER;
        }
        return keys;
      }),
  ),
  BACKUP_RETENTION_DAYS: optionalText.pipe(
    z.coerce
      .number<string | undefined>({ error: RETENTION_MESSAGE })
      .int(RETENTION_MESSAGE)
      .min(1, RETENTION_MESSAGE)
      .max(30, RETENTION_MESSAGE)
      .default(7),
  ),
  /** Hora local del negocio de la copia diaria (`HH:MM`, 24 h). */
  BACKUP_DAILY_TIME: optionalText.pipe(
    z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'BACKUP_DAILY_TIME debe ser una hora HH:MM de 24 h')
      .default('03:00'),
  ),
  /** Servidor donde `db:verify` crea la BD temporal; por defecto, el de DATABASE_URL. */
  BACKUP_VERIFY_URL: optionalText,

  // --- Salud y versión (feature 009) ---
  /**
   * Secreto de salud propio de la instancia: 32 bytes aleatorios en hexadecimal. Da acceso al
   * informe completo de `GET /health`; sin él, solo se responde el estado (research R2).
   */
  HEALTH_SECRET: optionalText.pipe(
    z
      .string()
      .regex(
        HEX_KEY,
        'HEALTH_SECRET debe ser 32 bytes aleatorios en hexadecimal (openssl rand -hex 32)',
      )
      .refine(looksRandom, 'HEALTH_SECRET no parece aleatoria')
      .transform((v) => v.toLowerCase())
      .optional(),
  ),
});

function looksRandom(hex: string): boolean {
  return new Set(hex.toLowerCase()).size > 8;
}

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

export const BACKUP_VARS = ['INSTANCE_ID', 'BACKUP_DIR', 'BACKUP_KEY'] as const;

/** Configuración de copias de la instancia (006); la clave, en hex minúsculas. */
export interface BackupEnv {
  instanceId: string;
  dir: string;
  key: string;
  previousKeys: string[];
}

/** Normaliza un teléfono a E.164 o devuelve `null` si no es válido. */
export function toE164(value: string): string | null {
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
      params: { rule: 'whatsapp_incomplete', variables: missing },
    });
  }

  // El proveedor declarado decide **qué** variable lleva la credencial del modelo (017, FR-005).
  // Las de los otros proveedores, si estuvieran presentes, no se usan nunca como respaldo
  // (FR-004): la comprobación previa las avisa, y aquí ni se miran.
  const llmProvider = raw.LLM_PROVIDER;
  const llmKeyVariable = keyVariableOf(llmProvider);
  const llmApiKey = (raw as unknown as Record<string, string | undefined>)[llmKeyVariable];

  // `LLM_MODEL` es obligatoria salvo con el proveedor que conserva su valor por defecto (R2).
  const descriptor = providerDescriptor(llmProvider);
  let llmModel = raw.LLM_MODEL;
  if (llmModel === undefined) {
    if (descriptor.modelRequired) {
      ctx.addIssue({
        code: 'custom',
        message: `LLM_MODEL es obligatoria con LLM_PROVIDER=${llmProvider}`,
        params: { rule: 'llm_model_required', variables: ['LLM_MODEL'] },
      });
    }
    llmModel = descriptor.defaultModel;
  }

  let emergencyContactPhone: string | null = null;
  if (raw.EMERGENCY_CONTACT_PHONE !== undefined) {
    emergencyContactPhone = toE164(raw.EMERGENCY_CONTACT_PHONE);
    if (emergencyContactPhone === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'EMERGENCY_CONTACT_PHONE debe ser un teléfono en formato E.164 (+34...)',
        params: { rule: 'emergency_phone_invalid', variables: ['EMERGENCY_CONTACT_PHONE'] },
      });
    }
  } else if (llmApiKey !== undefined || whatsapp) {
    // Con bot, todos los canales necesitan una salida a una persona (research R11).
    ctx.addIssue({
      code: 'custom',
      message: `EMERGENCY_CONTACT_PHONE es obligatoria con ${llmKeyVariable}`,
      params: { rule: 'emergency_phone_required', variables: ['EMERGENCY_CONTACT_PHONE'] },
    });
  }

  if (whatsapp && llmApiKey === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `${llmKeyVariable} es obligatoria con el canal de WhatsApp`,
      params: { rule: 'llm_key_required', variables: [llmKeyVariable] },
    });
  }

  const audioTranscription = raw.AUDIO_TRANSCRIPTION === 'on';
  if (audioTranscription && raw.STT_API_KEY === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'STT_API_KEY es obligatoria con AUDIO_TRANSCRIPTION=on',
      params: { rule: 'stt_key_required', variables: ['STT_API_KEY'] },
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
      params: {
        rule: 'smtp_incomplete',
        variables: [raw.SMTP_URL === undefined ? 'SMTP_URL' : 'SMTP_FROM'],
      },
    });
  }

  // Copias de seguridad (006, R13): las tres juntas o ninguna; en production, obligatorias.
  let backup: BackupEnv | null = null;
  const backupPresent = BACKUP_VARS.filter((k) => raw[k] !== undefined);
  const backupMissing = BACKUP_VARS.filter((k) => raw[k] === undefined);
  if (backupMissing.length === 0) {
    backup = {
      instanceId: raw.INSTANCE_ID ?? '',
      dir: raw.BACKUP_DIR ?? '',
      key: raw.BACKUP_KEY ?? '',
      previousKeys: raw.BACKUP_KEYS_PREVIOUS,
    };
  } else if (raw.NODE_ENV === 'production') {
    ctx.addIssue({
      code: 'custom',
      message: `En production las copias son obligatorias; faltan: ${backupMissing.join(', ')}`,
      params: { rule: 'backup_required', variables: backupMissing },
    });
  } else if (backupPresent.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `INSTANCE_ID, BACKUP_DIR y BACKUP_KEY van juntas; faltan: ${backupMissing.join(', ')}`,
      params: { rule: 'backup_incomplete', variables: backupMissing },
    });
  }

  // Los secretos repetidos (BACKUP_KEY, HEALTH_SECRET…) los detecta la regla `reused` de
  // `secret-rules.ts` en producción (012).
  return {
    ...raw,
    BACKUP_VERIFY_URL: raw.BACKUP_VERIFY_URL ?? raw.DATABASE_URL,
    // Resuelto: el resto del programa lee el modelo y la credencial sin saber de quién son.
    LLM_MODEL: llmModel ?? '',
    llmKeyVariable,
    llmApiKey,
    whatsapp,
    emergencyContactPhone,
    audioTranscription,
    smtp,
    backup,
  };
});

export type Env = z.infer<typeof botSchema>;

/**
 * Lo que decide la protección frente a abuso (012, R1): producción por `NODE_ENV` y los modelos
 * configurados (el de transcripción, solo con los audios activados). El dominio lo recibe ya
 * calculado y nunca lee `process.env`.
 */
export function protectionConfigFromEnv(
  env: Pick<Env, 'NODE_ENV' | 'LLM_MODEL' | 'STT_MODEL' | 'audioTranscription'>,
): ProtectionConfig {
  return {
    production: env.NODE_ENV === 'production',
    llmModel: env.LLM_MODEL,
    sttModel: env.audioTranscription ? env.STT_MODEL : null,
  };
}

/**
 * Calidad de los secretos (012, R14): solo en producción, con las reglas de `secret-rules.ts`
 * que usa también `instance:check`. Fuera de producción el arranque solo lo registra.
 */
function secretIssues(source: NodeJS.ProcessEnv): EnvIssue[] {
  if (source.NODE_ENV?.trim() !== 'production') return [];
  return checkSecrets(source).map((finding) => ({
    variable: finding.variable,
    rule: finding.rule,
    message: `${finding.variable}: ${secretFindingText(finding)}`,
    ...(finding.otherVariable ? { otherVariable: finding.otherVariable } : {}),
  }));
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = botSchema.safeParse(source);
  const messages = [
    ...(result.success ? [] : result.error.issues.map((i) => i.message)),
    ...secretIssues(source).map((i) => i.message),
  ];
  if (!result.success || messages.length > 0) {
    const detail = messages.map((m) => `- ${m}`).join('\n');
    throw new Error(`Configuración de la instancia no válida:\n${detail}`);
  }
  return result.data;
}

/**
 * Incidencia de la validación del entorno (007, research R2): la variable afectada, la regla
 * (`missing`, `core_rule` o la de una regla propia del núcleo) y el mensaje del arranque.
 */
export interface EnvIssue {
  variable: string | null;
  rule: string;
  message: string;
  /** En la regla `reused` de los secretos (012): la otra variable con el mismo valor. */
  otherVariable?: string;
}

/**
 * Las mismas reglas que `loadEnv`, una entrada por variable afectada. No lanza ni cambia el
 * arranque: lo usan las herramientas de aprovisionamiento para validar un entorno leído.
 */
export function checkEnv(source: NodeJS.ProcessEnv): EnvIssue[] {
  const result = botSchema.safeParse(source);
  if (result.success) return secretIssues(source);
  const schemaIssues = result.error.issues.flatMap((issue): EnvIssue[] => {
    const params = (issue as { params?: { rule?: unknown; variables?: unknown } }).params;
    const field = typeof issue.path[0] === 'string' ? issue.path[0] : null;
    if (typeof params?.rule === 'string') {
      const variables = Array.isArray(params.variables)
        ? params.variables.filter((v): v is string => typeof v === 'string')
        : [field];
      return variables.map((variable) => ({
        variable,
        rule: String(params.rule),
        message: issue.message,
      }));
    }
    const value = field === null ? undefined : source[field];
    const rule = value === undefined || value.trim() === '' ? 'missing' : 'core_rule';
    return [{ variable: field, rule, message: issue.message }];
  });
  return [...schemaIssues, ...secretIssues(source)];
}

/** Carga `.env` si existe (desarrollo local). En producción las variables llegan del entorno. */
export function loadDotEnvIfPresent(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Sin fichero .env: se usan las variables del entorno.
  }
}
