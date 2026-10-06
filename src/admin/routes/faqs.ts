import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createFaq, deleteFaq, reorderFaqs, updateFaq } from '../../knowledge/services/faqs.js';
import type { FormErrorResponse } from '../form-errors.js';
import { parseForm } from '../form-parse.js';
import { formErrorData, readState, renderPage, submitForm } from '../render.js';

type Params = { id: string };

/** Preguntas frecuentes (FR-014). Cada pregunta se edita en su propio formulario de la lista. */
export async function faqRoutes(app: FastifyInstance): Promise<void> {
  const deps = app.knowledge;

  const renderFaqs = async (
    request: FastifyRequest,
    reply: FastifyReply,
    opts: { errorsFor?: string; values?: Record<string, unknown>; error?: FormErrorResponse } = {},
  ) =>
    renderPage(
      request,
      reply,
      'faqs',
      {
        state: await readState(deps),
        title: 'Preguntas frecuentes',
        errorsFor: opts.errorsFor,
        values: opts.values ?? {},
        ...(opts.error ? formErrorData(opts.error) : {}),
      },
      opts.error?.status ?? 200,
    );

  app.get('/faqs', async (request, reply) => renderFaqs(request, reply));

  app.post('/faqs', async (request, reply) => {
    const form = parseForm(request.body);
    return submitForm(request, reply, {
      run: () => createFaq(deps, form),
      redirectTo: '/admin/faqs',
      onError: (error) => renderFaqs(request, reply, { errorsFor: 'new', values: form, error }),
    });
  });

  app.post('/faqs/reorder', async (request, reply) =>
    submitForm(request, reply, {
      run: () => reorderFaqs(deps, parseForm(request.body)),
      redirectTo: '/admin/faqs',
      message: 'Orden guardado',
      onError: (error) => renderFaqs(request, reply, { error }),
    }),
  );

  app.post<{ Params: Params }>('/faqs/:id', async (request, reply) => {
    const form = parseForm(request.body);
    return submitForm(request, reply, {
      run: () => updateFaq(deps, request.params.id, form),
      redirectTo: '/admin/faqs',
      onError: (error) =>
        renderFaqs(request, reply, { errorsFor: request.params.id, values: form, error }),
    });
  });

  app.post<{ Params: Params }>('/faqs/:id/delete', async (request, reply) =>
    submitForm(request, reply, {
      run: () => deleteFaq(deps, request.params.id),
      redirectTo: '/admin/faqs',
      message: 'Pregunta eliminada',
      onError: (error) => renderFaqs(request, reply, { error }),
    }),
  );
}
