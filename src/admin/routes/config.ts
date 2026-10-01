/**
 * Página "Exportar e importar" del panel (008, contracts/admin-config-transfer.md).
 *
 * Solo compone la sesión, la subida del fichero, el almacén de pendientes, los casos de uso de
 * `src/config-transfer` y las vistas. Todas las rutas cuelgan del contexto del operador
 * (`requireOperator` + `csrfOnPost`). `@fastify/multipart` se registra solo en el contexto de
 * la subida: el resto del panel sigue aceptando únicamente formularios urlencoded (R5).
 */
import multipart from '@fastify/multipart';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { preImportFileName } from '../../config-transfer/canonical.js';
import {
  ConfigChangedError,
  WebChatWouldBreakError,
  type ImportRejectReason,
} from '../../config-transfer/errors.js';
import type { ImportIssue } from '../../config-transfer/format.js';
import {
  changesOf,
  configExported,
  configImportApplied,
  configImportCancelled,
  configImportPreviewed,
  configImportRejected,
  countsOf,
} from '../../config-transfer/log.js';
import { parseConfigFile } from '../../config-transfer/parse.js';
import { PendingImports, type PendingImport } from '../../config-transfer/pending.js';
import {
  applyImport,
  exportConfig,
  previewImport,
  readPreImport,
  type ImportPreview,
  type ImportResult,
} from '../../config-transfer/service.js';
import { CriticalWarningError } from '../../knowledge/errors.js';
import { checkbox } from '../../knowledge/schemas/common.js';
import { parseForm } from '../form-parse.js';
import { readState, renderNotFound, renderPage, savedResponse, viewHelpers } from '../render.js';

const TITLE = 'Exportar e importar';
const PREVIEW_TITLE = 'Vista previa de la importación';

/** Tamaño máximo del fichero que se sube (FR-010). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SIZE_LABEL = '5 MB';

const TOO_LARGE_MESSAGE = `El fichero supera el tamaño máximo de ${MAX_SIZE_LABEL}`;
const NO_FILE_MESSAGE = 'Elige un fichero exportado desde el panel';
const CHANGED_MESSAGE =
  'La configuración ha cambiado desde la vista previa; revisa los cambios y vuelve a confirmar';
const CRITICAL_MESSAGE =
  'No se ha aplicado nada: el negocio está activo y se quedaría con avisos críticos (sin salida a una persona).';
const WEB_CHAT_MESSAGE =
  'No se ha aplicado nada: el chat web está activado y se quedaría sin webs permitidas o sin enlace a la política de privacidad. Desactiva antes el chat web o corrige el fichero.';
const CANCELLED_MESSAGE = 'Importación cancelada; no se ha cambiado nada';

type Pending = PendingImport<ImportResult>;

/**
 * Error sin causa para un fallo inesperado: el de PostgreSQL puede llevar valores de la
 * configuración en su detalle, y el manejador común lo registraría (FR-024).
 */
const opaque = (message: string): Error => new Error(message);

export async function configRoutes(app: FastifyInstance): Promise<void> {
  const deps = app.knowledge;
  const instanceId = (): string | null => app.env.INSTANCE_ID ?? null;
  const epochOf = (request: FastifyRequest): string => request.session.get('epoch') ?? '';

  // Un único almacén por instancia (R10); lo que caduca sin aplicarse se registra como cancelado.
  const pending = new PendingImports<ImportResult>({
    onExpire: (entry) => { configImportCancelled(app.log, { reason: 'expired', sourceInstance: entry.sourceInstance }); },
  });

  /** Página con los tres bloques; con los errores de una subida rechazada si los hay. */
  async function renderIndex(
    request: FastifyRequest,
    reply: FastifyReply,
    extra: { issues?: ImportIssue[]; uploadError?: string } = {},
    status = 200,
  ): Promise<FastifyReply> {
    const state = await readState(deps);
    const copy = await readPreImport(deps.db);
    return renderPage(
      request,
      reply,
      'config/index',
      {
        state,
        title: TITLE,
        maxSizeLabel: MAX_SIZE_LABEL,
        preImport: copy && {
          importedAt: viewHelpers.dateTime(copy.importedAt.toISOString(), state.business.timezone),
          sourceInstance: copy.sourceInstance,
        },
        ...extra,
      },
      status,
    );
  }

  /** Pendiente caducado, de otra sesión o inexistente (404). */
  async function renderExpired(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
    const state = await readState(deps);
    return renderPage(request, reply, 'config/expired', { state, title: PREVIEW_TITLE }, 404);
  }

  const importOptions = (includeAlerts: boolean) => ({
    includeAlerts,
    instanceId: instanceId(),
    alertRoutes: deps.alertRoutes,
  });

  async function renderPreview(
    request: FastifyRequest,
    reply: FastifyReply,
    entry: Pending,
    preview: ImportPreview,
    extra: { general?: string } = {},
    status = 200,
  ): Promise<FastifyReply> {
    const state = await readState(deps);
    const { envelope, document } = entry;
    return renderPage(
      request,
      reply,
      'config/preview',
      {
        state,
        title: PREVIEW_TITLE,
        id: entry.id,
        preview,
        meta: {
          exportedAt: viewHelpers.dateTime(envelope.exportedAt, state.business.timezone),
          instanceId: envelope.source.instanceId,
          schema: envelope.source.schema,
          formatVersion: envelope.formatVersion,
        },
        fileAlerts: document.alertDestinations ?? null,
        ...extra,
      },
      status,
    );
  }

  const rejected = (
    request: FastifyRequest,
    stage: 'upload' | 'confirm',
    reason: ImportRejectReason,
    extra: { issues?: number; sourceInstance?: string | null } = {},
  ) => { configImportRejected(request.log, { stage, reason, ...extra }); };

  app.get('/config', async (request, reply) => renderIndex(request, reply));

  app.post('/config/export', async (request, reply) => {
    const includeAlerts = checkbox.parse(parseForm(request.body).include_alerts);
    const result = await exportConfig(deps.db, {
      includeAlerts,
      instanceId: instanceId(),
      now: new Date(),
    });
    configExported(request.log, { includesAlerts: includeAlerts, counts: result.counts });
    return reply
      .code(200)
      .type('application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${result.fileName}"`)
      .send(result.content);
  });

  // Subida del fichero: único contexto con multipart (R5).
  await app.register(async (upload) => {
    await upload.register(multipart, {
      attachFieldsToBody: 'keyValues',
      limits: { files: 1, fileSize: MAX_FILE_BYTES, fields: 2, fieldSize: 1024, parts: 3 },
    });

    upload.setErrorHandler(async (error: FastifyError, request, reply) => {
      if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
        // Se corta en la lectura: el fichero no llega a analizarse.
        rejected(request, 'upload', 'too_large');
        return renderIndex(request, reply, { uploadError: TOO_LARGE_MESSAGE }, 413);
      }
      if (/^FST_(PARTS|FILES|FIELDS)_LIMIT$/.test(error.code)) {
        rejected(request, 'upload', 'no_file');
        return renderIndex(request, reply, { uploadError: NO_FILE_MESSAGE }, 400);
      }
      // El resto (CSRF, 500…) lo trata el manejador común del panel.
      throw error;
    });

    upload.post(
      '/config/import',
      { bodyLimit: MAX_FILE_BYTES + 1024 * 1024 },
      async (request, reply) => {
        const body = request.body as Record<string, unknown> | undefined;
        const file = body?.file;
        if (!Buffer.isBuffer(file) || file.length === 0) {
          rejected(request, 'upload', 'no_file');
          return renderIndex(request, reply, { uploadError: NO_FILE_MESSAGE }, 400);
        }
        const parsed = parseConfigFile(file, { phoneRegion: deps.phoneRegion });
        if (!parsed.ok) {
          rejected(request, 'upload', parsed.reason, {
            ...(parsed.reason === 'invalid' ? { issues: parsed.issues.length } : {}),
            sourceInstance: parsed.sourceInstance,
          });
          return renderIndex(request, reply, { issues: parsed.issues }, 422);
        }
        const entry = pending.add(epochOf(request), {
          document: parsed.document,
          envelope: parsed.envelope,
          sourceInstance: parsed.envelope.source.instanceId,
        });
        return reply.redirect(`/admin/config/import/${entry.id}`, 303);
      },
    );
  });

  app.get<{ Params: { id: string }; Querystring: { alerts?: string } }>(
    '/config/import/:id',
    async (request, reply) => {
      const entry = pending.get(request.params.id, epochOf(request));
      if (!entry) return renderExpired(request, reply);
      if (entry.result) return reply.redirect(`/admin/config/import/${entry.id}/result`, 303);
      const preview = await previewImport(
        deps.db,
        entry,
        importOptions(request.query.alerts === '1'),
      ).catch(() => {
        throw opaque('No se pudo calcular la vista previa de la importación');
      });
      if (pending.markPreviewed(entry.id)) {
        configImportPreviewed(request.log, {
          sourceInstance: entry.sourceInstance,
          formatVersion: entry.envelope.formatVersion,
          sameInstance: preview.highlights.sameInstance,
          counts: countsOf(entry.document),
          changes: changesOf(preview.sections),
          outcome: preview.outcome,
        });
      }
      return renderPreview(request, reply, entry, preview);
    },
  );

  app.post<{ Params: { id: string } }>('/config/import/:id/apply', async (request, reply) => {
    const entry = pending.get(request.params.id, epochOf(request));
    if (!entry || entry.result) return renderExpired(request, reply);
    const form = parseForm(request.body);
    const includeAlerts = form.include_alerts === '1';
    const base = typeof form.base === 'string' ? form.base : '';

    let result: ImportResult;
    try {
      result = await applyImport(deps.db, entry, {
        ...importOptions(includeAlerts),
        baseFingerprint: base,
        now: new Date(),
      });
    } catch (error) {
      const reason: ImportRejectReason | null =
        error instanceof ConfigChangedError
          ? 'changed'
          : error instanceof CriticalWarningError
            ? 'critical'
            : error instanceof WebChatWouldBreakError
              ? 'web_chat'
              : null;
      rejected(request, 'confirm', reason ?? 'failed', { sourceInstance: entry.sourceInstance });
      if (!reason) throw opaque('No se pudo aplicar la importación; no se ha cambiado nada');
      // Nada aplicado: se vuelve a la vista previa, recalculada con la configuración de ahora.
      const preview = await previewImport(deps.db, entry, importOptions(includeAlerts));
      const general =
        reason === 'changed' ? CHANGED_MESSAGE : reason === 'critical' ? CRITICAL_MESSAGE : WEB_CHAT_MESSAGE;
      return renderPreview(request, reply, entry, preview, { general }, 409);
    }

    pending.markApplied(entry.id, result);
    configImportApplied(request.log, {
      sourceInstance: entry.sourceInstance,
      formatVersion: entry.envelope.formatVersion,
      includesAlerts: result.includeAlerts,
      changes: changesOf(result.sections),
      criticalWarnings: result.warnings.filter((w) => w.severity === 'critical').length,
      warnings: result.warnings.length,
    });
    return reply.redirect(`/admin/config/import/${entry.id}/result`, 303);
  });

  app.get<{ Params: { id: string } }>('/config/import/:id/result', async (request, reply) => {
    const result = pending.getResult(request.params.id, epochOf(request));
    if (!result) return renderExpired(request, reply);
    const state = await readState(deps);
    return renderPage(request, reply, 'config/result', {
      state,
      title: 'Importación aplicada',
      result,
      importedAt: viewHelpers.dateTime(result.importedAt.toISOString(), state.business.timezone),
    });
  });

  app.post<{ Params: { id: string } }>('/config/import/:id/cancel', async (request, reply) => {
    const entry = pending.get(request.params.id, epochOf(request));
    if (!entry || entry.result) return renderExpired(request, reply);
    pending.remove(entry.id);
    configImportCancelled(request.log, { reason: 'operator', sourceInstance: entry.sourceInstance });
    return savedResponse(request, reply, '/admin/config', CANCELLED_MESSAGE);
  });

  app.get('/config/pre-import', async (request, reply) => {
    const copy = await readPreImport(deps.db);
    if (!copy) return renderNotFound(request, reply);
    return reply
      .code(200)
      .type('application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${preImportFileName(copy.importedAt)}"`)
      .send(copy.content);
  });
}
