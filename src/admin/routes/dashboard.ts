import type { FastifyInstance } from 'fastify';
import { ActivationBlockedError } from '../../knowledge/errors.js';
import { activateBusiness, deactivateBusiness } from '../../knowledge/services/business-status.js';
import { readState, renderPage, savedResponse } from '../render.js';

/** Portada y estado del negocio (FR-029 – FR-031). */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.knowledge;

  app.get('/', async (request, reply) =>
    renderPage(request, reply, 'dashboard', { state: await readState(db), title: 'Portada' }),
  );

  app.post('/status/activate', async (request, reply) => {
    try {
      await activateBusiness(db);
    } catch (err) {
      if (!(err instanceof ActivationBlockedError)) throw err;
      return renderPage(
        request,
        reply,
        'dashboard',
        {
          state: await readState(db),
          title: 'Portada',
          general: 'No se puede activar el negocio mientras haya avisos críticos:',
          blocking: err.warnings,
        },
        409,
      );
    }
    return savedResponse(request, reply, '/admin', 'Negocio activado');
  });

  app.post('/status/deactivate', async (request, reply) => {
    await deactivateBusiness(db);
    return savedResponse(request, reply, '/admin', 'Negocio pasado a "En preparación"');
  });
}
