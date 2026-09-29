/**
 * `pnpm db:backup [--json]`: copia bajo demanda de la instancia (006, US1). Motivo `manual`.
 * Salida: 0 bien, 1 fallo de la copia, 2 configuración o argumentos no válidos.
 */
import { backupConfigFromEnv } from '../backup/config.js';
import { BackupError } from '../backup/errors.js';
import { createBackup } from '../backup/service.js';
import {
  backupFailureMessages,
  businessTimezone,
  formatLocal,
  formatSize,
  formatTables,
  loadCliEnv,
  parseArgs,
  printJson,
  processIO,
  runIfMain,
  type CliIO,
} from './backup-common.js';

export async function main(argv: string[], io: CliIO = processIO()): Promise<number> {
  const args = parseArgs(argv, { flags: ['--json'] });
  if (!args) {
    io.err('Uso: pnpm db:backup [--json]');
    return 2;
  }
  const json = args.flags.has('--json');
  const env = loadCliEnv(io);
  if (!env) return 2;
  const config = backupConfigFromEnv(env);
  if (!config) {
    if (json) printJson(io, { ok: false, failure: 'key_missing' });
    io.err(backupFailureMessages.key_missing);
    io.err('Configura también INSTANCE_ID y BACKUP_DIR (ver .env.example).');
    return 1;
  }
  try {
    const report = await createBackup({
      databaseUrl: env.DATABASE_URL,
      config,
      reason: 'manual',
      logger: io.logger,
    });
    if (json) {
      printJson(io, { ok: true, ...report });
      return 0;
    }
    const timezone = await businessTimezone(env.DATABASE_URL, env.DEFAULT_TIMEZONE);
    io.out(`Copia creada: ${report.file}`);
    io.out(
      `  Tamaño: ${formatSize(report.sizeBytes)} · Esquema: ${report.schema} · Núcleo: ${report.coreVersion} · ${formatLocal(report.createdAt, timezone)}`,
    );
    io.out(`  ${formatTables(report.tables)}`);
    io.out(
      `  Retención (${String(config.retentionDays)} días): ${String(report.retention.deleted)} copias borradas, ${String(report.retention.kept)} conservadas.`,
    );
    return 0;
  } catch (error) {
    const code = error instanceof BackupError ? error.code : 'io_error';
    if (json) printJson(io, { ok: false, failure: code });
    io.err(backupFailureMessages[code]);
    return 1;
  }
}

runIfMain(import.meta, main);
