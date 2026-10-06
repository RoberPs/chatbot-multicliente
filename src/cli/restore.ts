/**
 * `pnpm db:restore <fichero> [--from-instance <id>] [--yes] [--json]` (006, US2). Solo con la
 * instancia parada. Sin `--yes` muestra el resumen de la copia y pide escribir el INSTANCE_ID
 * de esta instancia para confirmar. Salida: 0 bien, 1 rechazo o cancelación, 2 configuración o
 * argumentos no válidos.
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { backupConfigFromEnv } from '../backup/config.js';
import { RestoreFailure } from '../backup/errors.js';
import { readHeader } from '../backup/format.js';
import { restoreBackup, type RestoreReport } from '../backup/service.js';
import { assertCaReadable, DatabaseConfigError } from '../config/database-url.js';
import {
  backupFailureMessages,
  businessTimezone,
  formatLocal,
  formatTables,
  loadCliEnv,
  parseArgs,
  printJson,
  processIO,
  resolveBackupPath,
  restoreFailureMessage,
  runIfMain,
  type CliIO,
} from './backup-common.js';

const USAGE = 'Uso: pnpm db:restore <fichero> [--from-instance <id>] [--yes] [--json]';

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** Lo que pasará al arrancar la instancia restaurada (R9, R11). */
function afterStart(report: RestoreReport): string[] {
  const parts: string[] = [];
  if (report.pendingMigrations.length > 0) {
    parts.push(
      `se ${report.pendingMigrations.length === 1 ? 'aplicará' : 'aplicarán'} ${plural(report.pendingMigrations.length, 'migración pendiente', 'migraciones pendientes')} (${report.pendingMigrations.join(', ')}), con copia previa`,
    );
  }
  if (report.expiredConversations > 0) {
    parts.push(
      `se ${report.expiredConversations === 1 ? 'borrará' : 'borrarán'} ${plural(report.expiredConversations, 'conversación que ya supera', 'conversaciones que ya superan')} los 30 días sin mensajes`,
    );
  }
  if (parts.length === 0)
    return ['  Al arrancar: sin migraciones pendientes ni conversaciones caducadas.'];
  if (parts.length === 1) return [`  Al arrancar: ${parts[0] ?? ''}.`];
  return [`  Al arrancar: ${parts[0] ?? ''},`, `  y ${parts[1] ?? ''}.`];
}

export async function main(argv: string[], io: CliIO = processIO()): Promise<number> {
  const args = parseArgs(argv, {
    flags: ['--yes', '--json'],
    options: ['--from-instance'],
    positional: 1,
  });
  if (!args) {
    io.err(USAGE);
    return 2;
  }
  const json = args.flags.has('--json');
  const env = loadCliEnv(io);
  if (!env) return 2;
  const config = backupConfigFromEnv(env);
  if (!config) {
    io.err(backupFailureMessages.key_missing);
    io.err('Configura también INSTANCE_ID y BACKUP_DIR (ver .env.example).');
    return 1;
  }
  const path = resolveBackupPath(args.positional[0] ?? '', config.dir);
  if (!existsSync(path)) {
    io.err(`No se encuentra el fichero ${basename(path)}.`);
    return 2;
  }
  // 013: antes de crear ningún cliente; es un problema de configuración (salida 2).
  try {
    assertCaReadable(env.DATABASE_URL, 'DATABASE_URL');
  } catch (error) {
    if (!(error instanceof DatabaseConfigError)) throw error;
    if (json) printJson(io, { ok: false, failure: 'db_ca_unreadable' });
    io.err(restoreFailureMessage(new RestoreFailure('db_ca_unreadable')));
    return 2;
  }
  const fromInstance = args.options.get('--from-instance');
  const timezone = await businessTimezone(env.DATABASE_URL, env.DEFAULT_TIMEZONE);

  if (!args.flags.has('--yes')) {
    if (!io.interactive) {
      io.err('Sin terminal interactiva hace falta --yes para confirmar la restauración.');
      return 2;
    }
    try {
      const { header } = await readHeader(path);
      io.out(`Restaurar: ${basename(path)}`);
      io.out(
        `  Copia de la instancia ${header.instanceId} · esquema ${header.schema.tag} · núcleo ${header.coreVersion} · ${formatLocal(header.createdAt, timezone)}`,
      );
      io.out(`  ${formatTables(header.tables)}`);
      io.out(
        `  Se sustituirán TODOS los datos de la instancia «${config.instanceId}» por los de la copia.`,
      );
    } catch (error) {
      const failure = error instanceof RestoreFailure ? error : new RestoreFailure('not_a_backup');
      io.err(restoreFailureMessage(failure));
      return 1;
    }
    const answer = await io.ask(
      `Escribe el identificador de esta instancia (${config.instanceId}) para confirmar: `,
    );
    if (answer.trim() !== config.instanceId) {
      io.err('Cancelado: no se ha modificado nada.');
      return 1;
    }
  }

  try {
    const report = await restoreBackup({
      databaseUrl: env.DATABASE_URL,
      file: path,
      config,
      ...(fromInstance === undefined ? {} : { fromInstance }),
      logger: io.logger,
    });
    if (json) {
      printJson(io, { ok: true, ...report });
      return 0;
    }
    io.out(`Restaurada: ${report.file}`);
    io.out(
      `  Copia de la instancia ${report.sourceInstance} · esquema ${report.schema} · núcleo ${report.coreVersion} · ${formatLocal(report.createdAt, timezone)}`,
    );
    io.out(`  ${formatTables(report.tables)}`);
    for (const line of afterStart(report)) io.out(line);
    return 0;
  } catch (error) {
    const failure = error instanceof RestoreFailure ? error : new RestoreFailure('db_error');
    if (json) printJson(io, { ok: false, failure: failure.code, ...failure.details });
    io.err(restoreFailureMessage(failure));
    return 1;
  }
}

runIfMain(import.meta, main);
