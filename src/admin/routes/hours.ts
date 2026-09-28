import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createClosure,
  deleteClosure,
  saveBusinessHours,
  updateClosure,
} from '../../knowledge/services/business-info.js';
import type { ClosureRecord, KnowledgeState } from '../../knowledge/types.js';
import type { FormErrorResponse } from '../form-errors.js';
import { compactRows, parseForm } from '../form-parse.js';
import { formErrorData, readState, renderNotFound, renderPage, submitForm } from '../render.js';

type Params = { id: string };

export const closureValues = (
  c: Pick<ClosureRecord, 'startDate' | 'endDate' | 'startTime' | 'endTime' | 'reason'>,
) => ({
  start_date: c.startDate,
  end_date: c.endDate,
  start_time: c.startTime ?? '',
  end_time: c.endTime ?? '',
  reason: c.reason ?? '',
});

interface HoursPageOptions {
  slots?: unknown;
  editing?: ClosureRecord;
  closureForm?: Record<string, unknown>;
  errorsFor?: 'hours' | 'closure';
  error?: FormErrorResponse;
}

/** Horario semanal y cierres puntuales (FR-003 – FR-006). */
export async function hoursRoutes(app: FastifyInstance): Promise<void> {
  const deps = app.knowledge;

  const renderHours = async (
    request: FastifyRequest,
    reply: FastifyReply,
    state: KnowledgeState,
    opts: HoursPageOptions = {},
  ) =>
    renderPage(
      request,
      reply,
      'hours',
      {
        state,
        title: 'Horario y cierres',
        slots: opts.slots ?? state.businessHours,
        editing: opts.editing,
        closureForm: opts.closureForm ?? (opts.editing ? closureValues(opts.editing) : {}),
        errorsFor: opts.errorsFor,
        ...(opts.error ? formErrorData(opts.error) : {}),
      },
      opts.error?.status ?? 200,
    );

  app.get('/hours', async (request, reply) =>
    renderHours(request, reply, await readState(deps)),
  );

  app.get<{ Params: Params }>('/closures/:id', async (request, reply) => {
    const state = await readState(deps);
    const editing = state.closures.find((c) => c.id === request.params.id);
    if (!editing) return renderNotFound(request, reply);
    return renderHours(request, reply, state, { editing });
  });

  app.post('/hours', async (request, reply) => {
    const slots = compactRows(parseForm(request.body).slots, ['start', 'end']);
    return submitForm(request, reply, {
      run: () => saveBusinessHours(deps, { slots }),
      redirectTo: '/admin/hours',
      onError: async (error) =>
        renderHours(request, reply, await readState(deps), { slots, errorsFor: 'hours', error }),
    });
  });

  app.post('/closures', async (request, reply) => {
    const form = parseForm(request.body);
    return submitForm(request, reply, {
      run: () => createClosure(deps, form),
      redirectTo: '/admin/hours',
      onError: async (error) =>
        renderHours(request, reply, await readState(deps), {
          closureForm: form,
          errorsFor: 'closure',
          error,
        }),
    });
  });

  app.post<{ Params: Params }>('/closures/:id', async (request, reply) => {
    const form = parseForm(request.body);
    return submitForm(request, reply, {
      run: () => updateClosure(deps, request.params.id, form),
      redirectTo: '/admin/hours',
      onError: async (error) => {
        const state = await readState(deps);
        const editing = state.closures.find((c) => c.id === request.params.id);
        return renderHours(request, reply, state, {
          editing,
          closureForm: form,
          errorsFor: 'closure',
          error,
        });
      },
    });
  });

  app.post<{ Params: Params }>('/closures/:id/delete', async (request, reply) =>
    submitForm(request, reply, {
      run: () => deleteClosure(deps, request.params.id),
      redirectTo: '/admin/hours',
      message: 'Cierre eliminado',
      onError: async (error) =>
        renderHours(request, reply, await readState(deps), { errorsFor: 'closure', error }),
    }),
  );
}
