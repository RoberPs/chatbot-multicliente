import { z } from 'zod';
import { isValidTimezone } from '../knowledge/schemas/common.js';

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
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
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
