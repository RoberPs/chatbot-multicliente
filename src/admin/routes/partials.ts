import type { FastifyInstance } from 'fastify';
import { viewHelpers } from '../render.js';

/** Fragmentos que htmx pide para añadir filas a los formularios sin recargar la página. */
export async function partialRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { weekday?: string } }>('/partials/slot-row', async (request, reply) => {
    const weekday = Number(request.query.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      return reply.code(400).send('Día no válido');
    }
    const html = await reply.viewAsync('partials/slot-row', {
      prefix: 'slots',
      index: viewHelpers.newIndex(),
      weekday,
      start: '',
      end: '',
      errors: {},
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/partials/channel-row', async (_request, reply) => {
    const html = await reply.viewAsync('partials/channel-row', {
      index: viewHelpers.newIndex(),
      type: 'phone',
      value: '',
      errors: {},
    });
    return reply.type('text/html; charset=utf-8').send(html);
  });
}
