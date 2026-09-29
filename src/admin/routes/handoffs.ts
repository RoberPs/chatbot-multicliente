/**
 * Página "Derivaciones" del panel (005, contracts/admin-and-web.md): destinos de los avisos al
 * negocio (FR-020) con el estado de cada vía y las derivaciones activas, que el operador puede
 * terminar (FR-016a). No es la página "Contacto de derivación" (`/admin/handoff`, 001), que
 * sigue siendo el contacto que da el bot.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { displayPhone } from '../../conversation/templates.js';
import { describeChannel, describeKind } from '../../handoff/notices.js';
import * as handoffs from '../../handoff/repositories/handoff.js';
import {
  readHandoffAlerts,
  saveHandoffAlerts,
  type HandoffAlerts,
} from '../../handoff/settings.js';
import { isHtmx } from '../auth/plugin.js';
import { parseForm } from '../form-parse.js';
import {
  formErrorData,
  readState,
  renderNotFound,
  renderPage,
  savedResponse,
  submitForm,
} from '../render.js';

const TITLE = 'Derivaciones';

export interface RouteStatus {
  label: string;
  /** `ok`: disponible; `none`: sin configurar; `blocked`: configurada pero la instancia no puede. */
  state: 'ok' | 'none' | 'blocked';
  text: string;
}

const BLOCKED = 'Configurado, pero esta instancia no puede enviar por esta vía';

/** Fila de "Derivaciones activas": sin el motivo ni textos de mensajes (FR-016a). */
export interface ActiveRow {
  id: string;
  customer: string;
  channel: string;
  kind: string;
  startedAt: string;
  confirmed: string;
  reminder: string;
}

const localTime = (at: Date, timezone: string) =>
  new Intl.DateTimeFormat('es-ES', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);

const uuid = z.uuid();

export async function handoffsRoutes(app: FastifyInstance): Promise<void> {
  const deps = app.knowledge;
  const env = app.env;

  /** Estado de cada vía: destino guardado y lo que la instancia puede enviar (R16). */
  function routeStatus(alerts: HandoffAlerts): RouteStatus[] {
    const emailMissing = [
      env.smtp ? null : 'SMTP_URL y SMTP_FROM',
      env.PUBLIC_BASE_URL === undefined ? 'PUBLIC_BASE_URL' : null,
    ].filter((v): v is string => v !== null);
    const status = (label: string, configured: boolean, missing: string[]): RouteStatus => {
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

  async function activeRows(timezone: string): Promise<ActiveRow[]> {
    const rows = await handoffs.listActive(deps.db);
    return rows.map((r) => ({
      id: r.id,
      customer: `${r.customerName ?? '—'} (${r.customerPhone ? displayPhone(r.customerPhone) : '—'})`,
      channel: describeChannel(r.channel),
      kind: describeKind(r.kind),
      startedAt: localTime(r.startedAt, timezone),
      confirmed: r.confirmedAt ? `Sí, ${localTime(r.confirmedAt, timezone)}` : 'No',
      reminder: r.reminderSentAt ? 'Sí' : 'No',
    }));
  }

  async function pageData(values?: Record<string, unknown>) {
    const state = await readState(deps);
    const alerts = await readHandoffAlerts(deps.db);
    return {
      state,
      title: TITLE,
      routes: routeStatus(alerts),
      active: await activeRows(state.business.timezone),
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

  /**
   * Terminar una derivación desde el panel (FR-016a): sin mensaje al cliente; el siguiente
   * mensaje lo contesta el bot. Con htmx, la fila desaparece.
   */
  app.post<{ Params: { id: string } }>('/handoffs/:id/end', async (request, reply) => {
    const { id } = request.params;
    if (!uuid.safeParse(id).success) return renderNotFound(request, reply);
    const outcome = await endHandoff(id);
    if (outcome.result === 'not_found') return renderNotFound(request, reply);
    const message =
      outcome.result === 'done'
        ? `Derivación terminada; el asistente vuelve a atender a ${outcome.name}.`
        : 'Esa derivación ya había terminado.';
    if (isHtmx(request)) {
      request.session.set('flash', message);
      return emptyRow(reply);
    }
    return savedResponse(request, reply, '/admin/handoffs', message);
  });

  const emptyRow = (reply: FastifyReply) =>
    reply.code(200).type('text/html; charset=utf-8').send('');

  /** Con bot, el servicio (registra el fin); sin él, directamente en la BD. */
  async function endHandoff(
    id: string,
  ): Promise<{ result: 'done' | 'already_ended' | 'not_found'; name: string }> {
    const service = app.bot?.handoff;
    if (service) {
      const outcome = await service.endByOperator(id, 'operator');
      return { result: outcome.result, name: outcome.customer?.name ?? '—' };
    }
    const row = await handoffs.findById(deps.db, id);
    if (!row) return { result: 'not_found', name: '—' };
    const changed = await handoffs.end(deps.db, id, 'operator', new Date());
    return { result: changed ? 'done' : 'already_ended', name: row.customerName ?? '—' };
  }
}
