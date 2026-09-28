import type { FastifyInstance } from 'fastify';
import { effectiveHandoff } from '../../knowledge/handoff.js';
import { saveHandoff } from '../../knowledge/services/settings.js';
import type { KnowledgeState } from '../../knowledge/types.js';
import { compactRows, parseForm } from '../form-parse.js';
import { effectiveHandoffNotice, handoffChangeMessage } from '../handoff-notice.js';
import { formErrorData, readState, renderPage, submitForm } from '../render.js';

const handoffValues = (state: KnowledgeState) => ({
  channels: state.handoff?.channels.map((c) => ({ type: c.type, value: c.value })) ?? [],
  slots: state.handoff?.hours ?? [],
});

/** Recuadro "Contacto que usa el bot" (003, FR-005), calculado en cada petición. */
const handoffNotice = (state: KnowledgeState) => effectiveHandoffNotice(effectiveHandoff(state));

/** Contacto de derivación (FR-018, FR-019), protegido por FR-032 con el negocio activo. */
export async function handoffRoutes(app: FastifyInstance): Promise<void> {
  const deps = app.knowledge;
  const title = 'Contacto de derivación';

  app.get('/handoff', async (request, reply) => {
    const state = await readState(deps.db);
    return renderPage(request, reply, 'handoff', {
      state,
      title,
      values: handoffValues(state),
      handoffNotice: handoffNotice(state),
    });
  });

  app.post('/handoff', async (request, reply) => {
    const form = parseForm(request.body);
    const values = {
      channels: compactRows(form.channels, ['value']),
      slots: compactRows(form.slots, ['start', 'end']),
    };
    return submitForm(request, reply, {
      run: () => saveHandoff(deps, values),
      redirectTo: '/admin/handoff',
      message: (change) => handoffChangeMessage(change, 'handoff'),
      onError: async (error) => {
        const state = await readState(deps.db);
        // 409 (FR-032): no se ha guardado nada; se muestran los medios guardados, sin marcas
        // de quitar (003, FR-003). 422: se conservan los valores y las marcas del operador.
        const shown = error.status === 409 ? handoffValues(state) : values;
        return renderPage(
          request,
          reply,
          'handoff',
          {
            state,
            title,
            values: shown,
            handoffNotice: handoffNotice(state),
            ...formErrorData(error),
          },
          error.status,
        );
      },
    });
  });
}
