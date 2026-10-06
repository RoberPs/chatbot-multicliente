/**
 * Lo común a `db:backup`, `db:restore`, `db:verify` y `db:backups` (006,
 * contracts/backup-commands.md): argumentos, entorno, rutas, formato en español, mensajes de
 * fallo y salida `--json`. Ninguna salida lleva la clave, textos, teléfonos ni nombres.
 */
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import type { BackupFailureCode, RestoreFailure, RestoreFailureCode } from '../backup/errors.js';
import {
  DatabaseConfigError,
  type DatabaseConfigReason,
  type DatabaseUrlVariable,
} from '../config/database-url.js';
import { loadDotEnvIfPresent, loadEnv, type Env } from '../config/env.js';
import type { LoggerLike } from '../conversation/activity-log.js';

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  env: NodeJS.ProcessEnv;
  /** `true` si se puede preguntar al operador. */
  interactive: boolean;
  ask(question: string): Promise<string>;
  /** Registros técnicos (JSON por stderr en el proceso real). */
  logger: LoggerLike;
}

/** Registros en una línea JSON, como pino, por la salida de errores. */
function jsonLogger(write: (line: string) => void): LoggerLike {
  const levels = { debug: 20, info: 30, warn: 40, error: 50 } as const;
  const make =
    (level: keyof typeof levels) =>
    (obj: object, msg?: string): void => {
      if (level === 'debug') return;
      write(JSON.stringify({ level: levels[level], time: Date.now(), ...obj, msg }));
    };
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') };
}

export function processIO(): CliIO {
  return {
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    env: process.env,
    interactive: process.stdin.isTTY,
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    logger: jsonLogger((line) => process.stderr.write(`${line}\n`)),
  };
}

export interface ParsedArgs {
  positional: string[];
  flags: Set<string>;
  options: Map<string, string>;
}

/** Argumentos con `--flag` y `--opcion valor`; `null` si hay alguno desconocido. */
export function parseArgs(
  argv: string[],
  spec: { flags?: string[]; options?: string[]; positional?: number },
): ParsedArgs | null {
  const parsed: ParsedArgs = { positional: [], flags: new Set(), options: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (spec.flags?.includes(arg)) parsed.flags.add(arg);
    else if (spec.options?.includes(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return null;
      parsed.options.set(arg, value);
    } else if (arg.startsWith('--')) return null;
    else parsed.positional.push(arg);
  }
  if (parsed.positional.length !== (spec.positional ?? 0)) return null;
  return parsed;
}

/** Carga la configuración; si no es válida, la explica y devuelve `null` (salida 2). */
export function loadCliEnv(io: CliIO): Env | null {
  if (io.env === process.env) loadDotEnvIfPresent();
  try {
    return loadEnv(io.env);
  } catch (error) {
    io.err((error as Error).message);
    return null;
  }
}

/** `<fichero>`: un nombre se busca en `BACKUP_DIR`; una ruta se usa tal cual. */
export function resolveBackupPath(input: string, dir: string | undefined): string {
  if (isAbsolute(input) || input.includes('/') || input.includes('\\') || dir === undefined) {
    return resolve(input);
  }
  return join(dir, input);
}

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

const decimal = new Intl.NumberFormat('es-ES', {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${decimal.format(bytes / 1024)} KB`;
  return `${decimal.format(bytes / (1024 * 1024))} MB`;
}

/** `3 410`: miles separados por espacio. */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function formatTables(tables: Array<{ name: string; rows: number }>): string {
  return tables.map((t) => `${t.name} ${formatCount(t.rows)}`).join(' · ');
}

/** `2026-09-29 12:15 (Europe/Madrid)`: fecha y hora local del negocio. */
export function formatLocal(iso: string, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${timezone})`;
}

/** Zona horaria del negocio leída de la BD; si no se puede, la de la instancia. */
export async function businessTimezone(url: string, fallback: string): Promise<string> {
  let client: pg.Client | null = null;
  try {
    // Dentro del try: `pg` lee `sslrootcert` al construir el cliente y puede lanzar.
    client = new pg.Client({ connectionString: url });
    client.on('error', () => undefined);
    await client.connect();
    const result = await client.query<{ timezone: string }>(
      'select timezone from business where id = 1',
    );
    return result.rows[0]?.timezone ?? fallback;
  } catch {
    return fallback;
  } finally {
    await client?.end().catch(() => undefined);
  }
}

export function printJson(io: CliIO, value: unknown): void {
  io.out(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Mensajes
// ---------------------------------------------------------------------------

/** Motivo de `DatabaseConfigError` de cada código de TLS de las copias (013). */
const TLS_REASONS = {
  db_ca_unreadable: 'ca_unreadable',
  db_tls_untrusted: 'tls_untrusted',
  db_tls_unsupported: 'tls_unsupported',
} as const satisfies Record<string, DatabaseConfigReason>;

/** Mensaje y acción de un fallo de TLS, con la variable de la URL que usa la orden. */
export function tlsFailureMessage(
  code: keyof typeof TLS_REASONS,
  variable: DatabaseUrlVariable,
): string {
  return new DatabaseConfigError(TLS_REASONS[code], variable).describe();
}

export const backupFailureMessages: Record<BackupFailureCode, string> = {
  key_missing:
    'Falta BACKUP_KEY. Genérala con openssl rand -hex 32 y guárdala fuera del directorio de copias.',
  key_invalid: 'BACKUP_KEY debe ser 32 bytes aleatorios en hexadecimal.',
  dir_missing: 'El directorio de copias (BACKUP_DIR) no existe.',
  dir_not_writable: 'No se puede escribir en el directorio de copias (BACKUP_DIR).',
  no_space: 'No hay espacio suficiente en el directorio de copias.',
  busy: 'Ya hay una copia en curso en esta instancia; inténtalo cuando termine.',
  db_error: 'No se pudo leer la base de datos de la instancia.',
  io_error: 'Error al escribir la copia.',
  db_ca_unreadable: tlsFailureMessage('db_ca_unreadable', 'DATABASE_URL'),
  db_tls_untrusted: tlsFailureMessage('db_tls_untrusted', 'DATABASE_URL'),
  db_tls_unsupported: tlsFailureMessage('db_tls_unsupported', 'DATABASE_URL'),
};

/** Motivo corto, en minúscula, para `NO RESTAURABLE: <motivo> (<código>)`. */
export const restoreFailureReasons: Record<RestoreFailureCode, string> = {
  not_a_backup: 'el fichero no es una copia de este sistema',
  unsupported_format: 'la copia tiene un formato que este núcleo no conoce',
  key_missing: 'falta BACKUP_KEY',
  key_invalid: 'BACKUP_KEY no es válida',
  wrong_key: 'la copia se hizo con otra clave',
  corrupted: 'la copia está dañada o incompleta',
  other_instance: 'la copia es de otra instancia',
  schema_newer: 'la copia es de un núcleo más reciente',
  schema_mismatch: 'la copia se hizo con un núcleo con migraciones distintas',
  instance_running: 'la instancia está en marcha',
  count_mismatch: 'los recuentos cargados no coinciden con la copia',
  db_error: 'error de la base de datos al cargarla',
  verify_db_unavailable: 'no se pudo crear la base de datos temporal',
  db_ca_unreadable: 'no se puede leer el certificado de la autoridad (sslrootcert)',
  db_tls_untrusted: 'el certificado del servidor de la base de datos no es de confianza',
  db_tls_unsupported: 'el servidor de la base de datos no acepta TLS',
};

/** `variable`: la URL que usa la orden (`BACKUP_VERIFY_URL` en `db:verify`). */
export function restoreFailureMessage(
  failure: RestoreFailure,
  variable: DatabaseUrlVariable = 'DATABASE_URL',
): string {
  const d = failure.details;
  switch (failure.code) {
    case 'schema_newer':
      return `La copia usa el esquema ${d.schema ?? '?'} (núcleo ${d.coreVersion ?? '?'}) y este núcleo llega a ${d.installedSchema ?? '?'}. Restaura con el núcleo ${d.coreVersion ?? '?'} o posterior.`;
    case 'other_instance':
      return `La copia es de la instancia «${d.sourceInstance ?? '?'}». Para restaurarla aquí, repite con --from-instance ${d.sourceInstance ?? '?'}.`;
    case 'wrong_key':
      return `La copia se hizo con otra clave (id ${d.keyId ?? '?'}). Añade la clave anterior en BACKUP_KEYS_PREVIOUS.`;
    case 'corrupted':
      return 'La copia está dañada o incompleta. No se ha modificado nada.';
    case 'schema_mismatch':
      return 'La copia se hizo con un núcleo con migraciones distintas a las de este. No se ha modificado nada.';
    case 'instance_running':
      return 'La instancia está en marcha. Párala antes de restaurar.';
    case 'not_a_backup':
      return 'El fichero no es una copia de este sistema. No se ha modificado nada.';
    case 'unsupported_format':
      return 'La copia tiene un formato que este núcleo no conoce. Restáurala con un núcleo más reciente.';
    case 'key_missing':
      return backupFailureMessages.key_missing;
    case 'key_invalid':
      return backupFailureMessages.key_invalid;
    case 'count_mismatch':
      return 'Los recuentos cargados no coinciden con la copia. No se ha modificado nada.';
    case 'db_error':
      return 'Error de la base de datos al restaurar. No se ha modificado nada.';
    case 'verify_db_unavailable':
      return 'No se pudo crear la base de datos temporal: BACKUP_VERIFY_URL necesita un servidor accesible y un usuario con CREATEDB.';
    case 'db_ca_unreadable':
    case 'db_tls_untrusted':
    case 'db_tls_unsupported':
      return tlsFailureMessage(failure.code, variable);
  }
}

/** Ejecuta `main` si el módulo es el punto de entrada (`tsx src/cli/x.ts` o `node dist/…`). */
export function runIfMain(
  meta: ImportMeta,
  main: (argv: string[], io: CliIO) => Promise<number>,
): void {
  const entry = process.argv[1];
  if (entry === undefined || meta.url !== pathToFileURL(entry).href) return;
  void main(process.argv.slice(2), processIO()).then((code) => {
    process.exitCode = code;
  });
}
