/**
 * Errores de la importación (008). Sus mensajes nunca llevan textos de la configuración ni del
 * fichero: pueden acabar en un registro técnico (FR-024).
 */
import type { ImportIssue } from './format.js';

/** La configuración del destino cambió entre la vista previa y la confirmación (FR-019). */
export class ConfigChangedError extends Error {
  constructor() {
    super('La configuración ha cambiado desde la vista previa');
    this.name = 'ConfigChangedError';
  }
}

/**
 * El chat web del destino está activado y el fichero lo dejaría sin webs permitidas o sin
 * enlace de privacidad (FR-018): el panel tampoco deja guardar eso.
 */
export class WebChatWouldBreakError extends Error {
  constructor(readonly missing: 'origins' | 'privacyUrl') {
    super('El chat web está activado y se quedaría sin webs permitidas o sin enlace de privacidad');
    this.name = 'WebChatWouldBreakError';
  }
}

/** Motivos de rechazo de una importación (contracts/transfer-log.md). */
export type ImportRejectReason =
  | 'too_large'
  | 'no_file'
  | 'unreadable'
  | 'not_export'
  | 'future_version'
  | 'unsupported_version'
  | 'invalid'
  | 'changed'
  | 'critical'
  | 'web_chat'
  | 'failed';

/** Importación rechazada sin cambiar nada, con los errores del fichero si los hay. */
export class ImportRejected extends Error {
  constructor(
    readonly reason: ImportRejectReason,
    readonly issues?: ImportIssue[],
  ) {
    super(`Importación rechazada (${reason})`);
    this.name = 'ImportRejected';
  }
}
