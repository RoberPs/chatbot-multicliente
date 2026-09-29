/**
 * Enlaces «Le atiendo» y «Terminado» del email al negocio (005, R8, contracts/business-alerts.md
 * § Enlaces). El `GET` solo enseña una página con un botón y nunca cambia nada (los antivirus y
 * las vistas previas del correo abren los enlaces); el cambio lo hace el `POST` del botón. Sin
 * sesión ni cookies: el token de la derivación es la única credencial.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { displayPhone } from '../../conversation/templates.js';
import type { ActCustomer } from '../../handoff/business-replies.js';
import { describeKind, describeSince } from '../../handoff/notices.js';
import type { HandoffService } from '../../handoff/service.js';
import type { HandoffButtonAction } from '../../handoff/tokens.js';

const viewsDir = fileURLToPath(new URL('./views', import.meta.url));
const css = readFileSync(`${viewsDir}/handoff.css`, 'utf8');

/** 30 peticiones cada 15 min por IP, en memoria; la IP no se registra (R8). */
const RATE_LIMIT = { max: 30, timeWindow: '15 minutes' };

const CSP = "default-src 'none'; style-src 'self'; form-action 'self'";
const INVALID = 'Este enlace no es válido.';

const LABELS: Record<HandoffButtonAction, string> = { attend: 'Le atiendo', end: 'Terminado' };

export interface HandoffLinksOptions {
  handoff: HandoffService;
  now: () => Date;
  production: boolean;
}

/** Texto de "derivación terminada" de la página: con el teléfono por si aún no se contactó. */
const endedText = (c: ActCustomer) =>
  'Esta derivación ya ha terminado y la conversación ha vuelto al asistente. Si aún no has ' +
  `contactado con ${c.name}, su teléfono es ${displayPhone(c.phone)}.`;

export async function handoffLinkRoutes(
  app: FastifyInstance,
  opts: HandoffLinksOptions,
): Promise<void> {
  const eta = new Eta({ views: viewsDir, cache: opts.production });
  const { handoff } = opts;

  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    reply.header('Content-Security-Policy', CSP);
  });

  const page = async (
    reply: FastifyReply,
    status: number,
    message: string,
    form?: { action: string; label: string },
  ) =>
    reply
      .code(status)
      .type('text/html; charset=utf-8')
      .send(await eta.renderAsync('page', { message, form: form ?? null }));

  const isAction = (value: string): value is HandoffButtonAction =>
    value === 'attend' || value === 'end';

  app.get('/assets/handoff.css', async (_request, reply) =>
    reply.type('text/css; charset=utf-8').send(css),
  );

  app.get<{ Params: { token: string; action: string } }>(
    '/:token/:action',
    { config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const { token, action } = request.params;
      const found = isAction(action) ? await handoff.lookup(token) : null;
      if (!found || !isAction(action)) return page(reply, 404, INVALID);
      const { customer } = found;
      if (found.status === 'ended') return page(reply, 200, endedText(customer));
      const self = `/handoff/${token}`;
      if (action === 'attend' && found.confirmed) {
        return page(reply, 200, `Ya está anotado que atiendes a ${customer.name}.`, {
          action: `${self}/end`,
          label: LABELS.end,
        });
      }
      const since = describeSince(found.startedAt, opts.now(), found.timezone);
      return page(
        reply,
        200,
        `${customer.name} (${displayPhone(customer.phone)}) · ${describeKind(found.kind)} · desde ${since}`,
        { action: `${self}/${action}`, label: LABELS[action] },
      );
    },
  );

  app.post<{ Params: { token: string; action: string } }>(
    '/:token/:action',
    { config: { rateLimit: RATE_LIMIT } },
    async (request, reply) => {
      const { token, action } = request.params;
      if (!isAction(action)) return page(reply, 404, INVALID);
      const { result, customer } = await handoff.act(token, action, 'email');
      if (result === 'invalid' || customer === null) return page(reply, 404, INVALID);
      if (result === 'already_ended') return page(reply, 200, endedText(customer));
      if (result === 'already_confirmed') {
        return page(reply, 200, `Ya estaba anotado que atiendes a ${customer.name}.`);
      }
      return page(
        reply,
        200,
        action === 'attend'
          ? `Anotado: atiendes a ${customer.name}.`
          : `Anotado: derivación terminada. El asistente vuelve a atender a ${customer.name}.`,
      );
    },
  );
}
