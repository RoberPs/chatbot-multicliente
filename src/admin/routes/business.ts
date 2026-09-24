import type { FastifyInstance } from 'fastify';
import { saveBusiness } from '../../knowledge/services/business-info.js';
import type { KnowledgeState } from '../../knowledge/types.js';
import { parseForm } from '../form-parse.js';
import { formErrorData, readState, renderPage, submitForm } from '../render.js';

const businessValues = (state: KnowledgeState) => ({
  name: state.business.name,
  address: state.business.address ?? '',
  directions: state.business.directions ?? '',
  phone: state.business.phone ?? '',
  email: state.business.email ?? '',
  timezone: state.business.timezone,
  currency: state.business.currency,
});

/** Datos del negocio (FR-001, FR-002). */
export async function businessRoutes(app: FastifyInstance): Promise<void> {
  const deps = app.knowledge;
  const title = 'Datos del negocio';

  app.get('/business', async (request, reply) => {
    const state = await readState(deps.db);
    return renderPage(request, reply, 'business', { state, title, values: businessValues(state) });
  });

  app.post('/business', async (request, reply) => {
    const form = parseForm(request.body);
    return submitForm(request, reply, {
      run: () => saveBusiness(deps, form),
      redirectTo: '/admin/business',
      onError: async (error) =>
        renderPage(
          request,
          reply,
          'business',
          { state: await readState(deps.db), title, values: form, ...formErrorData(error) },
          error.status,
        ),
    });
  });
}
