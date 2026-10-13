/**
 * Página "Chat web" del panel (004 US2 y US4, contracts/admin-web-channel.md).
 *
 * El operador activa el chat, dice en qué webs se muestra, da el enlace a su política de
 * privacidad y fija los topes; además ve el uso del día y del mes y el fragmento que tiene que
 * pegar en su web. No es información del negocio: no entra en el snapshot ni en los avisos.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readWebChatSettings, saveWebChatSettings } from '../../webchat/settings.js';
import { MAX_ALLOWED_ORIGINS } from '../../webchat/schemas.js';
import { capReached, readWebUsage } from '../../webchat/usage.js';
import { parseForm } from '../form-parse.js';
import { formErrorData, readState, renderPage, submitForm } from '../render.js';

const TITLE = 'Chat web';
// 017 (FR-008): el panel no nombra la variable de credencial, porque eso delataría al proveedor.
const NO_BOT =
  'Falta la clave del modelo de lenguaje en la configuración de la instancia: ' +
  'el chat no puede responder.';

/**
 * Origen con el que se escribe el fragmento: `PUBLIC_BASE_URL` si la instancia la tiene, y si
 * no, el de la petición (que es el que el operador está usando ahora mismo).
 */
export function snippetBase(request: FastifyRequest): string {
  return request.server.env.PUBLIC_BASE_URL ?? `${request.protocol}://${request.host}`;
}

/** Miles separados por espacio, como en el resto del panel ("3 000"). */
const miles = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

export async function webChatPageRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.knowledge;

  /** Datos de la página: configuración, uso y fragmento, todo leído sin caché. */
  async function pageData(request: FastifyRequest) {
    const state = await readState(app.knowledge);
    const settings = await readWebChatSettings(db);
    const now = app.bot?.clock.now() ?? new Date();
    const usage = await readWebUsage(db, now, state.business.timezone);
    return {
      state,
      title: TITLE,
      settings,
      botPresent: app.bot !== null,
      maxOrigins: MAX_ALLOWED_ORIGINS,
      usage: {
        today: miles(usage.today),
        month: miles(usage.month),
        dailyCap: miles(settings.dailyCap),
        monthlyCap: miles(settings.monthlyCap),
      },
      capReached: capReached(usage, settings),
      snippet: `<script src="${snippetBase(request)}/chat/widget.js" defer></script>`,
      values: {
        enabled: settings.enabled,
        allowed_origins: settings.allowedOrigins.join('\n'),
        privacy_url: settings.privacyUrl ?? '',
        daily_cap: settings.dailyCap,
        monthly_cap: settings.monthlyCap,
      },
      ...(app.bot === null ? { general: NO_BOT } : {}),
    };
  }

  app.get('/web-chat', async (request, reply) =>
    renderPage(request, reply, 'web-chat', await pageData(request)),
  );

  app.post('/web-chat', async (request, reply) => {
    const form = parseForm(request.body);
    const before = await readWebChatSettings(db);
    return submitForm(request, reply, {
      run: () => saveWebChatSettings(db, form),
      redirectTo: '/admin/web-chat',
      message:
        // El aviso dice qué ha cambiado, que es lo que el operador quiere confirmar.
        form.enabled === undefined
          ? before.enabled
            ? 'Chat web desactivado'
            : 'Chat web guardado'
          : before.enabled
            ? 'Chat web guardado'
            : 'Chat web activado',
      onError: async (error) =>
        renderPage(
          request,
          reply,
          'web-chat',
          {
            ...(await pageData(request)),
            // Se vuelve a pintar lo que el operador escribió, no lo guardado.
            values: {
              enabled: form.enabled !== undefined,
              allowed_origins: form.allowed_origins,
              privacy_url: form.privacy_url,
              daily_cap: form.daily_cap,
              monthly_cap: form.monthly_cap,
            },
            ...formErrorData(error),
          },
          error.status,
        ),
    });
  });
}
