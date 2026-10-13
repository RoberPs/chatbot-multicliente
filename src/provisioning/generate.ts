/**
 * Alta de una instancia nueva (007, US2, research R7): valida los datos mínimos con las mismas
 * reglas que el arranque, genera los secretos, comprueba que ninguno coincide con el inventario y
 * produce los valores del entorno, los pendientes de terceros y la instancia "en alta".
 */
import { dirname, join, posix, resolve } from 'node:path';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { INSTANCE_ID_PATTERN, isValidTimezone } from '../config/env.js';
import { isLlmProvider, keyVariableOf, type LlmProvider } from '../llm/provider.js';
import type { EnvMap } from './env-file.js';
import { envFingerprints, fingerprint, normalize, type Fingerprint } from './fingerprint.js';
import type { Instance, Inventory } from './inventory.js';
import { ProvisioningError } from './messages.js';
import { isGitIgnored, isInsideCoreRepo } from './repo-paths.js';
import {
  cryptoRandom,
  generateHexSecret,
  generateOperatorPassword,
  generateVerifyToken,
  hashOperatorPassword,
  type PasswordHasher,
  type RandomSource,
} from './secrets.js';

export const DEFAULT_BACKUP_DIR = '/var/lib/chatbot/backups';

/** Datos que da el operador (FR-010). */
export interface MinimalInput {
  id: string;
  client: string;
  url: string;
  timezone: string;
  region: string;
  currency: string;
  emergencyPhone: string;
  whatsapp: boolean;
  backupDir?: string | undefined;
  /** 017: proveedor del modelo. Ausente equivale a `anthropic` (FR-003, FR-010). */
  provider?: string | undefined;
}

/** Datos validados y normalizados. */
export interface MinimalData {
  id: string;
  client: string;
  /** Origen `https://host[:puerto]`. */
  url: string;
  timezone: string;
  region: string;
  currency: string;
  /** Teléfono en E.164. */
  emergencyPhone: string;
  whatsapp: boolean;
  backupDir: string;
  /** 017: proveedor del modelo de la instancia (FR-010). */
  provider: LlmProvider;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function httpsOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || LOCAL_HOSTS.has(url.hostname)) return null;
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
  return url.origin;
}

/** Valida los datos mínimos sin escribir nada (FR-014). */
export function validateMinimalData(input: MinimalInput): MinimalData {
  const id = input.id.trim();
  if (!INSTANCE_ID_PATTERN.test(id)) throw new ProvisioningError('invalid_id');
  const client = input.client.trim();
  if (client.length < 1 || client.length > 120) throw new ProvisioningError('invalid_client');
  const url = httpsOrigin(input.url);
  if (url === null) throw new ProvisioningError('invalid_url');
  const timezone = input.timezone.trim();
  if (!isValidTimezone(timezone)) throw new ProvisioningError('invalid_timezone');
  const region = input.region.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(region)) throw new ProvisioningError('invalid_region');
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new ProvisioningError('invalid_currency');
  let phone;
  try {
    phone = parsePhoneNumberFromString(input.emergencyPhone, region as CountryCode);
  } catch {
    phone = undefined;
  }
  if (!phone?.isValid()) throw new ProvisioningError('invalid_phone');
  const backupDir = (input.backupDir ?? DEFAULT_BACKUP_DIR).trim();
  if (!posix.isAbsolute(backupDir) || backupDir.includes('\\')) {
    throw new ProvisioningError('invalid_backup_dir');
  }
  // 017 (FR-010): ausente equivale a `anthropic`, igual que en el entorno de una instancia ya
  // desplegada; un valor no elegible se rechaza nombrando los tres (FR-002).
  const rawProvider = input.provider?.trim() ?? '';
  if (rawProvider !== '' && !isLlmProvider(rawProvider)) {
    throw new ProvisioningError('invalid_provider');
  }
  const provider: LlmProvider = rawProvider === '' ? 'anthropic' : rawProvider;
  return {
    id,
    client,
    url,
    timezone,
    region,
    currency,
    emergencyPhone: phone.number,
    whatsapp: input.whatsapp,
    backupDir,
    provider,
  };
}

/** Rechaza un `id` o una URL ya usados, también por instancias dadas de baja (FR-029). */
export function checkNotUsed(data: MinimalData, inventory: Inventory | null, key: Buffer): void {
  if (!inventory) return;
  const same = inventory.instances.find((i) => i.id === data.id);
  if (same)
    throw new ProvisioningError('duplicate_instance_id', { id: data.id, status: same.status });
  const url = fingerprint(key, 'public_url', normalize('PUBLIC_BASE_URL', data.url));
  const other = inventory.instances.find((i) =>
    i.fingerprints.some((f) => f.class === 'public_url' && f.value === url),
  );
  if (other) throw new ProvisioningError('duplicate_public_url', { other: other.id });
}

export interface GeneratedInstance {
  /** Variables con valor (secretos incluidos). */
  values: EnvMap;
  /** Variables pendientes de un tercero → quién las aporta. */
  pending: Record<string, string>;
  instance: Instance;
  /** Contraseña del operador: se muestra una vez y no se guarda en ningún sitio (FR-012). */
  password: string;
}

export interface GenerateDeps {
  random?: RandomSource;
  hasher: PasswordHasher;
  today: string;
  /** Valores por defecto de la plantilla (para las huellas de lo que no se genera). */
  templateDefaults?: EnvMap;
}

const MAX_ATTEMPTS = 3;

function collides(fps: Fingerprint[], inventory: Inventory | null): boolean {
  if (!inventory) return false;
  const used = new Set(
    inventory.instances.flatMap((i) =>
      i.fingerprints.filter((f) => f.class === 'secret').map((f) => f.value),
    ),
  );
  return fps.some((f) => f.class === 'secret' && used.has(f.value));
}

/** Pendientes de terceros (FR-013). */
function pendingFor(data: MinimalData): Record<string, string> {
  const pending: Record<string, string> = {
    DATABASE_URL: `se escribe con pnpm instance:db ${data.id}`,
    // 017 (FR-010): la variable que se emite es la **del proveedor elegido**, no siempre la de
    // Anthropic. Emitir la equivocada era pedirle al operador que pegara la clave en el sitio que
    // la comprobación previa rechaza.
    [keyVariableOf(data.provider)]:
      'clave del modelo de lenguaje de esta instancia (consola del proveedor)',
    SMTP_URL: 'servidor de correo de los avisos (opcional; va con SMTP_FROM)',
    SMTP_FROM: 'remitente de los avisos por email (opcional; va con SMTP_URL)',
  };
  if (data.whatsapp) {
    pending.WHATSAPP_PHONE_NUMBER_ID = 'identificador del número en la app de Meta';
    pending.WHATSAPP_ACCESS_TOKEN = 'token de usuario de sistema de la app de Meta';
    pending.WHATSAPP_APP_SECRET = 'secreto de la app de Meta';
    pending.WHATSAPP_GRAPH_VERSION = 'versión de la Graph API (p. ej. v23.0)';
  }
  return pending;
}

/**
 * Genera los secretos y los valores del entorno. Si alguna huella nueva coincide con el
 * inventario, vuelve a generar (máximo 3 intentos; después `duplicate_value`).
 */
export async function buildInstanceEnv(
  data: MinimalData,
  inventory: Inventory | null,
  key: Buffer,
  deps: GenerateDeps,
): Promise<GeneratedInstance> {
  const random = deps.random ?? cryptoRandom;
  const pending = pendingFor(data);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const password = generateOperatorPassword(random);
    const values: EnvMap = {
      NODE_ENV: 'production',
      INSTANCE_ID: data.id,
      PUBLIC_BASE_URL: data.url,
      // 013: con `https` hay un proxy delante; la receta de despliegue (§2.5) pone uno solo y
      // comprueba la dirección que ve la instancia. Sin él, `instance:check` no da APTO.
      TRUST_PROXY: '1',
      DEFAULT_TIMEZONE: data.timezone,
      DEFAULT_PHONE_REGION: data.region,
      DEFAULT_CURRENCY: data.currency,
      EMERGENCY_CONTACT_PHONE: data.emergencyPhone,
      BACKUP_DIR: data.backupDir,
      SESSION_SECRET: generateHexSecret('SESSION_SECRET', random),
      BACKUP_KEY: generateHexSecret('BACKUP_KEY', random),
      // 009: secreto de salud propio; se escribe en el entorno y nunca se imprime.
      HEALTH_SECRET: generateHexSecret('HEALTH_SECRET', random),
      OPERATOR_PASSWORD_HASH: await hashOperatorPassword(password, deps.hasher),
    };
    if (data.whatsapp) values.WHATSAPP_VERIFY_TOKEN = generateVerifyToken(random);
    if (values.BACKUP_KEY === values.SESSION_SECRET) continue;
    if (
      values.HEALTH_SECRET === values.SESSION_SECRET ||
      values.HEALTH_SECRET === values.BACKUP_KEY
    ) {
      continue;
    }

    const env: EnvMap = { ...deps.templateDefaults, ...values };
    for (const variable of Object.keys(pending)) env[variable] = '';
    const fingerprints = envFingerprints(env, key, deps.today);
    if (collides(fingerprints, inventory)) continue;

    const instance: Instance = {
      id: data.id,
      client: data.client,
      status: 'provisioning',
      publicUrl: data.url,
      imageVersion: null,
      llmWorkspace: null,
      backupKeyLocation: null,
      backupDir: data.backupDir,
      database: null,
      dates: { provisioned: deps.today, retired: null, dataDeleted: null },
      lastVerification: null,
      lastSuccessfulVerificationAt: null,
      fingerprints,
    };
    return { values, pending, instance, password };
  }
  throw new ProvisioningError('duplicate_value');
}

/** Cabecera del entorno generado (sin secretos). */
export function envHeader(id: string, today: string): string[] {
  return [
    `Entorno de la instancia ${id}, generado el ${today} con pnpm instance:new.`,
    'Contiene secretos: guárdalo en el gestor de secretos y no lo subas a ningún repositorio.',
  ];
}

/**
 * Ruta de salida: `--out` o `<dir. inventario>/envs/<id>.env`. Dentro del repositorio del núcleo
 * solo si `git` la excluye del control de versiones (FR-015).
 */
export function resolveOutputPath(
  out: string | undefined,
  inventoryPath: string,
  id: string,
  options: { root?: string; gitEnv?: NodeJS.ProcessEnv } = {},
): string {
  const path = resolve(out ?? join(dirname(inventoryPath), 'envs', `${id}.env`));
  if (
    isInsideCoreRepo(path, options.root) &&
    !isGitIgnored(path, { root: options.root, env: options.gitEnv })
  ) {
    throw new ProvisioningError('output_in_repo', { path });
  }
  return path;
}
