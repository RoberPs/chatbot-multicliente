/**
 * Nombre de las copias (006, research R8, data-model.md). El nombre sirve al operador; el código
 * decide siempre por la cabecera. La fecha va en UTC: es una marca técnica, no un horario del
 * negocio.
 */

export const BACKUP_REASONS = ['manual', 'premigration', 'daily'] as const;
export type BackupReason = (typeof BACKUP_REASONS)[number];

export const BACKUP_NAME_PATTERN =
  /^([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)__(\d{4}_[a-z0-9_]+)__(\d{8}T\d{6}Z)__(manual|premigration|daily)\.cbak$/;

const PARTIAL_SUFFIX = '.partial';

export interface BackupNameParts {
  instanceId: string;
  schema: string;
  stamp: string;
  reason: BackupReason;
}

/** `20260929T101500Z` a partir de un instante. */
export function utcStamp(at: Date): string {
  return at
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replaceAll('-', '')
    .replaceAll(':', '');
}

export function backupFileName(input: {
  instanceId: string;
  schema: { tag: string };
  createdAt: Date;
  reason: BackupReason;
}): string {
  const name = `${input.instanceId}__${input.schema.tag}__${utcStamp(input.createdAt)}__${input.reason}.cbak`;
  if (!BACKUP_NAME_PATTERN.test(name)) throw new Error('Nombre de copia no válido');
  return name;
}

export function isBackupName(name: string): boolean {
  return BACKUP_NAME_PATTERN.test(name);
}

export function parseBackupName(name: string): BackupNameParts | null {
  const match = BACKUP_NAME_PATTERN.exec(name);
  if (!match) return null;
  const [, instanceId = '', schema = '', stamp = '', reason = 'manual'] = match;
  return { instanceId, schema, stamp, reason: reason as BackupReason };
}

/** Fichero a medias de una copia: empieza por punto y nunca cumple el patrón (FR-006). */
export function partialName(name: string): string {
  return `.${name}${PARTIAL_SUFFIX}`;
}

export function isOwnPartial(name: string, instanceId: string): boolean {
  return name.startsWith(`.${instanceId}__`) && name.endsWith(`.cbak${PARTIAL_SUFFIX}`);
}
