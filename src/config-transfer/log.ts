/**
 * Registros de exportación e importación (008, contracts/transfer-log.md, FR-024).
 *
 * Catálogo cerrado: cada evento se construye campo a campo con números, booleanos, códigos del
 * contrato y el `INSTANCE_ID` validado. Ningún campo de texto libre, así que un registro no
 * puede llevar nombres, preguntas, teléfonos, correos, webs ni el contenido del fichero.
 */
import { INSTANCE_ID_PATTERN } from '../config/env.js';
import type { ImportRejectReason } from './errors.js';
import { SECTION_KEYS, type ConfigDocument, type SectionDiff, type SectionKey } from './format.js';

/** Lo que se necesita del logger de la instancia (compatible con el de Fastify). */
export interface ConfigLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export type SectionCounts = Record<SectionKey, number>;
export type SectionChanges = Record<SectionKey, { added: number; modified: number; removed: number }>;
export type PreviewOutcome = 'will_apply' | 'blocked_critical' | 'blocked_web_chat';
export type RejectStage = 'upload' | 'confirm';
export type CancelReason = 'operator' | 'expired';

/** Número de elementos por sección (0/1 en las filas únicas). */
export function countsOf(doc: ConfigDocument): SectionCounts {
  return {
    business: 1,
    openingHours: doc.openingHours.length,
    closures: doc.closures.length,
    services: doc.services.length,
    resources: doc.resources.length,
    faqs: doc.faqs.length,
    policies: doc.policies ? 1 : 0,
    tone: doc.tone ? 1 : 0,
    handoff: doc.handoff ? 1 : 0,
    webChat: 1,
    alertDestinations: doc.alertDestinations ? 1 : 0,
  };
}

/** Añadidos, modificados y eliminados por sección. */
export function changesOf(diff: SectionDiff[]): SectionChanges {
  const out = {} as SectionChanges;
  for (const key of SECTION_KEYS) {
    const section = diff.find((d) => d.section === key);
    out[key] = {
      added: section?.added.length ?? 0,
      modified: section?.modified.length ?? 0,
      removed: section?.removed.length ?? 0,
    };
  }
  return out;
}

/** Solo el identificador de instancia validado; cualquier otro texto se descarta. */
const instance = (value: string | null | undefined): string | null =>
  typeof value === 'string' && INSTANCE_ID_PATTERN.test(value) ? value : null;

const int = (n: number): number => (Number.isFinite(n) ? Math.trunc(n) : 0);

/** Copia numérica de los recuentos: nada que no sea una sección conocida y un número. */
function cleanCounts(counts: SectionCounts): SectionCounts {
  const out = {} as SectionCounts;
  for (const key of SECTION_KEYS) out[key] = int(counts[key]);
  return out;
}

function cleanChanges(changes: SectionChanges): SectionChanges {
  const out = {} as SectionChanges;
  for (const key of SECTION_KEYS) {
    const c = changes[key];
    out[key] = { added: int(c.added), modified: int(c.modified), removed: int(c.removed) };
  }
  return out;
}

export function configExported(
  log: ConfigLogger,
  fields: { includesAlerts: boolean; counts: SectionCounts },
): void {
  log.info(
    {
      channel: 'config',
      event: 'config_exported',
      includesAlerts: fields.includesAlerts,
      counts: cleanCounts(fields.counts),
    },
    'config_exported',
  );
}

export function configImportPreviewed(
  log: ConfigLogger,
  fields: {
    sourceInstance: string | null;
    formatVersion: number;
    sameInstance: boolean | null;
    counts: SectionCounts;
    changes: SectionChanges;
    outcome: PreviewOutcome;
  },
): void {
  log.info(
    {
      channel: 'config',
      event: 'config_import_previewed',
      sourceInstance: instance(fields.sourceInstance),
      formatVersion: int(fields.formatVersion),
      sameInstance: fields.sameInstance,
      counts: cleanCounts(fields.counts),
      changes: cleanChanges(fields.changes),
      outcome: fields.outcome,
    },
    'config_import_previewed',
  );
}

export function configImportApplied(
  log: ConfigLogger,
  fields: {
    sourceInstance: string | null;
    formatVersion: number;
    includesAlerts: boolean;
    changes: SectionChanges;
    criticalWarnings: number;
    warnings: number;
  },
): void {
  log.info(
    {
      channel: 'config',
      event: 'config_import_applied',
      sourceInstance: instance(fields.sourceInstance),
      formatVersion: int(fields.formatVersion),
      includesAlerts: fields.includesAlerts,
      changes: cleanChanges(fields.changes),
      criticalWarnings: int(fields.criticalWarnings),
      warnings: int(fields.warnings),
    },
    'config_import_applied',
  );
}

export function configImportRejected(
  log: ConfigLogger,
  fields: {
    stage: RejectStage;
    reason: ImportRejectReason;
    issues?: number;
    sourceInstance?: string | null;
  },
): void {
  log.warn(
    {
      channel: 'config',
      event: 'config_import_rejected',
      stage: fields.stage,
      reason: fields.reason,
      ...(fields.issues === undefined ? {} : { issues: int(fields.issues) }),
      sourceInstance: instance(fields.sourceInstance),
    },
    'config_import_rejected',
  );
}

export function configImportCancelled(
  log: ConfigLogger,
  fields: { reason: CancelReason; sourceInstance: string | null },
): void {
  log.info(
    {
      channel: 'config',
      event: 'config_import_cancelled',
      reason: fields.reason,
      sourceInstance: instance(fields.sourceInstance),
    },
    'config_import_cancelled',
  );
}
