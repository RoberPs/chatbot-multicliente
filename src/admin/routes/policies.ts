import type { FastifyInstance } from 'fastify';
import { splitMinutes } from '../../knowledge/schemas/policies.js';
import { savePolicies } from '../../knowledge/services/settings.js';
import type { KnowledgeState } from '../../knowledge/types.js';
import { parseForm } from '../form-parse.js';
import { formErrorData, readState, renderPage, submitForm } from '../render.js';

function policiesValues(state: KnowledgeState) {
  const p = state.policies;
  const notice = splitMinutes(p?.cancellationNoticeMinutes ?? null);
  const min = splitMinutes(p?.minAdvanceMinutes ?? null);
  const max = splitMinutes(p?.maxAdvanceMinutes ?? null);
  return {
    cancellation_text: p?.cancellationText ?? '',
    cancellation_notice: notice.value,
    cancellation_notice_unit: notice.unit,
    min_advance: min.value,
    min_advance_unit: min.unit,
    max_advance: max.value,
    max_advance_unit: max.unit,
    payment_methods: p?.paymentMethods ?? [],
  };
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** Políticas: cancelación, antelaciones y formas de pago (FR-015, FR-016). */
export async function policiesRoutes(app: FastifyInstance): Promise<void> {
  const deps = app.knowledge;
  const title = 'Políticas';

  app.get('/policies', async (request, reply) => {
    const state = await readState(deps);
    return renderPage(request, reply, 'policies', { state, title, values: policiesValues(state) });
  });

  app.post('/policies', async (request, reply) => {
    const form = parseForm(request.body);
    return submitForm(request, reply, {
      run: () => savePolicies(deps, form),
      redirectTo: '/admin/policies',
      onError: async (error) =>
        renderPage(
          request,
          reply,
          'policies',
          {
            state: await readState(deps),
            title,
            values: { ...form, payment_methods: asList(form.payment_methods) },
            ...formErrorData(error),
          },
          error.status,
        ),
    });
  });
}
