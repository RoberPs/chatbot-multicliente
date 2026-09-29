/**
 * `pnpm db:backups [--prune] [--json]` (006, US4): lista las copias propias de `BACKUP_DIR` y,
 * con `--prune`, aplica la retención. Los ficheros ajenos y los `.partial` no aparecen.
 */
import { backupConfigFromEnv } from '../backup/config.js';
import { applyRetention } from '../backup/retention.js';
import { listBackups } from '../backup/service.js';
import {
  backupFailureMessages,
  businessTimezone,
  formatLocal,
  formatSize,
  loadCliEnv,
  parseArgs,
  printJson,
  processIO,
  runIfMain,
  type CliIO,
} from './backup-common.js';

export async function main(argv: string[], io: CliIO = processIO()): Promise<number> {
  const args = parseArgs(argv, { flags: ['--prune', '--json'] });
  if (!args) {
    io.err('Uso: pnpm db:backups [--prune] [--json]');
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
  try {
    const retention = args.flags.has('--prune')
      ? await applyRetention({ config, logger: io.logger })
      : null;
    const backups = await listBackups({ config });
    if (json) {
      printJson(io, { ok: true, backups, ...(retention ? { retention } : {}) });
      return 0;
    }
    const timezone = await businessTimezone(env.DATABASE_URL, env.DEFAULT_TIMEZONE);
    if (retention) {
      io.out(
        `Retención (${String(config.retentionDays)} días): ${String(retention.deleted)} copias borradas, ${String(retention.kept)} conservadas.`,
      );
    }
    if (backups.length === 0) {
      io.out('No hay copias de esta instancia en el directorio de copias.');
      return 0;
    }
    io.out(`Copias de la instancia ${config.instanceId} (${String(backups.length)}):`);
    for (const b of backups) {
      io.out(
        [
          b.file,
          formatSize(b.sizeBytes),
          formatLocal(b.createdAt, timezone),
          b.reason,
          b.schema,
          b.valid ? 'válida: sí' : 'válida: no',
          `caduca: ${formatLocal(b.expiresAt, timezone)}`,
        ].join(' · '),
      );
    }
    return 0;
  } catch {
    if (json) printJson(io, { ok: false, failure: 'dir_missing' });
    io.err(backupFailureMessages.dir_missing);
    return 1;
  }
}

runIfMain(import.meta, main);
