/**
 * Página "Derivaciones" del panel (005, contracts/admin-and-web.md): destinos de los avisos al
 * negocio (FR-020) con el estado de cada vía. No es la página "Contacto de derivación"
 * (`/admin/handoff`, 001), que sigue siendo el contacto que da el bot.
 */
import type { FastifyInstance } from 'fastify';
import { readHandoffAlerts, saveHandoffAlerts, type HandoffAlerts } from '../../handoff/settings.js';
import { parseForm } from '../form-parse.js';
import { formErrorData, readState, renderPage, submitForm } from '../render.js';

const TITLE = 'Derivaciones';

export interface RouteStatus {
  label: string;
  /** `ok`: disponible; `none`: sin configurar; `blocked`: configurada pero la instancia no puede. */
  state: 'ok' | 'none' | 'blocked';
  text: string;
}

const BLOCKED = 'Configurado, pero esta instancia no puede enviar por esta vía';

export async function handoffsRoutes(app: FastifyInstance): Promise<void> {
  const deps = app.knowledge;
  const env = app.env;

  /** Estado de cada vía: destino guardado y lo que la instancia puede enviar (R16). */
  function routeStatus(alerts: HandoffAlerts): RouteStatus[] {
    const emailMissing = [
      env.smtp ? null : 'SMTP_URL y SMTP_FROM',
      env.PUBLIC_BASE_URL === undefined ? 'PUBLIC_BASE_URL' : null,
    ].filter((v): v is string => v !== null);
    const status = (
      label: string,
      configured: boolean,
      missing: string[],
    ): RouteStatus => {
      if (!configured) return { label, state: 'none', text: 'Sin configurar' };
      if (missing.length > 0) {
        return { label, state: 'blocked', text: `${BLOCKED} (falta ${missing.join(' y ')}).` };
      }
      return { label, state: 'ok', text: 'Disponible' };
    };
    return [
      status(
        'WhatsApp',
        alerts.whatsapp !== null,
        env.whatsapp ? [] : ['el canal de WhatsApp (variables WHATSAPP_*)'],
      ),
      status('Email', alerts.email !== null, emailMissing),
    ];
  }

  async function pageData(values?: Record<string, unknown>) {
    const state = await readState(deps);
    const alerts = await readHandoffAlerts(deps.db);
    return {
      state,
      title: TITLE,
      routes: routeStatus(alerts),
      values: values ?? { whatsapp: alerts.whatsapp ?? '', email: alerts.email ?? '' },
    };
  }

  app.get('/handoffs', async (request, reply) =>
    renderPage(request, reply, 'handoffs', await pageData()),
  );

  app.post('/handoffs/alerts', async (request, reply) => {
    const form = parseForm(request.body);
    const input = { whatsapp: form.whatsapp ?? '', email: form.email ?? '' };
    return submitForm(request, reply, {
      run: () => saveHandoffAlerts(deps, input),
      redirectTo: '/admin/handoffs',
      onError: async (error) =>
        renderPage(
          request,
          reply,
          'handoffs',
          { ...(await pageData(input)), ...formErrorData(error) },
          error.status,
        ),
    });
  });
}
