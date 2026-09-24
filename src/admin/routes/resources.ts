import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createAbsence,
  createResource,
  deleteAbsence,
  deleteResource,
  saveResourceHours,
  updateAbsence,
  updateResource,
} from '../../knowledge/services/resources.js';
import type { AbsenceRecord, KnowledgeState, ResourceRecord } from '../../knowledge/types.js';
import type { FormErrorResponse } from '../form-errors.js';
import { compactRows, parseForm } from '../form-parse.js';
import { formErrorData, readState, renderNotFound, renderPage, submitForm } from '../render.js';
import { closureValues } from './hours.js';

type Params = { id: string };
type AbsenceParams = { id: string; absenceId: string };

const resourceValues = (r: ResourceRecord) => ({
  name: r.name,
  service_ids: r.serviceIds,
  active: r.active ? 'on' : undefined,
});

interface ResourcePageOptions {
  values?: Record<string, unknown>;
  slots?: unknown;
  editingAbsence?: AbsenceRecord;
  absenceForm?: Record<string, unknown>;
  errorsFor?: 'resource' | 'hours' | 'absence';
  error?: FormErrorResponse;
}

/** Recursos con sus servicios, horario y ausencias (FR-010 – FR-013). */
export async function resourceRoutes(app: FastifyInstance): Promise<void> {
  const deps = app.knowledge;

  const renderForm = (
    request: FastifyRequest,
    reply: FastifyReply,
    state: KnowledgeState,
    resource: ResourceRecord | undefined,
    opts: ResourcePageOptions = {},
  ) =>
    renderPage(
      request,
      reply,
      'resources/form',
      {
        state,
        title: resource?.name ?? 'Nuevo recurso',
        resource,
        values:
          opts.values ?? (resource ? resourceValues(resource) : { active: 'on', service_ids: [] }),
        slots: opts.slots ?? resource?.hours ?? [],
        editingAbsence: opts.editingAbsence,
        absenceForm:
          opts.absenceForm ?? (opts.editingAbsence ? closureValues(opts.editingAbsence) : {}),
        errorsFor: opts.errorsFor,
        ...(opts.error ? formErrorData(opts.error) : {}),
      },
      opts.error?.status ?? 200,
    );

  /** Vuelve a pintar el formulario del recurso tras un error, o 404 si ya no existe. */
  const renderExisting = async (
    request: FastifyRequest,
    reply: FastifyReply,
    id: string,
    opts: ResourcePageOptions,
  ) => {
    const state = await readState(deps.db);
    const resource = state.resources.find((r) => r.id === id);
    if (!resource) return renderNotFound(request, reply);
    return renderForm(request, reply, state, resource, opts);
  };

  app.get('/resources', async (request, reply) =>
    renderPage(request, reply, 'resources/list', {
      state: await readState(deps.db),
      title: 'Recursos',
    }),
  );

  app.get('/resources/new', async (request, reply) =>
    renderForm(request, reply, await readState(deps.db), undefined),
  );

  app.get<{ Params: Params }>('/resources/:id', async (request, reply) =>
    renderExisting(request, reply, request.params.id, {}),
  );

  app.get<{ Params: AbsenceParams }>(
    '/resources/:id/absences/:absenceId',
    async (request, reply) => {
      const state = await readState(deps.db);
      const resource = state.resources.find((r) => r.id === request.params.id);
      const absence = resource?.absences.find((a) => a.id === request.params.absenceId);
      if (!resource || !absence) return renderNotFound(request, reply);
      return renderForm(request, reply, state, resource, { editingAbsence: absence });
    },
  );

  app.post('/resources', async (request, reply) => {
    const form = parseForm(request.body);
    return submitForm(request, reply, {
      run: () => createResource(deps, form),
      redirectTo: (id) => `/admin/resources/${id}`,
      onError: async (error) =>
        renderForm(request, reply, await readState(deps.db), undefined, {
          values: form,
          errorsFor: 'resource',
          error,
        }),
    });
  });

  app.post<{ Params: Params }>('/resources/:id', async (request, reply) => {
    const form = parseForm(request.body);
    const { id } = request.params;
    return submitForm(request, reply, {
      run: () => updateResource(deps, id, form),
      redirectTo: `/admin/resources/${id}`,
      onError: (error) =>
        renderExisting(request, reply, id, { values: form, errorsFor: 'resource', error }),
    });
  });

  app.post<{ Params: Params }>('/resources/:id/hours', async (request, reply) => {
    const slots = compactRows(parseForm(request.body).slots, ['start', 'end']);
    const { id } = request.params;
    return submitForm(request, reply, {
      run: () => saveResourceHours(deps, id, { slots }),
      redirectTo: `/admin/resources/${id}`,
      onError: (error) => renderExisting(request, reply, id, { slots, errorsFor: 'hours', error }),
    });
  });

  app.post<{ Params: Params }>('/resources/:id/absences', async (request, reply) => {
    const form = parseForm(request.body);
    const { id } = request.params;
    return submitForm(request, reply, {
      run: () => createAbsence(deps, id, form),
      redirectTo: `/admin/resources/${id}`,
      onError: (error) =>
        renderExisting(request, reply, id, { absenceForm: form, errorsFor: 'absence', error }),
    });
  });

  app.post<{ Params: AbsenceParams }>(
    '/resources/:id/absences/:absenceId',
    async (request, reply) => {
      const form = parseForm(request.body);
      const { id, absenceId } = request.params;
      return submitForm(request, reply, {
        run: () => updateAbsence(deps, id, absenceId, form),
        redirectTo: `/admin/resources/${id}`,
        onError: async (error) => {
          const state = await readState(deps.db);
          const resource = state.resources.find((r) => r.id === id);
          if (!resource) return renderNotFound(request, reply);
          return renderForm(request, reply, state, resource, {
            editingAbsence: resource.absences.find((a) => a.id === absenceId),
            absenceForm: form,
            errorsFor: 'absence',
            error,
          });
        },
      });
    },
  );

  app.post<{ Params: AbsenceParams }>(
    '/resources/:id/absences/:absenceId/delete',
    async (request, reply) => {
      const { id, absenceId } = request.params;
      return submitForm(request, reply, {
        run: () => deleteAbsence(deps, id, absenceId),
        redirectTo: `/admin/resources/${id}`,
        message: 'Ausencia eliminada',
        onError: (error) => renderExisting(request, reply, id, { errorsFor: 'absence', error }),
      });
    },
  );

  app.post<{ Params: Params }>('/resources/:id/delete', async (request, reply) =>
    submitForm(request, reply, {
      run: () => deleteResource(deps, request.params.id),
      redirectTo: '/admin/resources',
      message: 'Recurso eliminado',
      onError: async (error) =>
        renderPage(
          request,
          reply,
          'resources/list',
          { state: await readState(deps.db), title: 'Recursos', ...formErrorData(error) },
          error.status,
        ),
    }),
  );
}
