/**
 * `pnpm instance:*` (007, contracts/instance-commands.md): herramientas del operador para dar de
 * alta instancias. Subórdenes: check, new, db, list, register, sync, update, verified, retire y,
 * desde la 009, versions (versiones del parque) y health-secret (secreto de salud).
 * Se ejecutan en el equipo del operador; ninguna carga el `.env` del repositorio ni es necesaria
 * para que una instancia arranque (FR-034). Salida: 0 correcto/apto, 1 rechazado/no apto,
 * 2 argumentos, fichero ilegible, inventario ilegible o bloqueado, clave o terminal.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  checkResultJson,
  formatCheckResult,
  validate,
  type Finding,
} from '../provisioning/check.js';
import {
  parseEnvFile,
  parseEnvText,
  renderTemplate,
  restoreEnvFile,
  setVariable,
  writeNewEnvFile,
  type EnvMap,
} from '../provisioning/env-file.js';
import { envFingerprints, parseInventoryKey } from '../provisioning/fingerprint.js';
import {
  buildInstanceEnv,
  checkNotUsed,
  envHeader,
  resolveOutputPath,
  validateMinimalData,
  type MinimalInput,
} from '../provisioning/generate.js';
import {
  accessWithKey,
  createInventory,
  formatInstanceList,
  listView,
  localDate,
  loadInventoryForUse,
  newInventoryKey,
  readInventory,
  recordVerification,
  registerInstance,
  requireAccess,
  retireInstance,
  resolveInventoryPath,
  syncInstance,
  updateInstance,
  withInventoryLock,
  writeInventory,
  type Inventory,
  type InventoryRead,
  type LockOptions,
} from '../provisioning/inventory.js';
import {
  buildDatabaseUrl,
  createDatabase,
  databaseNames,
  describeAdminUrl,
  generateDbPassword,
  parseAdminUrl,
  planSql,
  printableSql,
  scramVerifier,
  type CreateDatabaseResult,
  type DbStep,
  type PgConnect,
  type SqlPlan,
} from '../provisioning/database.js';
import { isGitIgnored, isInsideCoreRepo, templatePath } from '../provisioning/repo-paths.js';
import {
  argon2Hasher,
  generateHexSecret,
  type PasswordHasher,
  type RandomSource,
} from '../provisioning/secrets.js';
import {
  annotationPlan,
  applyAnnotations,
  collectVersions,
  exitCode,
  renderJson,
  renderTable,
} from '../provisioning/versions.js';
import {
  commandExitCode,
  commandMessage,
  ProvisioningError,
  type CommandCode,
  type MessageContext,
} from '../provisioning/messages.js';
import {
  verifyCredential,
  type CredentialVerdict,
} from '../llm/credential-probe.js';
import { isLlmProvider, keyVariableOf, type LlmProvider } from '../llm/provider.js';
import { parseArgs, processIO, runIfMain, type CliIO } from './backup-common.js';

/** E/S de las órdenes: la de las CLI de copias más la terminal de salida y la entrada sin eco. */
export interface InstanceIO extends CliIO {
  /** `true` si la salida estándar es una terminal (para mostrar secretos una sola vez). */
  stdoutIsTTY: boolean;
  /** Pregunta sin mostrar lo que se teclea (URL de administración). */
  askHidden(question: string): Promise<string>;
  /** Lee toda la entrada estándar (`instance:verified <id> -`). */
  readStdin(): Promise<string>;
}

/** Dependencias sustituibles en las pruebas. */
export interface InstanceDeps {
  now(): Date;
  lock: LockOptions;
  hasher: PasswordHasher;
  random?: RandomSource;
  /** Plantilla del entorno (`.env.example` del núcleo). */
  templatePath: string;
  /** Raíz del repositorio para la regla de la ruta de salida (por defecto, la del núcleo). */
  repoRoot?: string;
  gitEnv?: NodeJS.ProcessEnv;
  writeInventory: (path: string, inventory: Inventory) => Promise<void>;
  /** Conexión a PostgreSQL de `instance:db` (solo `database.ts` usa `pg`). */
  connectPg?: PgConnect;
  /**
   * 017: verificación de la credencial de `--validar-credencial`, inyectable. Ninguna prueba hace
   * red (FR-038); la real es la única que la hace, y solo con la bandera puesta.
   */
  verifyCredential?: (provider: LlmProvider, apiKey: string) => Promise<CredentialVerdict>;
  /** Pruebas: paso de `instance:db` en el que se inyecta un fallo. */
  dbFailAt?: DbStep;
}

export const defaultDeps = (): InstanceDeps => ({
  now: () => new Date(),
  lock: {},
  hasher: argon2Hasher,
  templatePath: templatePath(),
  writeInventory,
});

export interface Context {
  io: InstanceIO;
  deps: InstanceDeps;
}

type Command = (argv: string[], ctx: Context) => Promise<number>;

const USAGE = [
  'Uso: pnpm instance:<orden> …',
  '  check <entorno> [--inventory <ruta>] [--json] [--validar-credencial]',
  '  new --id <id> --client <nombre> --url https://… --timezone <IANA> --region <XX>',
  '      --currency <XXX> --emergency-phone <tel> [--whatsapp] [--backup-dir <ruta>]',
  '      [--out <ruta>] [--inventory <ruta>] [--create-inventory]',
  '  db <id> [--env <fichero>] [--host <servidor>] [--port <puerto>] [--print-sql]',
  '     [--sslrootcert <ruta>]',
  '  list [--json]',
  '  register <entorno> --client <nombre> [--status active|testing] [--create-inventory]',
  '  sync <id> <entorno>',
  '  update <id> [--client …] [--image …] [--llm-workspace …] [--backup-key-location …]',
  '         [--status active|testing] [--data-deleted AAAA-MM-DD]',
  '  verified <id> <fichero.json | ->',
  '  retire <id> [--yes]',
  '  versions [--json] [--only <id>[,<id>…]] [--envs-dir <carpeta>] [--timeout <s>]',
  '           [--allow-insecure] [--annotate [--yes]]',
  '  health-secret <id> [--rotate] [--env <fichero>]',
].join('\n');

/** Escribe el mensaje de un código por la salida de errores y devuelve su código de salida. */
export function fail(io: CliIO, code: CommandCode, ctx: MessageContext = {}): 1 | 2 {
  io.err(commandMessage(code, ctx));
  return commandExitCode(code);
}

/** Uso incorrecto: explica y sale con 2. */
export function usage(io: CliIO, line: string): 2 {
  io.err(line);
  return 2;
}

/** Exige terminal en la salida estándar antes de generar o mostrar un secreto. */
export function requireInteractive(io: InstanceIO): void {
  if (!io.interactive || !io.stdoutIsTTY) throw new ProvisioningError('not_interactive');
}

/** Clave del inventario: solo de la variable del proceso, nunca de un argumento. */
export function inventoryKeyText(io: CliIO): string | undefined {
  const value = io.env.INSTANCE_INVENTORY_KEY;
  return value === undefined || value.trim() === '' ? undefined : value;
}

// ---------------------------------------------------------------------------
// check (US1)
// ---------------------------------------------------------------------------

const CHECK_USAGE =
  'Uso: pnpm instance:check <entorno> [--inventory <ruta>] [--json] [--validar-credencial]';

/**
 * `instance:check <entorno> [--inventory <ruta>] [--json] [--validar-credencial]`: valida sin
 * escribir nada (FR-009, FR-034).
 *
 * 017: `--validar-credencial` es **opt-in** a propósito (FR-029, SC-009). Sin ella la comprobación
 * sigue siendo local y **sin red**, que es lo que permite ejecutarla en cualquier sitio y lo que
 * hace que su resultado no dependa de que el proveedor esté de buen humor. Con ella se añade una
 * sola petición al listado de modelos, que no genera tokens.
 */
async function checkCommand(argv: string[], { io, deps }: Context): Promise<number> {
  const args = parseArgs(argv, {
    flags: ['--json', '--validar-credencial'],
    options: ['--inventory'],
    positional: 1,
  });
  if (!args) return usage(io, CHECK_USAGE);
  const env = parseEnvFile(resolve(args.positional[0] ?? ''));
  const path = resolveInventoryPath(args.options.get('--inventory'), io.env);
  const access = await loadInventoryForUse(path, inventoryKeyText(io));
  // La petición se hace aquí, no dentro de `validate`, que sigue siendo sincrónica y pura: así la
  // comprobación por omisión no puede hacer red ni por accidente.
  const credentialVerdict = args.flags.has('--validar-credencial')
    ? await verifyEnvCredential(env, deps)
    : undefined;
  const result = validate(env, access, {
    today: localDate(deps.now()),
    ...(credentialVerdict === undefined ? {} : { credentialVerdict }),
  });
  io.out(args.flags.has('--json') ? checkResultJson(result) : formatCheckResult(result));
  return result.ok ? 0 : 1;
}

/**
 * Veredicto de la credencial del proveedor declarado en el entorno que se está comprobando.
 *
 * Sin credencial no hay nada que verificar: su ausencia ya la denuncia la comprobación local, y
 * una petición sin ella no probaría nada.
 */
async function verifyEnvCredential(
  env: EnvMap,
  deps: Context['deps'],
): Promise<CredentialVerdict | undefined> {
  const raw = env.LLM_PROVIDER?.trim() ?? '';
  // Un proveedor no elegible ya es un error de la comprobación local: no se pide nada.
  if (raw !== '' && !isLlmProvider(raw)) return undefined;
  // Ausente equivale a anthropic (FR-003).
  const provider: LlmProvider = raw === '' ? 'anthropic' : raw;
  const apiKey = env[keyVariableOf(provider)]?.trim() ?? '';
  if (apiKey === '') return undefined;
  return (deps.verifyCredential ?? verifyCredential)(provider, apiKey);
}

// ---------------------------------------------------------------------------
// Apertura del inventario para escribir (new, register y el resto)
// ---------------------------------------------------------------------------

/** Clave con la que se escribirá el inventario y si hay que crearlo. */
export interface WriteTarget {
  path: string;
  key: Buffer;
  create: boolean;
  /** Clave nueva (hex) que se mostrará una sola vez al terminar. */
  newKeyHex: string | null;
}

/**
 * Comprueba el inventario antes de tomar el bloqueo. Si no existe y la orden puede crearlo, pide
 * confirmación (`crear` en la terminal o `--create-inventory`); si no, `inventory_missing`.
 */
async function openForWrite(
  io: InstanceIO,
  path: string,
  creation: { allowed: boolean; flag: boolean },
): Promise<WriteTarget> {
  const keyText = inventoryKeyText(io);
  const access = requireAccess(await loadInventoryForUse(path, keyText));
  if (access.kind === 'ok') return { path, key: access.key, create: false, newKeyHex: null };
  if (!creation.allowed) throw new ProvisioningError('inventory_missing', { path });
  if (!creation.flag) {
    if (!io.interactive) throw new ProvisioningError('inventory_missing', { path });
    const elsewhere =
      keyText === undefined
        ? ''
        : ' Hay una INSTANCE_INVENTORY_KEY definida: parece que ya existe un inventario en otra ruta.';
    const answer = await io.ask(
      `No existe un inventario en ${path}.${elsewhere} Si ya tienes uno, revisa INSTANCE_INVENTORY o --inventory. Para crear uno nuevo escribe «crear»: `,
    );
    if (answer.trim() !== 'crear') throw new ProvisioningError('inventory_not_created');
  }
  if (keyText !== undefined) {
    const key = parseInventoryKey(keyText);
    if (!key) throw new ProvisioningError('inventory_key_wrong', { path });
    return { path, key, create: true, newKeyHex: null };
  }
  // Una clave nueva se muestra una sola vez: necesita terminal, como la contraseña (R6, R7).
  requireInteractive(io);
  const hex = newInventoryKey();
  return { path, key: Buffer.from(hex, 'hex'), create: true, newKeyHex: hex };
}

/** Inventario releído bajo el bloqueo con la clave comprobada (o recién creado). */
function inventoryUnderLock(
  read: Exclude<InventoryRead, { kind: 'unreadable' }>,
  target: WriteTarget,
  today: string,
): Inventory {
  if (read.kind === 'absent') {
    if (!target.create) throw new ProvisioningError('inventory_missing', { path: target.path });
    return createInventory(target.key, today);
  }
  const access = requireAccess(accessWithKey(read, target.key.toString('hex')));
  if (access.kind !== 'ok') throw new ProvisioningError('inventory_missing', { path: target.path });
  return access.inventory;
}

function printNewKey(io: CliIO, target: WriteTarget): void {
  if (target.newKeyHex === null) return;
  io.out('');
  io.out(
    `Inventario nuevo creado en ${target.path}. Su clave se muestra SOLO ESTA VEZ: guárdala en tu gestor de secretos y expórtala como INSTANCE_INVENTORY_KEY antes de la siguiente orden:`,
  );
  io.out('');
  io.out(`    ${target.newKeyHex}`);
}

// ---------------------------------------------------------------------------
// new (US2)
// ---------------------------------------------------------------------------

const NEW_FIELDS: Array<[keyof MinimalInput, string, string]> = [
  ['id', '--id', 'Identificador de la instancia (minúsculas, cifras y guiones)'],
  ['client', '--client', 'Nombre del cliente (solo para el inventario)'],
  ['url', '--url', 'URL pública https de la instancia'],
  ['timezone', '--timezone', 'Zona horaria IANA (p. ej. Europe/Madrid)'],
  ['region', '--region', 'Región telefónica (2 letras, p. ej. ES)'],
  ['currency', '--currency', 'Moneda ISO 4217 (p. ej. EUR)'],
  ['emergencyPhone', '--emergency-phone', 'Teléfono de emergencia'],
];

async function newCommand(argv: string[], { io, deps }: Context): Promise<number> {
  const args = parseArgs(argv, {
    flags: ['--whatsapp', '--create-inventory'],
    options: [...NEW_FIELDS.map(([, flag]) => flag), '--backup-dir', '--out', '--inventory'],
  });
  if (!args) return usage(io, USAGE);
  // La contraseña se muestra una sola vez: nada se genera sin terminal (FR-012, R7).
  requireInteractive(io);

  const input: Record<string, string> = {};
  for (const [field, flag, question] of NEW_FIELDS) {
    input[field] = args.options.get(flag) ?? (await io.ask(`${question} (${flag}): `));
  }
  const data = validateMinimalData({
    ...(input as unknown as MinimalInput),
    whatsapp: args.flags.has('--whatsapp'),
    backupDir: args.options.get('--backup-dir'),
  });

  const inventoryPath = resolveInventoryPath(args.options.get('--inventory'), io.env);
  const target = await openForWrite(io, inventoryPath, {
    allowed: true,
    flag: args.flags.has('--create-inventory'),
  });
  const out = args.options.get('--out');
  const envPath = resolveOutputPath(out, inventoryPath, data.id, {
    root: deps.repoRoot,
    gitEnv: deps.gitEnv,
  });
  let template: string;
  try {
    template = readFileSync(deps.templatePath, 'utf8');
  } catch {
    throw new ProvisioningError('env_unreadable', { path: deps.templatePath });
  }
  const today = localDate(deps.now());

  const generated = await withInventoryLock(
    inventoryPath,
    async (read) => {
      const inventory = inventoryUnderLock(read, target, today);
      checkNotUsed(data, inventory, target.key);
      const result = await buildInstanceEnv(data, inventory, target.key, {
        random: deps.random,
        hasher: deps.hasher,
        today,
        templateDefaults: parseEnvText(template),
      });
      const content = renderTemplate(
        template,
        result.values,
        result.pending,
        envHeader(data.id, today),
      );
      try {
        mkdirSync(resolve(envPath, '..'), { recursive: true, mode: 0o700 });
      } catch {
        throw new ProvisioningError('write_failed', { path: envPath });
      }
      writeNewEnvFile(envPath, content);
      try {
        await deps.writeInventory(inventoryPath, {
          ...inventory,
          instances: [...inventory.instances, result.instance],
        });
      } catch (error) {
        // Sus secretos no se usan en ningún sitio: el entorno recién creado se retira.
        try {
          unlinkSync(envPath);
          io.err(`No se ha podido escribir el inventario; se ha borrado ${envPath}.`);
        } catch {
          io.err(`No se ha podido escribir el inventario ni borrar ${envPath}: bórralo a mano.`);
        }
        throw error instanceof ProvisioningError
          ? error
          : new ProvisioningError('write_failed', { path: inventoryPath });
      }
      return result;
    },
    deps.lock,
  );

  const user = parseEnvText(template).OPERATOR_USER ?? 'operador';
  const permissions =
    process.platform === 'win32'
      ? 'hereda los permisos del directorio'
      : 'solo legible por tu usuario';
  io.out(`Instancia ${data.id} dada de alta en el inventario (estado: en alta).`);
  io.out(`Entorno escrito en ${envPath} (${permissions}).`);
  printNewKey(io, target);
  io.out('');
  io.out(`Contraseña del operador del panel (usuario «${user}»). Se muestra SOLO ESTA VEZ:`);
  io.out('');
  io.out(`    ${generated.password}`);
  io.out('');
  io.out('Siguientes pasos:');
  io.out(
    '  1. Guarda la contraseña, el fichero de entorno y su BACKUP_KEY en tu gestor de secretos',
  );
  io.out('     (la BACKUP_KEY, fuera del directorio de copias). Anota dónde con:');
  io.out(`       pnpm instance:update ${data.id} --backup-key-location "<dónde>"`);
  io.out(
    `  2. Crea la base de datos: pnpm instance:db ${data.id}${out === undefined ? '' : ` --env ${envPath}`}`,
  );
  io.out(
    '  3. Completa los valores PENDIENTE del fichero (clave del modelo de lenguaje, WhatsApp, correo).',
  );
  io.out(`  4. Valida: pnpm instance:check ${envPath}`);
  return 0;
}

// ---------------------------------------------------------------------------
// db (US3)
// ---------------------------------------------------------------------------

const DB_USAGE =
  'Uso: pnpm instance:db <id> [--env <fichero>] [--host <servidor>] [--port <puerto>] [--print-sql] [--sslrootcert <ruta>]';

/**
 * URL de administración: de `INSTANCE_DB_ADMIN_URL` o pedida sin eco; solo en memoria (FR-020).
 * Con un servidor remoto exige TLS verificado antes de abrir el inventario o conectar: por esa
 * conexión viaja la credencial de administración (013, FR-007). Igual en cualquier perfil.
 */
async function adminUrlFrom(io: InstanceIO): Promise<string> {
  const fromEnv = io.env.INSTANCE_DB_ADMIN_URL?.trim();
  let url = fromEnv === undefined || fromEnv === '' ? undefined : fromEnv;
  if (url === undefined) {
    if (!io.interactive) throw new ProvisioningError('admin_url_required');
    url = (
      await io.askHidden(
        'URL de administración del servidor (postgres://usuario:clave@servidor:puerto/postgres): ',
      )
    ).trim();
  }
  const target = parseAdminUrl(url);
  if (target === null) throw new ProvisioningError('admin_url_invalid');
  if (!target.local && !target.verifiedTls) {
    // Con una IP, `verify-full` no comprueba el nombre del certificado.
    throw new ProvisioningError(target.ipHost ? 'admin_url_ip_host' : 'admin_url_tls_required');
  }
  return url;
}

function failureReport(
  io: CliIO,
  result: CreateDatabaseResult,
  plan: SqlPlan,
  adminUrl: string,
  restored: boolean,
): void {
  const { database: db, user } = plan.names;
  const failure = result.failure;
  if (!failure) return;
  const envLine = restored
    ? '  DATABASE_URL ha vuelto a quedar vacía y el inventario no se ha modificado.'
    : '  No se ha podido vaciar DATABASE_URL: vacíala a mano. El inventario no se ha modificado.';
  switch (failure.code) {
    case 'db_exists':
      io.err(commandMessage('db_exists', { name: db }));
      break;
    case 'role_exists':
      io.err(commandMessage('role_exists', { user }));
      break;
    case 'admin_connect_failed':
      io.err(commandMessage('admin_connect_failed', parseAdminUrl(adminUrl) ?? {}));
      break;
    case 'permission_denied':
      io.err(commandMessage('permission_denied'));
      break;
    default:
      break;
  }
  if (
    failure.code !== 'step_failed' &&
    failure.code !== 'probe_failed' &&
    failure.code !== 'permission_denied'
  ) {
    io.err(envLine.trim());
    return;
  }
  const created = result.steps.includes('database');
  const title: Record<string, string> = {
    check: 'Fallo al comprobar los nombres',
    role: 'Fallo al crear el usuario',
    database: 'Fallo al crear la base de datos',
    revoke: 'Fallo al retirar el acceso general',
    probe: 'Fallo al comprobar la conexión del usuario nuevo',
  };
  io.err(`${title[failure.step] ?? 'Fallo'} (paso: ${failure.step}).`);
  if (result.rolledBack.includes('role')) io.err(`  Deshecho: usuario ${user} retirado.`);
  if (created) {
    io.err(`  Quedan creados: base de datos ${db} (vacía) y usuario ${user}.`);
    io.err('  No se ha borrado nada. Para terminar a mano:');
    if (!result.steps.includes('revoke')) io.err(`    ${plan.revoke}`);
    else io.err('    comprueba la conexión del usuario y el acceso de red al servidor.');
    io.err(`  o para retirarlo: DROP DATABASE ${pgIdent(db)}; ${plan.dropRole}`);
  } else if (result.steps.includes('role') && !result.rolledBack.includes('role')) {
    io.err(`  Queda creado el usuario ${user}. Para retirarlo: ${plan.dropRole}`);
  } else {
    io.err('  No queda nada creado en el servidor.');
  }
  io.err(envLine);
}

const pgIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function dbCommand(argv: string[], { io, deps }: Context): Promise<number> {
  const args = parseArgs(argv, {
    flags: ['--print-sql'],
    options: ['--env', '--host', '--port', '--sslrootcert', '--inventory'],
    positional: 1,
  });
  if (!args) return usage(io, DB_USAGE);
  const id = args.positional[0] ?? '';
  const printSql = args.flags.has('--print-sql');
  const hostOption = args.options.get('--host');
  const portOption = args.options.get('--port');
  const port = portOption === undefined ? undefined : Number(portOption);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return usage(io, DB_USAGE);
  }
  if (printSql && (hostOption === undefined || port === undefined)) {
    throw new ProvisioningError('print_sql_needs_host');
  }

  const inventoryPath = resolveInventoryPath(args.options.get('--inventory'), io.env);
  const envOption = args.options.get('--env');
  const envPath = resolve(envOption ?? resolve(inventoryPath, '..', 'envs', `${id}.env`));
  let env;
  try {
    env = parseEnvFile(envPath);
  } catch (error) {
    if (error instanceof ProvisioningError && envOption === undefined) {
      throw new ProvisioningError('env_unreadable', { path: envPath, reason: 'default' });
    }
    throw error;
  }
  const adminUrl = printSql ? null : await adminUrlFrom(io);
  const admin = adminUrl === null ? null : parseAdminUrl(adminUrl);
  const target = await openForWrite(io, inventoryPath, { allowed: false, flag: false });
  const today = localDate(deps.now());

  // El bloqueo se mantiene toda la orden: impide dos `db` a la vez de la misma instancia.
  return withInventoryLock(
    inventoryPath,
    async (read) => {
      const inventory = inventoryUnderLock(read, target, today);
      const instance = inventory.instances.find((i) => i.id === id);
      if (!instance) throw new ProvisioningError('unknown_instance', { id });
      if (instance.status === 'retired') throw new ProvisioningError('instance_retired', { id });
      if (instance.database !== null) {
        throw new ProvisioningError('database_already_registered', { id });
      }
      if ((env.INSTANCE_ID ?? '').trim() !== id) {
        throw new ProvisioningError('env_other_instance', { id });
      }
      if ((env.DATABASE_URL ?? '').trim() !== '') {
        throw new ProvisioningError('database_url_set', { path: envPath });
      }

      const names = databaseNames(id);
      const password = generateDbPassword(deps.random);
      const salt = (deps.random?.bytes ?? randomBytes)(16);
      const plan = planSql(names, scramVerifier(password, salt));
      const host = (hostOption ?? admin?.host ?? '').toLowerCase();
      const dbPort = port ?? admin?.port ?? 5432;
      const databaseUrl = buildDatabaseUrl({
        host,
        port: dbPort,
        database: names.database,
        user: names.user,
        password,
        sslmode: admin?.sslmode ?? null,
        // Ruta dentro del contenedor; la de la URL de administración es del equipo del operador.
        sslrootcert: args.options.get('--sslrootcert') ?? null,
        defaultVerifyFull: true,
      });
      const identity = { host, port: dbPort, name: names.database, user: names.user };

      // La contraseña nunca existe solo en memoria: primero va al fichero de entorno.
      const original = await setVariable(envPath, 'DATABASE_URL', databaseUrl);

      if (adminUrl !== null) {
        const result = await createDatabase(adminUrl, plan, password, identity, {
          connect: deps.connectPg,
          failAt: deps.dbFailAt,
        });
        if (result.failure) {
          let restored = true;
          try {
            await restoreEnvFile(envPath, original);
          } catch {
            restored = false;
          }
          failureReport(io, result, plan, adminUrl, restored);
          return 1;
        }
      }

      const fingerprints = envFingerprints({ DATABASE_URL: databaseUrl }, target.key, today);
      try {
        await deps.writeInventory(inventoryPath, {
          ...inventory,
          instances: inventory.instances.map((i) =>
            i.id === id
              ? { ...i, database: identity, fingerprints: [...i.fingerprints, ...fingerprints] }
              : i,
          ),
        });
      } catch {
        return fail(io, 'inventory_not_updated', { id, path: envPath });
      }

      if (adminUrl === null) {
        for (const line of printableSql(plan)) io.out(line);
        // Todo en comentarios SQL: la salida se puede pasar tal cual a psql.
        io.out('');
        io.out(`-- DATABASE_URL (con la contraseña) escrita en ${envPath}; no se muestra aquí.`);
        io.out('-- Inventario actualizado.');
        return 0;
      }
      io.out(`Base de datos creada en ${describeAdminUrl(adminUrl)}`);
      io.out(`  base de datos  ${names.database} (vacía; solo su usuario puede conectarse)`);
      io.out(`  usuario        ${names.user} (sin privilegios de administración)`);
      io.out('  comprobado     el usuario se conecta a su base de datos');
      io.out(`DATABASE_URL escrita en ${envPath}. Inventario actualizado.`);
      io.out('Las credenciales de administración no se han guardado.');
      return 0;
    },
    deps.lock,
  );
}

// ---------------------------------------------------------------------------
// Inventario (US4)
// ---------------------------------------------------------------------------

/** Escribe bajo bloqueo el resultado de `change` sobre el inventario releído. */
async function mutateInventory<T extends { inventory: Inventory }>(
  target: WriteTarget,
  deps: InstanceDeps,
  change: (inventory: Inventory, today: string) => T,
): Promise<T> {
  const today = localDate(deps.now());
  return withInventoryLock(
    target.path,
    async (read) => {
      const result = change(inventoryUnderLock(read, target, today), today);
      await deps.writeInventory(target.path, result.inventory);
      return result;
    },
    deps.lock,
  );
}

function printMatches(io: CliIO, warnings: Finding[]): void {
  for (const w of warnings)
    io.out(`  ! ${w.variable ?? ''}: ${w.detail ?? w.message}`.replace('! : ', '! '));
}

async function listCommand(argv: string[], { io, deps }: Context): Promise<number> {
  const args = parseArgs(argv, { flags: ['--json'], options: ['--inventory'] });
  if (!args) return usage(io, 'Uso: pnpm instance:list [--json]');
  const path = resolveInventoryPath(args.options.get('--inventory'), io.env);
  const read = await readInventory(path);
  if (read.kind === 'absent') throw new ProvisioningError('inventory_missing', { path });
  if (read.kind === 'unreadable') {
    throw new ProvisioningError('inventory_unreadable', { path, reason: read.reason });
  }
  // `list` no compara ni escribe: no exige la clave, pero si se da, la comprueba.
  const keyText = inventoryKeyText(io);
  if (keyText !== undefined) requireAccess(accessWithKey(read, keyText));
  const view = listView(read.inventory, deps.now());
  io.out(
    args.flags.has('--json')
      ? JSON.stringify({ inventory: path, instances: view })
      : formatInstanceList(view, path, deps.now()),
  );
  return 0;
}

async function registerCommand(argv: string[], { io, deps }: Context): Promise<number> {
  const args = parseArgs(argv, {
    flags: ['--create-inventory'],
    options: ['--client', '--status', '--inventory'],
    positional: 1,
  });
  const status = args?.options.get('--status') ?? 'active';
  const client = args?.options.get('--client');
  if (!args || client === undefined || (status !== 'active' && status !== 'testing')) {
    return usage(
      io,
      'Uso: pnpm instance:register <entorno> --client <nombre> [--status active|testing] [--create-inventory]',
    );
  }
  const envPath = resolve(args.positional[0] ?? '');
  const env = parseEnvFile(envPath);
  const path = resolveInventoryPath(args.options.get('--inventory'), io.env);
  const target = await openForWrite(io, path, {
    allowed: true,
    flag: args.flags.has('--create-inventory'),
  });
  const result = await mutateInventory(target, deps, (inventory, today) =>
    registerInstance(inventory, env, target.key, { client, status, today }),
  );
  const id = result.instance.id;
  io.out(
    `Instancia ${id} registrada en el inventario (estado: ${status === 'active' ? 'activa' : 'de pruebas'}).`,
  );
  if (result.warnings.length > 0) {
    io.out(`Coincide con otras instancias (${String(result.warnings.length)}):`);
    printMatches(io, result.warnings);
    io.out(
      `Revisa las coincidencias; si cambias el entorno, actualiza el inventario con: pnpm instance:sync ${id} ${envPath}`,
    );
  }
  printNewKey(io, target);
  return 0;
}

async function syncCommand(argv: string[], { io, deps }: Context): Promise<number> {
  const args = parseArgs(argv, { options: ['--inventory'], positional: 2 });
  if (!args) return usage(io, 'Uso: pnpm instance:sync <id> <entorno>');
  const [id = '', file = ''] = args.positional;
  const env = parseEnvFile(resolve(file));
  const path = resolveInventoryPath(args.options.get('--inventory'), io.env);
  const target = await openForWrite(io, path, { allowed: false, flag: false });
  const result = await mutateInventory(target, deps, (inventory, today) =>
    syncInstance(inventory, id, env, target.key, today),
  );
  io.out(
    result.changed.length === 0
      ? `Inventario de ${id} sin cambios: el entorno coincide con lo registrado.`
      : `Inventario de ${id} actualizado. Cambian: ${result.changed.join(', ')}. Los valores anteriores siguen contando como usados.`,
  );
  if (result.warnings.length > 0) {
    io.out(`Coincide con otras instancias (${String(result.warnings.length)}):`);
    printMatches(io, result.warnings);
  }
  return 0;
}

async function updateCommand(argv: string[], { io, deps }: Context): Promise<number> {
  const options = [
    '--client',
    '--image',
    '--llm-workspace',
    '--backup-key-location',
    '--status',
    '--data-deleted',
  ];
  const args = parseArgs(argv, { options: [...options, '--inventory'], positional: 1 });
  const status = args?.options.get('--status');
  if (
    !args ||
    !options.some((o) => args.options.has(o)) ||
    (status !== undefined && status !== 'active' && status !== 'testing')
  ) {
    return usage(
      io,
      'Uso: pnpm instance:update <id> [--client …] [--image …] [--llm-workspace …] [--backup-key-location …] [--status active|testing] [--data-deleted AAAA-MM-DD]',
    );
  }
  const id = args.positional[0] ?? '';
  const path = resolveInventoryPath(args.options.get('--inventory'), io.env);
  const target = await openForWrite(io, path, { allowed: false, flag: false });
  await mutateInventory(target, deps, (inventory) => ({
    inventory: updateInstance(inventory, id, {
      client: args.options.get('--client'),
      image: args.options.get('--image'),
      llmWorkspace: args.options.get('--llm-workspace'),
      backupKeyLocation: args.options.get('--backup-key-location'),
      status: status,
      dataDeleted: args.options.get('--data-deleted'),
    }),
  }));
  io.out(`Instancia ${id} actualizada.`);
  return 0;
}

async function verifiedCommand(argv: string[], { io, deps }: Context): Promise<number> {
  const args = parseArgs(argv, { options: ['--inventory'], positional: 2 });
  if (!args) return usage(io, 'Uso: pnpm instance:verified <id> <fichero.json | ->');
  const [id = '', file = ''] = args.positional;
  let text: string;
  try {
    text = file === '-' ? await io.readStdin() : readFileSync(resolve(file), 'utf8');
  } catch {
    throw new ProvisioningError('env_unreadable', { path: file });
  }
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    throw new ProvisioningError('invalid_report');
  }
  const path = resolveInventoryPath(args.options.get('--inventory'), io.env);
  const target = await openForWrite(io, path, { allowed: false, flag: false });
  const result = await mutateInventory(target, deps, (inventory) =>
    recordVerification(inventory, id, report, deps.now()),
  );
  const outcome =
    result.verification.result === 'restorable' ? 'restaurable' : result.verification.result;
  io.out(`Verificación anotada: ${result.verification.file} · ${outcome}`);
  return 0;
}

async function retireCommand(argv: string[], { io, deps }: Context): Promise<number> {
  const args = parseArgs(argv, { flags: ['--yes'], options: ['--inventory'], positional: 1 });
  if (!args) return usage(io, 'Uso: pnpm instance:retire <id> [--yes]');
  const id = args.positional[0] ?? '';
  const path = resolveInventoryPath(args.options.get('--inventory'), io.env);
  const target = await openForWrite(io, path, { allowed: false, flag: false });
  if (!args.flags.has('--yes')) {
    if (!io.interactive) {
      return usage(io, 'Sin terminal, confirma la baja con --yes.');
    }
    const answer = await io.ask(
      `Vas a dar de baja la instancia ${id} en el inventario. Para confirmar escribe su identificador: `,
    );
    if (answer.trim() !== id) throw new ProvisioningError('confirmation_failed');
  }
  await mutateInventory(target, deps, (inventory, today) => ({
    inventory: retireInstance(inventory, id, today),
  }));
  io.out(
    `Instancia ${id} dada de baja en el inventario. Sus identificadores y secretos siguen contando`,
  );
  io.out('como usados. Esta herramienta no borra nada. Pasos manuales:');
  io.out('  1. Desactiva el chat web y retira el webhook de WhatsApp en Meta.');
  io.out('  2. Entrega al cliente los datos que correspondan según el contrato.');
  io.out('  3. Para el contenedor, revoca su clave del modelo de lenguaje y elimina sus secretos.');
  io.out(
    '  4. En el plazo acordado, borra la base de datos, el volumen de copias y sus réplicas, y anótalo:',
  );
  io.out(`       pnpm instance:update ${id} --data-deleted <YYYY-MM-DD>`);
  return 0;
}

// ---------------------------------------------------------------------------
// versions (009, US2)
// ---------------------------------------------------------------------------

const VERSIONS_USAGE =
  'Uso: pnpm instance:versions [--json] [--only <id>[,<id>…]] [--envs-dir <carpeta>] [--timeout <s>] [--allow-insecure] [--annotate [--yes]]';

/**
 * `instance:versions`: consulta `/health` de cada instancia no retirada y compara con lo anotado.
 * Solo lectura salvo `--annotate` con confirmación (R5, R6).
 */
async function versionsCommand(argv: string[], { io, deps }: Context): Promise<number> {
  const args = parseArgs(argv, {
    flags: ['--json', '--allow-insecure', '--annotate', '--yes'],
    options: ['--only', '--envs-dir', '--timeout', '--inventory'],
  });
  if (!args) return usage(io, VERSIONS_USAGE);
  const timeoutText = args.options.get('--timeout') ?? '5';
  const timeout = /^\d+$/.test(timeoutText) ? Number(timeoutText) : NaN;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30) {
    return usage(io, 'El tiempo límite (--timeout) debe ser un número de segundos entre 1 y 30.');
  }
  const json = args.flags.has('--json');
  const annotate = args.flags.has('--annotate');

  const path = resolveInventoryPath(args.options.get('--inventory'), io.env);
  // Leer no necesita el bloqueo (R5); la clave se comprueba igualmente.
  const access = requireAccess(await loadInventoryForUse(path, inventoryKeyText(io)));
  if (access.kind !== 'ok') throw new ProvisioningError('inventory_missing', { path });
  const { inventory } = access;

  const only = args.options
    .get('--only')
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const unknown = only?.find((id) => !inventory.instances.some((i) => i.id === id));
  if (unknown !== undefined) {
    return usage(io, commandMessage('unknown_instance', { id: unknown }));
  }

  const report = await collectVersions(inventory, {
    envsDir: resolve(args.options.get('--envs-dir') ?? join(dirname(path), 'envs')),
    ...(only ? { only } : {}),
    timeoutMs: timeout * 1000,
    allowInsecure: args.flags.has('--allow-insecure'),
    now: () => deps.now(),
  });
  io.out(json ? renderJson(report) : renderTable(report));
  if (!annotate) return exitCode(report);

  // --annotate: con --json los mensajes van por la salida de errores para no romper el JSON.
  const say = (text: string) => {
    if (json) io.err(text);
    else io.out(text);
  };
  const plan = annotationPlan(report);
  say('');
  if (plan.length === 0) {
    say('No hay versiones que anotar.');
    return exitCode(report);
  }
  say('Versiones observadas distintas de las anotadas:');
  for (const change of plan) say(`  ${change.id}: ${change.from ?? 'sin anotar'} → ${change.to}`);
  if (!args.flags.has('--yes')) {
    if (!io.interactive) {
      return usage(io, 'Sin terminal, confirma la anotación con --yes. No se ha anotado nada.');
    }
    const answer = (await io.ask('¿Anotar estas versiones? (s/N) ')).trim().toLowerCase();
    if (answer !== 's' && answer !== 'si' && answer !== 'sí') {
      say('No se ha anotado nada.');
      return exitCode(report);
    }
  }
  const target = await openForWrite(io, path, { allowed: false, flag: false });
  const result = await mutateInventory(target, deps, (current) => applyAnnotations(current, plan));
  if (result.applied.length > 0) say(`Anotado en el inventario: ${result.applied.join(', ')}.`);
  for (const id of result.skipped) {
    say(`  ${id}: su anotación cambió durante la consulta; no se ha anotado. Repite la orden.`);
  }
  return exitCode(report);
}

// ---------------------------------------------------------------------------
// health-secret (009, US2)
// ---------------------------------------------------------------------------

const HEALTH_SECRET_USAGE = 'Uso: pnpm instance:health-secret <id> [--rotate] [--env <fichero>]';

/**
 * `instance:health-secret <id>`: añade (o con `--rotate` cambia) el secreto de salud en el entorno
 * de una instancia, sin tocar el resto del fichero y sin mostrarlo (R2). Todos sus rechazos salen
 * con 2 (contrato).
 */
async function healthSecretCommand(argv: string[], { io, deps }: Context): Promise<number> {
  const args = parseArgs(argv, {
    flags: ['--rotate'],
    options: ['--env', '--inventory'],
    positional: 1,
  });
  if (!args) return usage(io, HEALTH_SECRET_USAGE);
  const id = args.positional[0] ?? '';
  const rotate = args.flags.has('--rotate');
  try {
    const path = resolveInventoryPath(args.options.get('--inventory'), io.env);
    const access = requireAccess(await loadInventoryForUse(path, inventoryKeyText(io)));
    if (access.kind !== 'ok') throw new ProvisioningError('inventory_missing', { path });
    if (!access.inventory.instances.some((i) => i.id === id)) {
      throw new ProvisioningError('unknown_instance', { id });
    }
    const envOption = args.options.get('--env');
    const envPath = resolve(envOption ?? join(dirname(path), 'envs', `${id}.env`));
    if (
      isInsideCoreRepo(envPath, deps.repoRoot) &&
      !isGitIgnored(envPath, { root: deps.repoRoot, env: deps.gitEnv })
    ) {
      throw new ProvisioningError('output_in_repo', { path: envPath });
    }
    let env;
    try {
      env = parseEnvFile(envPath);
    } catch (error) {
      if (error instanceof ProvisioningError && envOption === undefined) {
        throw new ProvisioningError('env_unreadable', { path: envPath, reason: 'default' });
      }
      throw error;
    }

    const current = env.HEALTH_SECRET?.trim().toLowerCase() ?? '';
    if (current !== '' && !rotate) {
      io.out(
        `Ya tiene secreto de salud: ${envPath} no se ha cambiado (usa --rotate para cambiarlo).`,
      );
      return 0;
    }
    const others = new Set(
      [env.SESSION_SECRET, env.BACKUP_KEY, current].map((v) => v?.trim().toLowerCase() ?? ''),
    );
    let secret = '';
    for (let i = 0; i < 5 && (secret === '' || others.has(secret)); i++) {
      secret = generateHexSecret('HEALTH_SECRET', deps.random);
    }
    if (others.has(secret)) throw new ProvisioningError('duplicate_value');
    await setVariable(envPath, 'HEALTH_SECRET', secret, { overwrite: rotate });

    io.out(
      `${rotate && current !== '' ? 'Secreto de salud cambiado' : 'Secreto de salud añadido'} en ${envPath} (no se muestra).`,
    );
    io.out('Siguientes pasos:');
    io.out('  1. Despliega el entorno actualizado en la instancia y reiníciala.');
    io.out(`  2. Guarda su huella en el inventario: pnpm instance:sync ${id} ${envPath}`);
    io.out(`  3. Comprueba: pnpm instance:versions --only ${id}`);
    return 0;
  } catch (error) {
    if (!(error instanceof ProvisioningError)) throw error;
    // El contrato fija 2 para cualquier rechazo de esta orden.
    io.err(commandMessage(error.code, error.ctx));
    return 2;
  }
}

// ---------------------------------------------------------------------------
// Despacho
// ---------------------------------------------------------------------------

const commands: Record<string, Command> = {
  check: checkCommand,
  new: newCommand,
  db: dbCommand,
  list: listCommand,
  register: registerCommand,
  sync: syncCommand,
  update: updateCommand,
  verified: verifiedCommand,
  retire: retireCommand,
  versions: versionsCommand,
  'health-secret': healthSecretCommand,
};

export async function main(
  argv: string[],
  io: InstanceIO = processInstanceIO(),
  deps: InstanceDeps = defaultDeps(),
): Promise<number> {
  const [name, ...rest] = argv;
  const command = name === undefined ? undefined : commands[name];
  if (!command) return usage(io, USAGE);
  try {
    return await command(rest, { io, deps });
  } catch (error) {
    if (error instanceof ProvisioningError) return fail(io, error.code, error.ctx);
    // Nunca el texto de una excepción no prevista: podría llevar un secreto o una URL.
    return fail(io, 'unexpected');
  }
}

async function readHidden(question: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) return '';
  stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (key: string) => {
      for (const char of key) {
        if (char === '\u0003') {
          stdin.setRawMode(false);
          stdin.off('data', onData);
          reject(new Error('Cancelado'));
          return;
        }
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stderr.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

export function processInstanceIO(): InstanceIO {
  const base = processIO();
  return {
    ...base,
    stdoutIsTTY: process.stdout.isTTY,
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    askHidden: readHidden,
    async readStdin() {
      let data = '';
      for await (const chunk of process.stdin) data += String(chunk);
      return data;
    },
  };
}

runIfMain(import.meta, (argv) => main(argv));
