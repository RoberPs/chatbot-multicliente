/**
 * Casos de uso de exportar e importar la configuración del negocio (008). Sin HTTP: los usa el
 * panel (`src/admin/routes/config.ts`).
 */
import { eq } from 'drizzle-orm';
import { installedSchema } from '../backup/schema-version.js';
import { withReadSnapshot, type Db } from '../db/client.js';
import { configPreImport } from '../db/schema.js';
import { previewWrite, runTrackedWrite } from '../knowledge/services/guarded-write.js';
import type { AlertRouteAvailability, Warning } from '../knowledge/types.js';
import { computeWarnings } from '../knowledge/warnings.js';
import { configFileName, configFingerprint, serializeConfigFile } from './canonical.js';
import { diffConfig, type ConfigHighlights } from './diff.js';
import { ConfigChangedError, WebChatWouldBreakError } from './errors.js';
import {
  CURRENT_FORMAT_VERSION,
  FORMAT_ID,
  type ConfigDocument,
  type ConfigFileEnvelope,
  type ConfigInfo,
  type SectionDiff,
} from './format.js';
import { countsOf, type PreviewOutcome, type SectionCounts } from './log.js';
import { readConfigDocument, readConfigInfo, readConfigWithInfo } from './read.js';
import { replaceConfig } from './replace.js';

export interface ExportOptions {
  includeAlerts: boolean;
  /** `INSTANCE_ID` de la instancia, o `null` si no tiene. */
  instanceId: string | null;
  now: Date;
  /** Etiqueta de la última migración del núcleo; por defecto, la instalada. */
  schemaLabel?: string;
}

export interface ExportResult {
  fileName: string;
  content: string;
  counts: SectionCounts;
}

/**
 * Exporta la configuración actual a un fichero canónico (FR-001 – FR-006). Se permite en
 * cualquier estado del negocio y con avisos críticos (US1-4).
 */
export async function exportConfig(db: Db, opts: ExportOptions): Promise<ExportResult> {
  const { document, info } = await withReadSnapshot(db, async (tx) => ({
    document: await readConfigDocument(tx, { includeAlerts: opts.includeAlerts }),
    info: await readConfigInfo(tx),
  }));
  const content = serializeConfigFile(
    {
      format: FORMAT_ID,
      formatVersion: CURRENT_FORMAT_VERSION,
      exportedAt: opts.now.toISOString(),
      source: { instanceId: opts.instanceId, schema: opts.schemaLabel ?? installedSchema().tag },
      includesAlertDestinations: opts.includeAlerts,
      info,
    },
    document,
  );
  return {
    fileName: configFileName(opts.instanceId, opts.now),
    content,
    counts: countsOf(document),
  };
}

export interface PreImportCopy {
  /** Fichero canónico tal cual se guardó (con destinos de avisos). */
  content: string;
  /** Hora de la importación a la que precede. */
  importedAt: Date;
  /** `INSTANCE_ID` de origen del fichero importado. */
  sourceInstance: string | null;
}

/** Configuración anterior a la última importación aplicada, si la hay (FR-022). */
export async function readPreImport(db: Db): Promise<PreImportCopy | null> {
  const [row] = await db
    .select({
      content: configPreImport.content,
      importedAt: configPreImport.importedAt,
      sourceInstance: configPreImport.sourceInstance,
    })
    .from(configPreImport)
    .where(eq(configPreImport.id, 1));
  return row ?? null;
}

/** Fichero validado que se quiere importar. */
export interface ImportSource {
  document: ConfigDocument;
  envelope: ConfigFileEnvelope;
}

export interface ImportOptions {
  /** El operador eligió importar los destinos de los avisos (FR-013, FR-021). */
  includeAlerts: boolean;
  /** `INSTANCE_ID` de esta instancia, o `null`. */
  instanceId: string | null;
  /** Vías de aviso de la instancia: los avisos salen igual que en el panel (FR-012). */
  alertRoutes?: AlertRouteAvailability;
}

/** Vista previa de una importación (data-model §5). No se guarda. */
export interface ImportPreview {
  sections: SectionDiff[];
  highlights: ConfigHighlights;
  warnings: Warning[];
  outcome: PreviewOutcome;
  /** Qué le falta al chat web activado del destino, si la importación lo dejaría sin él. */
  webChatMissing: 'origins' | 'privacyUrl' | null;
  /** Huella de la configuración actual con la que se calculó (R9). */
  baseFingerprint: string;
  includeAlerts: boolean;
}

/** Qué le faltaría al chat web activado con la configuración del fichero (FR-018). */
function webChatMissing(
  info: ConfigInfo,
  webChat: ConfigDocument['webChat'],
): 'origins' | 'privacyUrl' | null {
  if (!info.webChatEnabled) return null;
  if (webChat.allowedOrigins.length === 0) return 'origins';
  if (webChat.privacyUrl === null) return 'privacyUrl';
  return null;
}

const sameInstanceOf = (source: ImportSource, instanceId: string | null): boolean | null => {
  const origin = source.envelope.source.instanceId;
  return origin === null || instanceId === null ? null : origin === instanceId;
};

const fingerprintOf = (current: { document: ConfigDocument; info: ConfigInfo }): string =>
  configFingerprint({
    document: current.document,
    businessStatus: current.info.businessStatus,
    webChatEnabled: current.info.webChatEnabled,
  });

/** Solo importa los destinos si el fichero los trae y el operador lo eligió (FR-021). */
const importsAlerts = (source: ImportSource, opts: ImportOptions): boolean =>
  opts.includeAlerts && source.document.alertDestinations !== undefined;

/**
 * Vista previa (R6): ejecuta el mismo reemplazo que la confirmación en una transacción que
 * siempre se revierte, y compara la configuración actual con la resultante (FR-011 – FR-014).
 */
export async function previewImport(
  db: Db,
  source: ImportSource,
  opts: ImportOptions,
): Promise<ImportPreview> {
  const includeAlerts = importsAlerts(source, opts);
  const preview = await previewWrite(
    db,
    async (tx) => {
      const current = await readConfigWithInfo(tx);
      await replaceConfig(tx, source.document, { importAlerts: includeAlerts });
      const next = await readConfigWithInfo(tx);
      return { current, next };
    },
    { alertRoutes: opts.alertRoutes },
  );
  const { current, next } = preview.result;
  const diff = diffConfig(current.document, next.document, {
    destinationWebChatEnabled: current.info.webChatEnabled,
    sameInstance: sameInstanceOf(source, opts.instanceId),
    fileIncludesAlerts: source.document.alertDestinations !== undefined,
  });
  const missing = webChatMissing(current.info, source.document.webChat);
  return {
    ...diff,
    warnings: preview.warnings,
    outcome: missing ? 'blocked_web_chat' : preview.blocked ? 'blocked_critical' : 'will_apply',
    webChatMissing: missing,
    baseFingerprint: fingerprintOf(current),
    includeAlerts,
  };
}

export interface ApplyOptions extends ImportOptions {
  /** Huella de la vista previa que confirmó el operador (FR-019). */
  baseFingerprint: string;
  now: Date;
}

/** Resultado de una importación aplicada (FR-020). */
export interface ImportResult {
  sections: SectionDiff[];
  highlights: ConfigHighlights;
  /** Avisos vigentes tras aplicar, como en el panel. */
  warnings: Warning[];
  importedAt: Date;
  includeAlerts: boolean;
}

/**
 * Aplica la importación en una sola transacción de la escritura protegida (R7, FR-015):
 * huella → chat web → configuración anterior → reemplazo → avisos. Cualquier rechazo revierte
 * todo, también la copia de la configuración anterior (FR-022).
 */
export async function applyImport(
  db: Db,
  source: ImportSource,
  opts: ApplyOptions,
): Promise<ImportResult> {
  const includeAlerts = importsAlerts(source, opts);
  const { result, after } = await runTrackedWrite(
    db,
    async (tx) => {
      const current = await readConfigWithInfo(tx);
      if (fingerprintOf(current) !== opts.baseFingerprint) throw new ConfigChangedError();
      const missing = webChatMissing(current.info, source.document.webChat);
      if (missing) throw new WebChatWouldBreakError(missing);

      const content = serializeConfigFile(
        {
          format: FORMAT_ID,
          formatVersion: CURRENT_FORMAT_VERSION,
          exportedAt: opts.now.toISOString(),
          source: { instanceId: opts.instanceId, schema: installedSchema().tag },
          includesAlertDestinations: true,
          info: current.info,
        },
        current.document,
      );
      const copy = {
        content,
        importedAt: opts.now,
        sourceInstance: source.envelope.source.instanceId,
      };
      await tx
        .insert(configPreImport)
        .values({ id: 1, ...copy })
        .onConflictDoUpdate({ target: configPreImport.id, set: copy });

      await replaceConfig(tx, source.document, { importAlerts: includeAlerts });
      const next = await readConfigWithInfo(tx);
      return { current, next };
    },
    { alertRoutes: opts.alertRoutes },
  );
  const diff = diffConfig(result.current.document, result.next.document, {
    destinationWebChatEnabled: result.current.info.webChatEnabled,
    sameInstance: sameInstanceOf(source, opts.instanceId),
    fileIncludesAlerts: source.document.alertDestinations !== undefined,
  });
  return {
    ...diff,
    warnings: computeWarnings(after),
    importedAt: opts.now,
    includeAlerts,
  };
}
