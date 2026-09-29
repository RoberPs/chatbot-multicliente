/**
 * `pnpm db:verify <fichero> [--json]` (006, US5): restaura la copia en una BD temporal, compara
 * los recuentos y la borra. No toca la instancia. Salida: 0 restaurable, 1 no restaurable, 2
 * configuración o argumentos no válidos.
 */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { backupConfigFromEnv } from '../backup/config.js';
import { verifyBackup } from '../backup/service.js';
import {
  businessTimezone,
  formatLocal,
  formatTables,
  loadCliEnv,
  parseArgs,
  printJson,
  processIO,
  resolveBackupPath,
  restoreFailureReasons,
  runIfMain,
  type CliIO,
} from './backup-common.js';

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

  const report = await verifyBackup({ file: path, config, logger: io.logger });
  if (json) {
    printJson(io, report);
    return report.restorable ? 0 : 1;
  }
  io.out(`Comprobación: ${report.file}`);
  if (!report.restorable) {
    const code = report.failure ?? 'db_error';
    io.out(`  NO RESTAURABLE: ${restoreFailureReasons[code]} (${code}).`);
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
  io.out('  Base de datos temporal eliminada.');
  return 0;
}

runIfMain(import.meta, main);
