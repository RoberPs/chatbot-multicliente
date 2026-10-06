/**
 * Utilidades de las pruebas de aprovisionamiento (007): directorio temporal con inventario y
 * `envs/`, clave de test, E/S capturada, hasher rápido, entornos válidos de producción con
 * secretos aleatorios, inventarios de ejemplo y la lista de secretos de un entorno para las
 * búsquedas de privacidad (SC-005).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstanceDeps, InstanceIO } from '../../src/cli/instance.js';
import type { EnvMap } from '../../src/provisioning/env-file.js';
import { databasePassword, envFingerprints } from '../../src/provisioning/fingerprint.js';
import { templatePath } from '../../src/provisioning/repo-paths.js';
import {
  createInventory,
  serializeInventory,
  writeInventory,
  type Instance,
  type Inventory,
  type InstanceStatus,
} from '../../src/provisioning/inventory.js';

/** Clave fija del inventario de pruebas (64 hex). */
export const TEST_INVENTORY_KEY_HEX =
  '4f1c9a7e2b5d8036a1e3c5f7092b4d6e8a0c2e4f6183a5c7e9b1d3f5a7c9e0b1';
export const TEST_INVENTORY_KEY = Buffer.from(TEST_INVENTORY_KEY_HEX, 'hex');
export const OTHER_INVENTORY_KEY_HEX =
  '0a2c4e6f8193b5d7f9a1c3e5072b4d6f8e0a2c4e6f8193b5d1b3d5f7092a4c6e';
export const TODAY = '2026-09-30';

// ---------------------------------------------------------------------------
// Directorio temporal
// ---------------------------------------------------------------------------

export interface Workspace {
  dir: string;
  inventoryPath: string;
  envsDir: string;
  /** Escribe un entorno en `envs/<nombre>` y devuelve su ruta. */
  writeEnv(name: string, env: EnvMap): Promise<string>;
  writeInventory(inventory: Inventory): Promise<void>;
  readInventory(): Promise<Inventory>;
  inventoryText(): Promise<string>;
  /** Contenido de todos los ficheros del directorio salvo los de `envs/`. */
  otherFilesText(): Promise<string>;
  remove(): Promise<void>;
}

export async function workspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), 'inventario-'));
  const inventoryPath = join(dir, 'inventory.json');
  const envsDir = join(dir, 'envs');
  await mkdir(envsDir, { recursive: true });
  return {
    dir,
    inventoryPath,
    envsDir,
    async writeEnv(name, env) {
      const path = join(envsDir, name);
      await writeFile(path, envText(env), { mode: 0o600 });
      return path;
    },
    writeInventory: (inventory) => writeFile(inventoryPath, serializeInventory(inventory)),
    readInventory: async () => JSON.parse(await readFile(inventoryPath, 'utf8')) as Inventory,
    inventoryText: () => readFile(inventoryPath, 'utf8'),
    async otherFilesText() {
      const names = await readdir(dir);
      const texts: string[] = [];
      for (const name of names) {
        const path = join(dir, name);
        if ((await stat(path)).isFile()) texts.push(await readFile(path, 'utf8'));
      }
      return texts.join('\n');
    },
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}

/** `KEY=valor` por línea (comillas si hace falta). */
export function envText(env: EnvMap): string {
  return `${Object.entries(env)
    .map(([k, v]) => (/[\s#"']/.test(v) ? `${k}="${v}"` : `${k}=${v}`))
    .join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// E/S y dependencias
// ---------------------------------------------------------------------------

interface CapturedLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  text(): string;
}

function captureLogger(): CapturedLogger {
  const lines: string[] = [];
  const make = (obj: object, msg?: string): void => {
    lines.push(`${JSON.stringify(obj)} ${msg ?? ''}`);
  };
  return { debug: make, info: make, warn: make, error: make, text: () => lines.join('\n') };
}

export interface TestInstanceIO extends InstanceIO {
  logger: CapturedLogger;
  stdout: string[];
  stderr: string[];
  questions: string[];
  all(): string;
}

export function instanceIO(
  env: NodeJS.ProcessEnv,
  options: { tty?: boolean; answers?: string[]; hidden?: string[]; stdin?: string } = {},
): TestInstanceIO {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const questions: string[] = [];
  const answers = [...(options.answers ?? [])];
  const hidden = [...(options.hidden ?? [])];
  const logger = captureLogger();
  const tty = options.tty ?? false;
  return {
    env,
    interactive: tty,
    stdoutIsTTY: tty,
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    ask: (question) => {
      questions.push(question);
      return Promise.resolve(answers.shift() ?? '');
    },
    askHidden: (question) => {
      questions.push(question);
      return Promise.resolve(hidden.shift() ?? '');
    },
    readStdin: () => Promise.resolve(options.stdin ?? ''),
    logger,
    stdout,
    stderr,
    questions,
    all: () => [...stdout, ...stderr, logger.text()].join('\n'),
  };
}

/** Hasher Argon2id falso y rápido: mismo formato que el real, valor distinto por contraseña. */
export const fastHasher = (password: string): Promise<string> =>
  Promise.resolve(
    `$argon2id$v=19$m=65536,t=3,p=4$${randomBytes(16).toString('base64').replace(/=+$/, '')}$${Buffer.from(
      password,
    )
      .toString('base64')
      .replace(/=+$/, '')}`,
  );

export function testDeps(overrides: Partial<InstanceDeps> = {}): InstanceDeps {
  return {
    now: () => new Date('2026-09-30T10:00:00'),
    lock: { waitMs: 300, retryMs: 20 },
    hasher: fastHasher,
    templatePath: templatePath(),
    writeInventory,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Entornos e inventarios
// ---------------------------------------------------------------------------

const hex = (bytes = 32) => randomBytes(bytes).toString('hex');
const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
const b64 = (bytes: number) => randomBytes(bytes).toString('base64').replace(/=+$/, '');

/** Hash Argon2id con el formato real (base64 sin relleno) y los parámetros dados. */
export function argonHash(m = 65536, t = 3): string {
  return `$argon2id$v=19$m=${String(m)},t=${String(t)},p=4$${b64(16)}$${b64(32)}`;
}

/** Entorno válido de producción, con secretos aleatorios y sin ningún valor de relleno. */
export function productionEnv(id: string, overrides: Record<string, string> = {}): EnvMap {
  const dbName = `chatbot_${id.replaceAll('-', '_')}`;
  return {
    // 013: servidor remoto con TLS verificado (si no, `database_tls_required`).
    DATABASE_URL: `postgres://${dbName}:${token(24)}@db.interna:5432/${dbName}?sslmode=verify-full`,
    OPERATOR_USER: 'operador',
    OPERATOR_PASSWORD_HASH: argonHash(),
    SESSION_SECRET: hex(),
    DEFAULT_PHONE_REGION: 'ES',
    DEFAULT_TIMEZONE: 'Europe/Madrid',
    DEFAULT_CURRENCY: 'EUR',
    PORT: '3000',
    TRUST_PROXY: '1',
    NODE_ENV: 'production',
    PUBLIC_BASE_URL: `https://${id}.ejemplo.com`,
    EMERGENCY_CONTACT_PHONE: '+34600111222',
    ANTHROPIC_API_KEY: `sk-ant-${token(40)}`,
    INSTANCE_ID: id,
    BACKUP_DIR: `/var/lib/chatbot/${id}/backups`,
    BACKUP_KEY: hex(),
    HEALTH_SECRET: hex(),
    BACKUP_RETENTION_DAYS: '7',
    BACKUP_DAILY_TIME: '03:00',
    ...overrides,
  };
}

/** Variables de WhatsApp completas y válidas. */
export function whatsappVars(): EnvMap {
  return {
    WHATSAPP_PHONE_NUMBER_ID: String(100000000000000 + Math.floor(Math.random() * 1e12)),
    WHATSAPP_ACCESS_TOKEN: token(48),
    WHATSAPP_APP_SECRET: hex(16),
    WHATSAPP_VERIFY_TOKEN: hex(24),
    WHATSAPP_GRAPH_VERSION: 'v23.0',
  };
}

export function instanceFromEnv(
  env: EnvMap,
  options: { status?: InstanceStatus; client?: string; key?: Buffer } = {},
): Instance {
  const status = options.status ?? 'active';
  return {
    id: env.INSTANCE_ID ?? 'sin-id',
    client: options.client ?? `Cliente ${env.INSTANCE_ID ?? ''}`,
    status,
    publicUrl: env.PUBLIC_BASE_URL ?? null,
    imageVersion: '0.1.0',
    llmWorkspace: null,
    backupKeyLocation: null,
    backupDir: env.BACKUP_DIR ?? null,
    database: null,
    dates: { provisioned: TODAY, retired: status === 'retired' ? TODAY : null, dataDeleted: null },
    lastVerification: null,
    lastSuccessfulVerificationAt: null,
    fingerprints: envFingerprints(env, options.key ?? TEST_INVENTORY_KEY, TODAY),
  };
}

export interface SampleInventory {
  inventory: Inventory;
  envs: EnvMap[];
}

/**
 * Inventario con `count` instancias `demo-01…`: la penúltima dada de baja y la última de
 * pruebas (si hay al menos 3).
 */
export function sampleInventory(count = 3): SampleInventory {
  const envs: EnvMap[] = [];
  const inventory = createInventory(TEST_INVENTORY_KEY, TODAY);
  for (let i = 1; i <= count; i++) {
    const id = `demo-${String(i).padStart(2, '0')}`;
    const env = productionEnv(id);
    envs.push(env);
    const status: InstanceStatus =
      count >= 3 && i === count ? 'testing' : count >= 3 && i === count - 1 ? 'retired' : 'active';
    inventory.instances.push(instanceFromEnv(env, { status }));
  }
  return { inventory, envs };
}

/** Todos los valores secretos de un entorno (para buscarlos en salidas e inventario). */
export function collectSecrets(env: EnvMap): string[] {
  const names = [
    'SESSION_SECRET',
    'BACKUP_KEY',
    'HEALTH_SECRET',
    'OPERATOR_PASSWORD_HASH',
    'ANTHROPIC_API_KEY',
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
    'STT_API_KEY',
    'SMTP_URL',
    'DATABASE_URL',
  ];
  const values = names.map((n) => env[n]).filter((v): v is string => v !== undefined && v !== '');
  for (const previous of (env.BACKUP_KEYS_PREVIOUS ?? '').split(',')) {
    if (previous.trim() !== '') values.push(previous.trim());
  }
  const password = databasePassword(env.DATABASE_URL);
  if (password !== null) values.push(password);
  return values;
}

/** `true` si algún secreto aparece en el texto (sin imprimir cuál, para no filtrarlo). */
export function containsAny(text: string, secrets: string[]): boolean {
  return secrets.some((s) => s.length >= 8 && text.includes(s));
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Falla si `output` contiene una URL de base de datos o alguna de sus partes (013, SC-002): la
 * URL completa, la contraseña, el host, el valor de `sslrootcert` o cualquiera de `extra` como
 * texto; el usuario y el nombre de la base, como palabra completa (`admin` no debe confundirse con
 * «administración»). Las partes de menos de 3 caracteres no se buscan: las pruebas usan valores
 * reconocibles.
 */
export function expectNoUrlParts(output: string, url: string, extra: string[] = []): void {
  const substrings = [url, ...extra];
  const words: string[] = [];
  try {
    const u = new URL(url);
    const decode = (s: string) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    };
    substrings.push(decode(u.password), u.hostname.replace(/^\[|\]$/g, ''));
    const ca = u.searchParams.get('sslrootcert');
    if (ca !== null) substrings.push(ca);
    words.push(decode(u.username), decode(u.pathname.replace(/^\//, '')));
  } catch {
    // Una URL no interpretable solo se busca entera.
  }
  // Sin imprimir el valor: el mensaje de fallo no debe filtrar lo que comprueba.
  const leaked =
    substrings.filter((s) => s.length >= 3 && output.includes(s)).length +
    words.filter(
      (w) => w.length >= 3 && new RegExp(`(^|[^\\w])${escapeRegExp(w)}($|[^\\w])`).test(output),
    ).length;
  if (leaked > 0) throw new Error(`La salida contiene ${String(leaked)} parte(s) de la URL`);
}
