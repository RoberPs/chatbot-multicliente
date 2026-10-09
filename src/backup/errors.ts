/**
 * Códigos cerrados de las copias (006, data-model.md, contracts/backup-commands.md). Los errores
 * nunca llevan el mensaje original del sistema ni de PostgreSQL: pueden incluir rutas o valores
 * de filas (FR-024).
 */

export type BackupFailureCode =
  | 'key_missing'
  | 'key_invalid'
  | 'dir_missing'
  | 'dir_not_writable'
  | 'no_space'
  | 'busy'
  | 'db_error'
  | 'io_error'
  // 013 (contracts/database-tls.md): TLS hacia PostgreSQL.
  | DbTlsFailureCode;

/** Fallos de TLS o del certificado de la autoridad, comunes a copias, restauración y verificación. */
export type DbTlsFailureCode = 'db_ca_unreadable' | 'db_tls_untrusted' | 'db_tls_unsupported';

export type RestoreFailureCode =
  | 'not_a_backup'
  | 'unsupported_format'
  | 'key_missing'
  | 'key_invalid'
  | 'wrong_key'
  | 'corrupted'
  | 'other_instance'
  | 'schema_newer'
  | 'schema_mismatch'
  | 'instance_running'
  | 'count_mismatch'
  | 'db_error'
  /**
   * 016 (FR-008): los tres motivos de la comprobación, uno por capa, para que un fallo
   * ocurrido en una nunca se atribuya a otra. Antes `verify_db_unavailable` cubría las tres y
   * el mensaje decía «no se pudo crear la base de datos temporal» incluso cuando la conexión y
   * la creación habían funcionado y lo que fallaba era interpretar la dirección.
   */
  | 'verify_url_invalid'
  /** Estrechado en la 016: **solo** «no se pudo conectar» con el servidor de verificación. */
  | 'verify_db_unavailable'
  | 'verify_db_create_failed'
  | DbTlsFailureCode;

export type MigrationBlockCode = BackupFailureCode | 'backup_not_configured';

/** Fallo al hacer una copia. */
export class BackupError extends Error {
  constructor(readonly code: BackupFailureCode) {
    super(`No se pudo hacer la copia (${code})`);
    this.name = 'BackupError';
  }
}

/** Datos de un rechazo que se pueden mostrar: ninguno es un dato personal ni la clave. */
export interface RestoreFailureDetails {
  /** `keyId` de la cabecera (`wrong_key`). */
  keyId?: string;
  /** Instancia de la copia (`other_instance`). */
  sourceInstance?: string;
  /** Esquema de la copia, `0004_handoff` (`schema_newer`, `schema_mismatch`). */
  schema?: string;
  /** Núcleo que hizo la copia (`schema_newer`). */
  coreVersion?: string;
  /** Último esquema del núcleo que ejecuta (`schema_newer`). */
  installedSchema?: string;
}

/** Rechazo de una restauración o comprobación. La BD queda sin ningún cambio. */
export class RestoreFailure extends Error {
  constructor(
    readonly code: RestoreFailureCode,
    readonly details: RestoreFailureDetails = {},
  ) {
    super(`No se puede restaurar la copia (${code})`);
    this.name = 'RestoreFailure';
  }
}

/** Hay migraciones pendientes con datos y no se pudo hacer la copia previa (FR-015). */
export class MigrationBlockedError extends Error {
  constructor(
    readonly pending: string[],
    readonly failure: MigrationBlockCode,
  ) {
    super(
      `No se aplican las migraciones pendientes (${pending.join(', ')}): no se pudo hacer la copia previa (${failure}). El esquema no ha cambiado.`,
    );
    this.name = 'MigrationBlockedError';
  }
}

/** Una migración falló después de la copia previa (US3-5). */
export class MigrationFailedError extends Error {
  constructor(
    readonly pending: string[],
    readonly premigrationFile: string,
    readonly previousSchema: string,
  ) {
    super(
      `La migración ha fallado. Copia previa: ${premigrationFile}. Restáurala con la versión anterior del núcleo (esquema ${previousSchema}).`,
    );
    this.name = 'MigrationFailedError';
  }
}

/** El bloqueo de instancia en marcha está tomado (R7). */
export class InstanceBusyError extends Error {
  constructor() {
    super('Hay una restauración en curso o la instancia ya está en marcha');
    this.name = 'InstanceBusyError';
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/;
const DB_NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * Traduce un error de sistema o de PostgreSQL a un código de copia, sin conservar el mensaje.
 * Lo que no se reconoce es `fallback`.
 */
export function backupFailureCode(
  error: unknown,
  fallback: BackupFailureCode = 'io_error',
): BackupFailureCode {
  if (error instanceof BackupError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return fallback;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'dir_missing';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'dir_not_writable';
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'no_space';
  if (SQLSTATE.test(code) || DB_NETWORK.has(code)) return 'db_error';
  return fallback;
}
