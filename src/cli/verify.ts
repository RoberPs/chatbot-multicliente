/**
 * `pnpm db:verify <fichero> [--json]` (006, US5): restaura la copia en una BD temporal, compara
 * los recuentos y la borra. No toca la instancia. Antes limpia las bases temporales huérfanas de
 * verificaciones interrumpidas (013, contracts/verify-cleanup.md). Salida: 0 restaurable, 1 no
 * restaurable, 2 configuración o argumentos no válidos.
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { backupConfigFromEnv } from '../backup/config.js';
import { RestoreFailure } from '../backup/errors.js';
import { verifyBackup, type OrphanCleanup } from '../backup/service.js';
import {
  assertCaReadable,
  DatabaseConfigError,
  type DatabaseUrlVariable,
} from '../config/database-url.js';
import {
  businessTimezone,
  formatLocal,
  formatTables,
  loadCliEnv,
  parseArgs,
  printJson,
  processIO,
  resolveBackupPath,
  restoreFailureMessage,
  restoreFailureReasons,
  runIfMain,
  type CliIO,
} from './backup-common.js';

const TLS_FAILURES = new Set(['db_ca_unreadable', 'db_tls_untrusted', 'db_tls_unsupported']);

/** Línea de las huérfanas, solo si hay algo que contar; nunca un nombre de base. */
export function orphansLine(orphans: OrphanCleanup): string | null {
  if (!orphans.listed) {
    return '  Bases temporales huérfanas: no se ha podido comprobar el servidor; puede quedar alguna.';
  }
  const parts: string[] = [];
  if (orphans.removed > 0) {
    parts.push(`${String(orphans.removed)} ${orphans.removed === 1 ? 'borrada' : 'borradas'}`);
  }
  if (orphans.failed > 0) {
    parts.push(
      `${String(orphans.failed)} sin poder borrar (permisos del usuario de BACKUP_VERIFY_URL)`,
    );
  }
  return parts.length === 0 ? null : `  Bases temporales huérfanas: ${parts.join(', ')}.`;
}

export async function main(argv: string[], io: CliIO = processIO()): Promise<number> {
  const args = parseArgs(argv, { flags: ['--json'], positional: 1 });
  if (!args) {
    io.err('Uso: pnpm db:verify <fichero> [--json]');
    return 2;
  }
  const json = args.flags.has('--json');
  const env = loadCliEnv(io);
  if (!env) return 2;
  const config = backupConfigFromEnv(env);
  if (!config) {
    io.err('Falta la configuración de copias: INSTANCE_ID, BACKUP_DIR y BACKUP_KEY.');
    return 2;
  }
  const path = resolveBackupPath(args.positional[0] ?? '', config.dir);
  if (!existsSync(path)) {
    io.err(`No se encuentra el fichero ${basename(path)}.`);
    return 2;
  }
  // Sin BACKUP_VERIFY_URL, la verificación usa el servidor de DATABASE_URL.
  const variable: DatabaseUrlVariable =
    (io.env.BACKUP_VERIFY_URL ?? '').trim() === '' ? 'DATABASE_URL' : 'BACKUP_VERIFY_URL';
  // 013: antes de crear ningún cliente; es un problema de configuración (salida 2).
  try {
    assertCaReadable(config.verifyUrl, variable);
  } catch (error) {
    if (!(error instanceof DatabaseConfigError)) throw error;
    if (json) {
      printJson(io, {
        restorable: false,
        failure: 'db_ca_unreadable',
        orphans: { listed: false, removed: 0, failed: 0 },
      });
    }
    io.err(error.describe());
    return 2;
  }

  const report = await verifyBackup({ file: path, config, logger: io.logger });
  if (json) {
    printJson(io, report);
    return report.restorable ? 0 : 1;
  }
  io.out(`Comprobación: ${report.file}`);
  const orphans = orphansLine(report.orphans);
  if (!report.restorable) {
    const code = report.failure ?? 'db_error';
    io.out(`  NO RESTAURABLE: ${restoreFailureReasons[code]} (${code}).`);
    if (orphans !== null) io.out(orphans);
    if (TLS_FAILURES.has(code)) io.err(restoreFailureMessage(new RestoreFailure(code), variable));
    return 1;
  }
  const timezone = await businessTimezone(env.DATABASE_URL, env.DEFAULT_TIMEZONE);
  const tables = report.tables ?? [];
  io.out(
    `  RESTAURABLE · instancia ${report.sourceInstance ?? '?'} · esquema ${report.schema ?? '?'} · núcleo ${report.coreVersion ?? '?'} · ${formatLocal(report.createdAt ?? new Date().toISOString(), timezone)}`,
  );
  io.out(
    `  ${formatTables(tables)} (${String(tables.length)} tablas; recuentos iguales a la copia)`,
  );
  if (orphans !== null) io.out(orphans);
  io.out('  Base de datos temporal eliminada.');
  return 0;
}

runIfMain(import.meta, main);
