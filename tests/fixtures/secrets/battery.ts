/**
 * Batería de secretos de la 012 (SC-010; contracts/logging-and-startup.md).
 *
 * Un entorno de producción válido, con los secretos generados por las mismas funciones que
 * `pnpm instance:new` (con una fuente aleatoria de semilla fija, para que los casos salgan siempre
 * iguales), y, por cada variable secreta, variantes demasiado cortas, de ejemplo, triviales y
 * repetidas, además de la ausencia de `BACKUP_KEY` y de `HEALTH_SECRET`. Cada caso lleva las
 * incidencias que debe dar `checkSecrets`.
 */
import type { SecretFinding } from '../../../src/config/secret-rules.js';
import {
  generateHexSecret,
  generateVerifyToken,
  type RandomSource,
} from '../../../src/provisioning/secrets.js';

/** Fuente aleatoria de semilla fija (mulberry32). */
export function seededRandom(seed: number): RandomSource {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    bytes: (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(next() * 256))),
    int: (max) => Math.floor(next() * max),
  };
}

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWYZabcdefghijkmnpqrsuvwyz23456789';

/** Texto aleatorio de `length` caracteres alfanuméricos (sin las letras de las palabras de relleno). */
function alnum(random: RandomSource, length: number): string {
  return Array.from({ length }, () => ALNUM[random.int(ALNUM.length)]).join('');
}

/** Hash Argon2id con los parámetros mínimos de OWASP (formato; no hace falta que verifique). */
export const FIXTURE_OPERATOR_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsLWRlLXBydWViYS0xMjM$aGFzaC1kZS1wcnVlYmEtcGFyYS1sYS1iYXRlcmlhLTAxMg';

/** Entorno de producción válido (todas las variables secretas con valor). */
export function validProductionEnv(seed = 12): Record<string, string> {
  const random = seededRandom(seed);
  const dbPassword = alnum(random, 24);
  const smtpPassword = alnum(random, 24);
  return {
    NODE_ENV: 'production',
    INSTANCE_ID: 'demo-012',
    PUBLIC_BASE_URL: 'https://chat.demo-012.test',
    TRUST_PROXY: '1',
    DATABASE_URL: `postgres://demo_012:${dbPassword}@db.demo-012.test:5432/demo_012?sslmode=verify-full`,
    OPERATOR_USER: 'operador',
    OPERATOR_PASSWORD_HASH: FIXTURE_OPERATOR_HASH,
    SESSION_SECRET: generateHexSecret('SESSION_SECRET', random),
    BACKUP_DIR: '/var/lib/chatbot/backups',
    BACKUP_KEY: generateHexSecret('BACKUP_KEY', random),
    BACKUP_KEYS_PREVIOUS: generateHexSecret('BACKUP_KEY', random),
    HEALTH_SECRET: generateHexSecret('HEALTH_SECRET', random),
    EMERGENCY_CONTACT_PHONE: '+34910000000',
    ANTHROPIC_API_KEY: `sk-ant-api03-${alnum(random, 48)}`,
    WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
    WHATSAPP_ACCESS_TOKEN: `EAAG${alnum(random, 120)}`,
    WHATSAPP_APP_SECRET: random.bytes(16).toString('hex'),
    WHATSAPP_VERIFY_TOKEN: generateVerifyToken(random),
    WHATSAPP_GRAPH_VERSION: 'v23.0',
    AUDIO_TRANSCRIPTION: 'on',
    STT_API_KEY: `sk-proj-${alnum(random, 40)}`,
    SMTP_URL: `smtps://avisos:${smtpPassword}@smtp.demo-012.test:465`,
    SMTP_FROM: 'avisos@demo-012.test',
  };
}

export interface SecretCase {
  name: string;
  env: Record<string, string>;
  expected: SecretFinding[];
}

/** Variables secretas con valor propio (las de `DATABASE_URL` y `SMTP_URL`, su contraseña). */
export const SECRET_VARIABLES = [
  'SESSION_SECRET',
  'BACKUP_KEY',
  'BACKUP_KEYS_PREVIOUS',
  'HEALTH_SECRET',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
  'ANTHROPIC_API_KEY',
  'STT_API_KEY',
  'DATABASE_URL',
  'SMTP_URL',
] as const;
type SecretVariable = (typeof SECRET_VARIABLES)[number];

const HEX = new Set<SecretVariable>([
  'SESSION_SECRET',
  'BACKUP_KEY',
  'BACKUP_KEYS_PREVIOUS',
  'HEALTH_SECRET',
]);

/** Pone `secret` como valor de la variable (en las URL, como contraseña). */
function withSecret(
  env: Record<string, string>,
  variable: SecretVariable,
  secret: string,
): Record<string, string> {
  const next = { ...env };
  if (variable === 'DATABASE_URL' || variable === 'SMTP_URL') {
    const url = new URL(env[variable] ?? '');
    url.password = encodeURIComponent(secret);
    next[variable] = url.toString();
  } else {
    next[variable] = secret;
  }
  return next;
}

/** Valor demasiado corto (o poco variado) para cada variable, sin ser de relleno. */
function tooShort(variable: SecretVariable, random: RandomSource): string {
  if (HEX.has(variable)) return random.bytes(16).toString('hex'); // 32 hex en lugar de 64
  const minimum: Record<string, number> = {
    WHATSAPP_ACCESS_TOKEN: 40,
    WHATSAPP_APP_SECRET: 32,
    WHATSAPP_VERIFY_TOKEN: 32,
    ANTHROPIC_API_KEY: 40,
    STT_API_KEY: 20,
    DATABASE_URL: 16,
    SMTP_URL: 16,
  };
  return alnum(random, (minimum[variable] ?? 16) - 1);
}

/** Valor trivial de la longitud adecuada: un carácter repetido. */
function trivial(variable: SecretVariable): string {
  return HEX.has(variable) ? 'a'.repeat(64) : 'z'.repeat(64);
}

export function secretCases(): SecretCase[] {
  const base = validProductionEnv();
  const random = seededRandom(99);
  const cases: SecretCase[] = [{ name: 'entorno válido', env: base, expected: [] }];

  for (const variable of SECRET_VARIABLES) {
    cases.push({
      name: `${variable}: demasiado corto`,
      env: withSecret(base, variable, tooShort(variable, random)),
      expected: [{ variable, rule: 'too_short' }],
    });
    cases.push({
      name: `${variable}: contraseña de ejemplo «chatbot»`,
      env: withSecret(base, variable, 'chatbot'),
      expected: [{ variable, rule: 'example_value' }],
    });
    cases.push({
      name: `${variable}: un carácter repetido`,
      env: withSecret(base, variable, trivial(variable)),
      expected: [{ variable, rule: 'trivial' }],
    });
  }

  // Valores de ejemplo de .env.example y de la documentación.
  cases.push({
    name: 'DATABASE_URL de .env.example',
    env: { ...base, DATABASE_URL: 'postgres://chatbot:chatbot@localhost:5432/chatbot' },
    expected: [{ variable: 'DATABASE_URL', rule: 'example_value' }],
  });
  cases.push({
    name: 'SMTP_URL del ejemplo de la documentación',
    env: { ...base, SMTP_URL: 'smtps://usuario:clave@host:465' },
    expected: [{ variable: 'SMTP_URL', rule: 'example_value' }],
  });

  // Otros valores triviales: relleno y secuencia.
  cases.push({
    name: 'WHATSAPP_ACCESS_TOKEN de relleno',
    env: { ...base, WHATSAPP_ACCESS_TOKEN: 'changeme_changeme_changeme_changeme_changeme_42' },
    expected: [{ variable: 'WHATSAPP_ACCESS_TOKEN', rule: 'trivial' }],
  });
  cases.push({
    name: 'ANTHROPIC_API_KEY en secuencia',
    env: { ...base, ANTHROPIC_API_KEY: '0123456789'.repeat(5) },
    expected: [{ variable: 'ANTHROPIC_API_KEY', rule: 'trivial' }],
  });
  cases.push({
    name: 'SESSION_SECRET en secuencia hexadecimal',
    env: { ...base, SESSION_SECRET: '0123456789'.repeat(7).slice(0, 64) },
    expected: [{ variable: 'SESSION_SECRET', rule: 'trivial' }],
  });

  // Repetidos (sin distinguir mayúsculas): la incidencia es de la segunda variable.
  const session = base.SESSION_SECRET ?? '';
  cases.push({
    name: 'HEALTH_SECRET igual a SESSION_SECRET en mayúsculas',
    env: { ...base, HEALTH_SECRET: session.toUpperCase() },
    expected: [{ variable: 'HEALTH_SECRET', rule: 'reused', otherVariable: 'SESSION_SECRET' }],
  });
  cases.push({
    name: 'BACKUP_KEY igual a SESSION_SECRET',
    env: { ...base, BACKUP_KEY: session },
    expected: [{ variable: 'BACKUP_KEY', rule: 'reused', otherVariable: 'SESSION_SECRET' }],
  });
  cases.push({
    name: 'HEALTH_SECRET igual a BACKUP_KEY',
    env: { ...base, HEALTH_SECRET: base.BACKUP_KEY ?? '' },
    expected: [{ variable: 'HEALTH_SECRET', rule: 'reused', otherVariable: 'BACKUP_KEY' }],
  });
  cases.push({
    name: 'BACKUP_KEYS_PREVIOUS igual a BACKUP_KEY',
    env: { ...base, BACKUP_KEYS_PREVIOUS: base.BACKUP_KEY ?? '' },
    expected: [{ variable: 'BACKUP_KEYS_PREVIOUS', rule: 'reused', otherVariable: 'BACKUP_KEY' }],
  });
  cases.push({
    name: 'STT_API_KEY igual a ANTHROPIC_API_KEY',
    env: { ...base, STT_API_KEY: base.ANTHROPIC_API_KEY ?? '' },
    expected: [{ variable: 'STT_API_KEY', rule: 'reused', otherVariable: 'ANTHROPIC_API_KEY' }],
  });
  const dbPassword = new URL(base.DATABASE_URL ?? '').password;
  cases.push({
    name: 'contraseña de SMTP_URL igual a la de DATABASE_URL',
    env: withSecret(base, 'SMTP_URL', dbPassword),
    expected: [{ variable: 'SMTP_URL', rule: 'reused', otherVariable: 'DATABASE_URL' }],
  });

  // Ausentes
  const { HEALTH_SECRET: _health, ...withoutHealth } = base;
  cases.push({
    name: 'sin HEALTH_SECRET',
    env: withoutHealth,
    expected: [{ variable: 'HEALTH_SECRET', rule: 'health_secret_required' }],
  });
  cases.push({
    name: 'HEALTH_SECRET vacía',
    env: { ...base, HEALTH_SECRET: '   ' },
    expected: [{ variable: 'HEALTH_SECRET', rule: 'health_secret_required' }],
  });
  // Sin BACKUP_KEY no hay incidencia de secretos: la regla de copias del arranque la nombra.
  const { BACKUP_KEY: _backup, ...withoutBackup } = base;
  cases.push({ name: 'sin BACKUP_KEY', env: withoutBackup, expected: [] });

  return cases;
}
