/**
 * Inventario de instancias (007, research R6, contracts/inventory-format.md): un JSON local fuera
 * del repositorio, validado con un esquema estricto, sin secretos. Toda escritura va bajo bloqueo
 * exclusivo, relee y valida antes de escribir y termina en un `rename` atómico; un inventario que
 * no se ha podido leer nunca se sobrescribe (FR-031).
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { INSTANCE_ID_PATTERN } from '../config/env.js';
import { isLlmProvider, LLM_PROVIDERS, type LlmProvider } from '../llm/provider.js';
import { compare, type Finding } from './check.js';
import type { EnvMap } from './env-file.js';
import {
  databaseIdentity,
  envFingerprints,
  FINGERPRINT_CLASSES,
  keyCheck,
  parseInventoryKey,
  verifyKey,
  type Fingerprint,
} from './fingerprint.js';
import { ProvisioningError } from './messages.js';
import { isInsideCoreRepo } from './repo-paths.js';

// ---------------------------------------------------------------------------
// Esquema
// ---------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BASE64URL_22 = /^[A-Za-z0-9_-]{22}$/;
/** URL con credenciales: `esquema://usuario:clave@`. */
export const CREDENTIALS_IN_URL = /:\/\/[^\s/@]*:[^\s/@]*@/;

const date = z.string().regex(DATE);
const isoInstant = z.iso.datetime({ offset: true });
const description = z.string().min(1).max(200).nullable();

export const INSTANCE_STATUSES = ['provisioning', 'active', 'testing', 'retired'] as const;
export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

const fingerprintSchema = z.strictObject({
  variable: z.string().min(1).max(64),
  class: z.enum(FINGERPRINT_CLASSES),
  value: z.string().regex(BASE64URL_22),
  current: z.boolean(),
  since: date,
});

const databaseSchema = z.strictObject({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  name: z.string().min(1),
  user: z.string().min(1),
});

const verificationSchema = z.strictObject({
  at: isoInstant,
  file: z.string().min(1).max(255),
  result: z.string().regex(/^[a-z_]+$/),
});

const instanceSchema = z.strictObject({
  id: z.string().regex(INSTANCE_ID_PATTERN),
  client: z.string().min(1).max(120),
  status: z.enum(INSTANCE_STATUSES),
  publicUrl: z.string().min(1).nullable(),
  imageVersion: description,
  llmWorkspace: description,
  /**
   * 017 (FR-009): proveedor del modelo que la instancia declara en su entorno. **Nunca** su
   * credencial: el inventario guarda huellas de secretos, no secretos, y el proveedor no es uno.
   *
   * **Nullable con valor por defecto, y `version` se queda en 1, a propósito.** Hay inventarios
   * reales ahí fuera y `instanceSchema` es un `strictObject`: un campo obligatorio dejaría de
   * cargar los ficheros existentes y rompería `instance:list` antes de que nadie pudiera
   * arreglarlo. `null` significa «el inventario es anterior a la 017 y no lo sabe», que es
   * distinto de cualquier proveedor concreto; un `pnpm instance:sync` lo rellena.
   */
  llmProvider: z.enum(LLM_PROVIDERS).nullable().default(null),
  backupKeyLocation: description,
  backupDir: z.string().min(1).nullable(),
  database: databaseSchema.nullable(),
  dates: z.strictObject({
    provisioned: date,
    retired: date.nullable(),
    dataDeleted: date.nullable(),
  }),
  lastVerification: verificationSchema.nullable(),
  lastSuccessfulVerificationAt: isoInstant.nullable(),
  fingerprints: z.array(fingerprintSchema),
});

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

export const inventorySchema = z
  .strictObject({
    format: z.literal('chatbot-inventory'),
    version: z.literal(1),
    keyCheck: z.string().regex(BASE64URL_22),
    createdAt: date,
    instances: z.array(instanceSchema),
  })
  .superRefine((inv, ctx) => {
    const seen = new Set<string>();
    inv.instances.forEach((instance, i) => {
      if (seen.has(instance.id)) {
        ctx.addIssue({ code: 'custom', path: ['instances', i, 'id'], message: 'id repetido' });
      }
      seen.add(instance.id);
      const retired = instance.status === 'retired';
      if (retired !== (instance.dates.retired !== null)) {
        ctx.addIssue({
          code: 'custom',
          path: ['instances', i, 'dates', 'retired'],
          message: 'estado y fecha de baja no coinciden',
        });
      }
      if (instance.dates.dataDeleted !== null && !retired) {
        ctx.addIssue({
          code: 'custom',
          path: ['instances', i, 'dates', 'dataDeleted'],
          message: 'borrado de datos sin baja',
        });
      }
    });
    if (strings(inv).some((s) => CREDENTIALS_IN_URL.test(s))) {
      ctx.addIssue({ code: 'custom', path: [], message: 'URL con credenciales' });
    }
  });

export type Inventory = z.infer<typeof inventorySchema>;
export type Instance = Inventory['instances'][number];
export type Verification = NonNullable<Instance['lastVerification']>;

/** JSON con sangría de 2, instancias ordenadas por `id` y salto de línea final. */
export function serializeInventory(inventory: Inventory): string {
  const sorted: Inventory = {
    ...inventory,
    instances: [...inventory.instances].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** Inventario vacío con la comprobación de la clave. */
export function createInventory(key: Buffer, today: string): Inventory {
  return {
    format: 'chatbot-inventory',
    version: 1,
    keyCheck: keyCheck(key),
    createdAt: today,
    instances: [],
  };
}

/** Clave nueva del inventario: 32 bytes aleatorios en hex. */
export function newInventoryKey(): string {
  return randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Ruta y lectura
// ---------------------------------------------------------------------------

/** `--inventory` › `INSTANCE_INVENTORY` › `~/.chatbotasesor/inventory.json`; nunca en el repositorio. */
export function resolveInventoryPath(
  option: string | undefined,
  env: NodeJS.ProcessEnv,
  options: { home?: string; root?: string } = {},
): string {
  const fromEnv = env.INSTANCE_INVENTORY?.trim();
  const path = resolve(
    option ??
      (fromEnv !== undefined && fromEnv !== ''
        ? fromEnv
        : join(options.home ?? homedir(), '.chatbotasesor', 'inventory.json')),
  );
  if (isInsideCoreRepo(path, options.root)) throw new ProvisioningError('inventory_in_repo');
  return path;
}

export type InventoryRead =
  | { kind: 'absent'; path: string }
  | { kind: 'unreadable'; path: string; reason: string }
  | { kind: 'ok'; path: string; inventory: Inventory };

/** Motivo sin contenido: solo la ruta del campo del JSON que falla. */
function schemaReason(error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue && issue.path.length > 0 ? ` en ${issue.path.join('.')}` : '';
  return `formato no válido${where}`;
}

export function parseInventory(text: string): { inventory: Inventory } | { reason: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { reason: 'no es un JSON válido' };
  }
  const parsed = inventorySchema.safeParse(data);
  return parsed.success ? { inventory: parsed.data } : { reason: schemaReason(parsed.error) };
}

/** Lee el inventario sin bloqueo (para `check` y `list`, que no escriben). */
export async function readInventory(path: string): Promise<InventoryRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent', path };
    return { kind: 'unreadable', path, reason: 'no se puede abrir el fichero' };
  }
  const parsed = parseInventory(text);
  return 'inventory' in parsed
    ? { kind: 'ok', path, inventory: parsed.inventory }
    : { kind: 'unreadable', path, reason: parsed.reason };
}

export type InventoryAccess =
  | { kind: 'absent'; path: string }
  | { kind: 'unreadable'; path: string; reason: string }
  | { kind: 'key_missing'; path: string }
  | { kind: 'key_wrong'; path: string }
  | { kind: 'ok'; path: string; inventory: Inventory; key: Buffer };

/** Estado del inventario comprobando la clave (FR-026a). */
export function accessWithKey(read: InventoryRead, keyText: string | undefined): InventoryAccess {
  if (read.kind !== 'ok') return read;
  if (keyText === undefined || keyText.trim() === '')
    return { kind: 'key_missing', path: read.path };
  const key = parseInventoryKey(keyText);
  if (!key || !verifyKey(key, read.inventory.keyCheck))
    return { kind: 'key_wrong', path: read.path };
  return { kind: 'ok', path: read.path, inventory: read.inventory, key };
}

export async function loadInventoryForUse(
  path: string,
  keyText: string | undefined,
): Promise<InventoryAccess> {
  return accessWithKey(await readInventory(path), keyText);
}

/** Convierte un acceso fallido en el error de las órdenes que escriben. */
export function requireAccess(
  access: InventoryAccess,
): Extract<InventoryAccess, { kind: 'ok' | 'absent' }> {
  switch (access.kind) {
    case 'unreadable':
      throw new ProvisioningError('inventory_unreadable', {
        reason: access.reason,
        path: access.path,
      });
    case 'key_missing':
      throw new ProvisioningError('inventory_key_missing', { path: access.path });
    case 'key_wrong':
      throw new ProvisioningError('inventory_key_wrong', { path: access.path });
    default:
      return access;
  }
}

// ---------------------------------------------------------------------------
// Bloqueo y escritura atómica
// ---------------------------------------------------------------------------

export interface LockOptions {
  /** Espera máxima para tomar el bloqueo (5 s). */
  waitMs?: number;
  retryMs?: number;
  /** Antigüedad a partir de la cual un bloqueo se señala como posiblemente huérfano (10 min). */
  orphanMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function acquireLock(lockPath: string, options: LockOptions): Promise<void> {
  const waitMs = options.waitMs ?? 5000;
  const retryMs = options.retryMs ?? 100;
  const orphanMs = options.orphanMs ?? 10 * 60 * 1000;
  const deadline = Date.now() + waitMs;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      await handle.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new ProvisioningError('write_failed', { path: lockPath });
      }
    }
    if (Date.now() >= deadline) {
      let orphan = false;
      try {
        orphan = Date.now() - (await stat(lockPath)).mtimeMs > orphanMs;
      } catch {
        // El bloqueo acaba de liberarse: se informa igualmente de que estaba ocupado.
      }
      throw new ProvisioningError('inventory_busy', {
        path: lockPath.replace(/\.lock$/, ''),
        orphan,
      });
    }
    await sleep(retryMs);
  }
}

/**
 * Ejecuta `fn` con el inventario bloqueado. `fn` recibe el inventario releído bajo el bloqueo; si
 * no se puede leer o no es válido, se aborta con `inventory_unreadable` sin llamar a `fn`.
 */
export async function withInventoryLock<T>(
  path: string,
  fn: (read: Exclude<InventoryRead, { kind: 'unreadable' }>) => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const lockPath = `${path}.lock`;
  await acquireLock(lockPath, options);
  try {
    const read = await readInventory(path);
    if (read.kind === 'unreadable') {
      throw new ProvisioningError('inventory_unreadable', { reason: read.reason, path });
    }
    return await fn(read);
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Escribe un fichero de forma atómica: temporal `<ruta>.tmp-<8 hex>` con el modo dado, `fsync` y
 * `rename` (con 3 reintentos ante `EPERM`/`EBUSY` en Windows por antivirus o indexador).
 */
export async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    const fd = openSync(tmp, 'wx', mode);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, path);
        return;
      } catch (error) {
        if (attempt >= 3 || !RETRYABLE.has((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
        await sleep(100 * (attempt + 1));
      }
    }
  } catch {
    await unlink(tmp).catch(() => undefined);
    throw new ProvisioningError('write_failed', { path });
  }
}

/** Valida y escribe el inventario (solo bajo `withInventoryLock`). */
export async function writeInventory(path: string, inventory: Inventory): Promise<void> {
  const parsed = inventorySchema.safeParse(inventory);
  if (!parsed.success) {
    throw new ProvisioningError('inventory_unreadable', {
      reason: schemaReason(parsed.error),
      path,
    });
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, serializeInventory(parsed.data));
}

/** Fecha de calendario `YYYY-MM-DD` del equipo del operador. */
export function localDate(now: Date): string {
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Instante ISO 8601 con el desfase local (`2026-09-30T12:40:11+02:00`). */
export function localInstant(now: Date): string {
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  return `${localDate(now)}T${time}${sign}${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// Operaciones (US4, research R9): puras, sobre el inventario ya leído
// ---------------------------------------------------------------------------

const clone = (inventory: Inventory): Inventory => structuredClone(inventory);

function findInstance(inventory: Inventory, id: string): Instance {
  const instance = inventory.instances.find((i) => i.id === id);
  if (!instance) throw new ProvisioningError('unknown_instance', { id });
  return instance;
}

const present = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== '';

function envOrigin(env: EnvMap): string | null {
  if (!present(env.PUBLIC_BASE_URL)) return null;
  try {
    return new URL(env.PUBLIC_BASE_URL.trim()).origin;
  } catch {
    return null;
  }
}

/** Texto que parece un secreto o una URL con credenciales (`looks_like_secret`). */
export function looksLikeSecret(text: string): boolean {
  const trimmed = text.trim();
  if (CREDENTIALS_IN_URL.test(trimmed)) return true;
  if (/^\$argon2/i.test(trimmed) || /^sk-ant-/i.test(trimmed)) return true;
  if (/^[0-9a-f]{32,}$/i.test(trimmed)) return true;
  return /^[A-Za-z0-9_\-+/=]{32,}$/.test(trimmed) && /\d/.test(trimmed) && /[A-Za-z]/.test(trimmed);
}

function checkText(field: string, value: string, max = 200): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) {
    throw new ProvisioningError(field === 'client' ? 'invalid_client' : 'usage', {
      reason: `El texto de --${field} debe tener entre 1 y ${String(max)} caracteres.`,
    });
  }
  if (looksLikeSecret(trimmed)) throw new ProvisioningError('looks_like_secret', { field });
  return trimmed;
}

/** Coincidencias de un entorno con las demás instancias, como avisos (`register`, `sync`). */
function matchesAsWarnings(
  fps: Fingerprint[],
  inventory: Inventory,
  selfId: string | null,
): Finding[] {
  const comparison = compare(fps, inventory, selfId);
  return [...comparison.errors, ...comparison.warnings];
}

/**
 * 017 (FR-009): proveedor que declara un entorno. **Ausente equivale a `anthropic`** (FR-003), que
 * es lo que permite que los entornos de las dos instancias desplegadas no se toquen.
 *
 * Un valor que no es elegible devuelve `null` en lugar de lanzar: la comprobación previa ya lo
 * rechaza con su mensaje y es su trabajo, no el del inventario, que no debe inventarse un
 * proveedor ni impedir registrar una instancia por un entorno mal escrito.
 */
function envProvider(env: EnvMap): LlmProvider | null {
  const raw = env.LLM_PROVIDER?.trim() ?? '';
  if (raw === '') return 'anthropic';
  return isLlmProvider(raw) ? raw : null;
}

export interface RegisterResult {
  inventory: Inventory;
  instance: Instance;
  warnings: Finding[];
}

/**
 * Registra una instancia existente desde su entorno. Las coincidencias con otras instancias se
 * devuelven como avisos y la instancia se registra igualmente (US4-1).
 */
export function registerInstance(
  inventory: Inventory,
  env: EnvMap,
  key: Buffer,
  options: { client: string; status: 'active' | 'testing'; today: string },
): RegisterResult {
  const id = env.INSTANCE_ID?.trim() ?? '';
  if (!INSTANCE_ID_PATTERN.test(id)) throw new ProvisioningError('env_invalid_instance');
  const existing = inventory.instances.find((i) => i.id === id);
  if (existing) {
    throw new ProvisioningError('duplicate_instance_id', { id, status: existing.status });
  }
  const client = checkText('client', options.client, 120);
  const fingerprints = envFingerprints(env, key, options.today);
  const warnings = matchesAsWarnings(fingerprints, inventory, null);
  const instance: Instance = {
    id,
    client,
    status: options.status,
    publicUrl: envOrigin(env),
    imageVersion: null,
    llmWorkspace: null,
    llmProvider: envProvider(env),
    backupKeyLocation: null,
    backupDir: present(env.BACKUP_DIR) ? env.BACKUP_DIR.trim() : null,
    database: databaseIdentity(env.DATABASE_URL),
    dates: { provisioned: options.today, retired: null, dataDeleted: null },
    lastVerification: null,
    lastSuccessfulVerificationAt: null,
    fingerprints,
  };
  const next = clone(inventory);
  next.instances.push(instance);
  return { inventory: next, instance, warnings };
}

export interface SyncResult {
  inventory: Inventory;
  /** Variables del entorno cuyos valores han cambiado (por nombre). */
  changed: string[];
  warnings: Finding[];
}

const sameFingerprint = (a: Fingerprint, b: Fingerprint) =>
  a.variable === b.variable && a.class === b.class && a.value === b.value;

const envName = (variable: string) =>
  variable === 'DATABASE' || variable === 'DATABASE_USER' || variable === 'DATABASE_PASSWORD'
    ? 'DATABASE_URL'
    : variable;

/**
 * Rotación (FR-032): las huellas que ya no están pasan a anteriores, se añaden las nuevas y
 * ninguna se borra. Actualiza también la base de datos, la URL y el directorio de copias.
 */
export function syncInstance(
  inventory: Inventory,
  id: string,
  env: EnvMap,
  key: Buffer,
  today: string,
): SyncResult {
  findInstance(inventory, id);
  if ((env.INSTANCE_ID ?? '').trim() !== id) {
    throw new ProvisioningError('env_other_instance', { id });
  }
  const next = clone(inventory);
  const instance = findInstance(next, id);
  const fresh = envFingerprints(env, key, today);
  const changed = new Set<string>();

  for (const old of instance.fingerprints) {
    if (
      old.current &&
      old.variable !== 'BACKUP_KEYS_PREVIOUS' &&
      !fresh.some((f) => sameFingerprint(f, old))
    ) {
      old.current = false;
      changed.add(envName(old.variable));
    }
  }
  for (const f of fresh) {
    const known = instance.fingerprints.find((old) => sameFingerprint(old, f));
    if (!known) {
      instance.fingerprints.push(f);
      changed.add(envName(f.variable));
    } else if (f.current && !known.current) {
      known.current = true;
      changed.add(envName(f.variable));
    }
  }

  // 017: el proveedor se refresca aquí, y es además la vía por la que un inventario anterior a la
  // 017 deja de tener `null`. Se anota como cambio bajo el nombre de su variable, porque para el
  // operador es exactamente eso: algo que cambió en el entorno de la instancia.
  const provider = envProvider(env);
  if (provider !== null && provider !== instance.llmProvider) {
    instance.llmProvider = provider;
    changed.add('LLM_PROVIDER');
  }
  const database = databaseIdentity(env.DATABASE_URL);
  if (database) instance.database = database;
  const origin = envOrigin(env);
  if (origin !== null) instance.publicUrl = origin;
  if (present(env.BACKUP_DIR)) instance.backupDir = env.BACKUP_DIR.trim();

  const warnings = matchesAsWarnings(
    fresh.filter((f) => f.current),
    next,
    id,
  );
  return { inventory: next, changed: [...changed].sort(), warnings };
}

export interface UpdateChanges {
  client?: string | undefined;
  image?: string | undefined;
  llmWorkspace?: string | undefined;
  backupKeyLocation?: string | undefined;
  status?: 'active' | 'testing' | undefined;
  dataDeleted?: string | undefined;
}

/** Datos descriptivos y estado (transiciones de data-model.md). No cambia huellas. */
export function updateInstance(
  inventory: Inventory,
  id: string,
  changes: UpdateChanges,
): Inventory {
  const next = clone(inventory);
  const instance = findInstance(next, id);
  if (changes.status !== undefined) {
    if (instance.status === 'retired') {
      throw new ProvisioningError('invalid_transition', {
        id,
        status: instance.status,
        field: 'status',
      });
    }
    instance.status = changes.status;
  }
  if (changes.dataDeleted !== undefined) {
    if (!DATE.test(changes.dataDeleted) || Number.isNaN(Date.parse(changes.dataDeleted))) {
      throw new ProvisioningError('invalid_date');
    }
    if (instance.status !== 'retired') {
      throw new ProvisioningError('invalid_transition', {
        id,
        status: instance.status,
        field: '--data-deleted solo en instancias dadas de baja',
      });
    }
    instance.dates.dataDeleted = changes.dataDeleted;
  }
  if (changes.client !== undefined) instance.client = checkText('client', changes.client, 120);
  if (changes.image !== undefined) instance.imageVersion = checkText('image', changes.image);
  if (changes.llmWorkspace !== undefined) {
    instance.llmWorkspace = checkText('llm-workspace', changes.llmWorkspace);
  }
  if (changes.backupKeyLocation !== undefined) {
    instance.backupKeyLocation = checkText('backup-key-location', changes.backupKeyLocation);
  }
  return next;
}

/** Subconjunto de `db:verify --json` que se anota (006). */
const verifyReportSchema = z.looseObject({
  file: z.string().min(1),
  restorable: z.boolean(),
  failure: z
    .string()
    .regex(/^[a-z_]+$/)
    .optional(),
  sourceInstance: z.string().optional(),
});

export interface RecordResult {
  inventory: Inventory;
  verification: Verification;
}

/** Anota una verificación de copia; rechaza la de otra instancia (FR-028). */
export function recordVerification(
  inventory: Inventory,
  id: string,
  report: unknown,
  now: Date,
): RecordResult {
  findInstance(inventory, id);
  const parsed = verifyReportSchema.safeParse(report);
  if (!parsed.success) throw new ProvisioningError('invalid_report');
  const file = parsed.data.file.split(/[/\\]/).pop() ?? parsed.data.file;
  const prefix = file.includes('__') ? file.slice(0, file.indexOf('__')) : undefined;
  const source = parsed.data.sourceInstance ?? prefix;
  if (source === undefined || !INSTANCE_ID_PATTERN.test(source)) {
    throw new ProvisioningError('invalid_report');
  }
  if (source !== id) throw new ProvisioningError('other_instance', { file, other: source });
  const at = localInstant(now);
  const verification: Verification = {
    at,
    file,
    result: parsed.data.restorable ? 'restorable' : (parsed.data.failure ?? 'db_error'),
  };
  const next = clone(inventory);
  const instance = findInstance(next, id);
  instance.lastVerification = verification;
  if (parsed.data.restorable) instance.lastSuccessfulVerificationAt = at;
  return { inventory: next, verification };
}

/** Baja (FR-028a): solo el inventario; sus valores siguen contando como usados. */
export function retireInstance(inventory: Inventory, id: string, today: string): Inventory {
  const next = clone(inventory);
  const instance = findInstance(next, id);
  if (instance.status === 'retired') {
    throw new ProvisioningError('invalid_transition', { id, status: instance.status });
  }
  instance.status = 'retired';
  instance.dates.retired = today;
  return next;
}

// ---------------------------------------------------------------------------
// Listado (FR-030, SC-007)
// ---------------------------------------------------------------------------

export const VERIFICATION_MAX_DAYS = 31;
const DAY_MS = 24 * 60 * 60 * 1000;

export type InstanceView = Omit<Instance, 'fingerprints'> & { verificationOverdue: boolean };

export function listView(inventory: Inventory, now: Date): InstanceView[] {
  return [...inventory.instances]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ fingerprints: _fingerprints, ...rest }) => {
      const last = rest.lastSuccessfulVerificationAt;
      const overdue =
        rest.status === 'active' &&
        (last === null || now.getTime() - Date.parse(last) > VERIFICATION_MAX_DAYS * DAY_MS);
      return { ...rest, verificationOverdue: overdue };
    });
}

const STATUS_LABELS: Record<InstanceStatus, string> = {
  provisioning: 'en alta',
  active: 'activa',
  testing: 'de pruebas',
  retired: 'de baja',
};

const width = (text: string) => text.length;
const pad = (text: string, size: number) => text + ' '.repeat(Math.max(0, size - width(text)));

/** Tabla de `instance:list` para personas (contracts/instance-commands.md). */
export function formatInstanceList(view: InstanceView[], inventoryPath: string, now: Date): string {
  const count = view.length;
  const rows = view.map((v) => {
    const last = v.lastVerification;
    let verification = '—';
    if (last) {
      const result = last.result === 'restorable' ? 'restaurable' : last.result;
      verification = `${last.at.slice(0, 10)} ${result}`;
      if (v.verificationOverdue) {
        const days = Math.floor((now.getTime() - Date.parse(last.at)) / DAY_MS);
        verification += ` (${String(days)} días)`;
      }
    }
    const notes: string[] = [];
    if (v.dates.retired !== null) notes.push(`baja ${v.dates.retired}`);
    if (v.dates.dataDeleted !== null) notes.push(`datos borrados ${v.dates.dataDeleted}`);
    return {
      mark: v.verificationOverdue ? '!' : ' ',
      cells: [
        v.id,
        v.client,
        STATUS_LABELS[v.status],
        v.imageVersion ?? '—',
        // 017: «—» es «el inventario no lo sabe» (anterior a la 017), no «ninguno».
        v.llmProvider ?? '—',
        verification,
      ],
      notes: notes.length > 0 ? `(${notes.join(', ')})` : '',
    };
  });
  const header = ['ID', 'CLIENTE', 'ESTADO', 'IMAGEN', 'PROVEEDOR', 'ÚLTIMA VERIFICACIÓN'];
  const widths = header.map((h, i) =>
    Math.max(width(h), ...rows.map((r) => width(r.cells[i] ?? ''))),
  );
  const line = (mark: string, cells: string[], notes: string) =>
    `${mark} ${cells.map((c, i) => pad(c, (widths[i] ?? 0) + 2)).join('')}${notes}`.trimEnd();

  const lines = [
    `Inventario ${inventoryPath} — ${String(count)} ${count === 1 ? 'instancia' : 'instancias'}`,
    '',
    line(' ', header, ''),
    ...rows.map((r) => line(r.mark, r.cells, r.notes)),
    '',
  ];
  const overdue = view.filter((v) => v.verificationOverdue).length;
  const active = view.filter((v) => v.status === 'active').length;
  lines.push(
    active === 0
      ? 'No hay instancias activas.'
      : overdue === 0
        ? `Todas las instancias activas tienen una verificación correcta en los últimos ${String(VERIFICATION_MAX_DAYS)} días.`
        : `! ${String(overdue)} ${overdue === 1 ? 'instancia activa' : 'instancias activas'} sin verificación correcta en los últimos ${String(VERIFICATION_MAX_DAYS)} días.`,
  );
  return lines.join('\n');
}
