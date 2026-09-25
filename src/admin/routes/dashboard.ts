import type { FastifyInstance } from 'fastify';
import { ActivationBlockedError } from '../../knowledge/errors.js';
import { activateBusiness, deactivateBusiness } from '../../knowledge/services/business-status.js';
import { readWebChatSettings } from '../../webchat/settings.js';
import { readState, renderPage, savedResponse } from '../render.js';

/**
 * Estado del chat web para la portada (004, FR-026a). No es un aviso de `computeWarnings`: no
 * bloquea nada de la base de conocimiento.
 */
async function webChatStatus(db: Parameters<typeof readWebChatSettings>[0]): Promise<string> {
  const settings = await readWebChatSettings(db);
  if (!settings.enabled) return 'desactivado';
  const n = settings.allowedOrigins.length;
  return `activado en ${n} ${n === 1 ? 'web' : 'webs'}`;
}

/** Portada y estado del negocio (FR-029 – FR-031). */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.knowledge;

  const page = async () => ({
    state: await readState(db),
    title: 'Portada',
    webChat: await webChatStatus(db),
  });

  app.get('/', async (request, reply) => renderPage(request, reply, 'dashboard', await page()));

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
          ...(await page()),
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
