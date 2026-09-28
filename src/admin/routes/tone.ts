import type { FastifyInstance } from 'fastify';
import { saveTone } from '../../knowledge/services/settings.js';
import { parseForm } from '../form-parse.js';
import { formErrorData, readState, renderPage, submitForm } from '../render.js';

/** Tono del bot: tú o usted y descripción del estilo (FR-017). */
export async function toneRoutes(app: FastifyInstance): Promise<void> {
  const deps = app.knowledge;
  const title = 'Tono';

  app.get('/tone', async (request, reply) => {
    const state = await readState(deps);
    return renderPage(request, reply, 'tone', {
      state,
      title,
      values: {
        address_form: state.tone?.addressForm ?? '',
        style_description: state.tone?.styleDescription ?? '',
      },
    });
  });

  app.post('/tone', async (request, reply) => {
    const form = parseForm(request.body);
    return submitForm(request, reply, {
      run: () => saveTone(deps, form),
      redirectTo: '/admin/tone',
      onError: async (error) =>
        renderPage(
          request,
          reply,
          'tone',
          { state: await readState(deps), title, values: form, ...formErrorData(error) },
          error.status,
        ),
    });
  });
}
