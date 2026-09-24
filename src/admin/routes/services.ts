import type { FastifyInstance } from 'fastify';
import { centsToInput } from '../../knowledge/money.js';
import {
  createService,
  deleteService,
  reorderServices,
  updateService,
} from '../../knowledge/services/catalog.js';
import type { ServiceRecord } from '../../knowledge/types.js';
import { parseForm } from '../form-parse.js';
import { formErrorData, readState, renderNotFound, renderPage, submitForm } from '../render.js';

type Params = { id: string };

const serviceValues = (s: ServiceRecord) => ({
  name: s.name,
  description: s.description ?? '',
  price_type: s.priceType,
  price: centsToInput(s.priceCents),
  duration: s.durationMinutes === null ? '' : String(s.durationMinutes),
  bookable: s.bookable ? 'on' : undefined,
  active: s.active ? 'on' : undefined,
});

const NEW_SERVICE = { price_type: 'fixed', active: 'on' };

/** Servicios (FR-007 – FR-009, FR-011b). */
export async function serviceRoutes(app: FastifyInstance): Promise<void> {
  const deps = app.knowledge;

  app.get('/services', async (request, reply) =>
    renderPage(request, reply, 'services/list', {
      state: await readState(deps.db),
      title: 'Servicios',
    }),
  );

  app.get('/services/new', async (request, reply) =>
    renderPage(request, reply, 'services/form', {
      state: await readState(deps.db),
      title: 'Nuevo servicio',
      values: NEW_SERVICE,
    }),
  );

  app.get<{ Params: Params }>('/services/:id', async (request, reply) => {
    const state = await readState(deps.db);
    const service = state.services.find((s) => s.id === request.params.id);
    if (!service) return renderNotFound(request, reply);
    return renderPage(request, reply, 'services/form', {
      state,
      title: service.name,
      service,
      values: serviceValues(service),
    });
  });

  app.post('/services', async (request, reply) => {
    const form = parseForm(request.body);
    return submitForm(request, reply, {
      run: () => createService(deps, form),
      redirectTo: '/admin/services',
      onError: async (error) =>
        renderPage(
          request,
          reply,
          'services/form',
          {
            state: await readState(deps.db),
            title: 'Nuevo servicio',
            values: form,
            ...formErrorData(error),
          },
          error.status,
        ),
    });
  });

  app.post('/services/reorder', async (request, reply) =>
    submitForm(request, reply, {
      run: () => reorderServices(deps, parseForm(request.body)),
      redirectTo: '/admin/services',
      message: 'Orden guardado',
      onError: async (error) =>
        renderPage(
          request,
          reply,
          'services/list',
          { state: await readState(deps.db), title: 'Servicios', ...formErrorData(error) },
          error.status,
        ),
    }),
  );

  app.post<{ Params: Params }>('/services/:id', async (request, reply) => {
    const form = parseForm(request.body);
    return submitForm(request, reply, {
      run: () => updateService(deps, request.params.id, form),
      redirectTo: '/admin/services',
      onError: async (error) => {
        const state = await readState(deps.db);
        const service = state.services.find((s) => s.id === request.params.id);
        return renderPage(
          request,
          reply,
          'services/form',
          {
            state,
            title: service?.name ?? 'Servicio',
            service,
            values: form,
            ...formErrorData(error),
          },
          error.status,
        );
      },
    });
  });

  app.post<{ Params: Params }>('/services/:id/delete', async (request, reply) =>
    submitForm(request, reply, {
      run: () => deleteService(deps, request.params.id),
      redirectTo: '/admin/services',
      message: 'Servicio eliminado',
      onError: async (error) =>
        renderPage(
          request,
          reply,
          'services/list',
          { state: await readState(deps.db), title: 'Servicios', ...formErrorData(error) },
          error.status,
        ),
    }),
  );
}
