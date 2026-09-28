import type { FastifyReply, FastifyRequest } from 'fastify';
import { withReadSnapshot } from '../db/client.js';
import type { KnowledgeDeps } from '../knowledge/services/deps.js';
import { formatCents } from '../knowledge/money.js';
import { loadKnowledgeState } from '../knowledge/state.js';
import type { KnowledgeState, Warning, WarningTargetKind } from '../knowledge/types.js';
import { computeWarnings } from '../knowledge/warnings.js';
import { isHtmx } from './auth/plugin.js';
import { splitLinks } from './message-links.js';
import { describeTrace } from './playground-trace.js';
import { formErrorResponse, type FieldErrors, type FormErrorResponse } from './form-errors.js';

export const WEEKDAYS = [
  { n: 1, name: 'Lunes', short: 'lun' },
  { n: 2, name: 'Martes', short: 'mar' },
  { n: 3, name: 'Miércoles', short: 'mié' },
  { n: 4, name: 'Jueves', short: 'jue' },
  { n: 5, name: 'Viernes', short: 'vie' },
  { n: 6, name: 'Sábado', short: 'sáb' },
  { n: 7, name: 'Domingo', short: 'dom' },
] as const;

/** Funciones disponibles en todas las plantillas como `it.h`. */
export const viewHelpers = {
  weekdays: WEEKDAYS,
  weekdayName: (n: number) => WEEKDAYS[n - 1]?.name ?? String(n),
  err: (errors: FieldErrors | undefined, key: string) => errors?.[key] ?? '',
  money: (cents: number | null, currency: string) =>
    cents === null ? 'Sin importe' : formatCents(cents, currency),
  date: (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : ''),
  dateTime: (iso: string | null, timezone: string) =>
    iso
      ? new Intl.DateTimeFormat('es-ES', {
          timeZone: timezone,
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(iso))
      : '',
  str: (v: unknown) =>
    typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '',
  /** Enlace a la pantalla del elemento de un aviso. */
  warningLink: (w: Warning) => targetLink(w.target.kind, w.target.id),
  /** Fila nueva con un índice que no choca con las existentes. */
  newIndex: () => Date.now() * 10 + Math.floor(Math.random() * 10),
  /** Información técnica de una respuesta para "Probar el bot" (004, FR-009). */
  trace: describeTrace,
  /** Trozos de una respuesta del bot, con sus enlaces `https://` (004, FR-020a). */
  links: splitLinks,
};

function targetLink(kind: WarningTargetKind, id?: string): string {
  switch (kind) {
    case 'business':
      return '/admin/hours';
    case 'handoff':
      return '/admin/handoff';
    case 'handoff_alerts':
      return '/admin/handoffs';
    case 'service':
      return id ? `/admin/services/${id}` : '/admin/services';
    case 'resource':
      return id ? `/admin/resources/${id}` : '/admin/resources';
  }
}

/** Estado de la instancia para el panel, con las vías de aviso que puede usar (005). */
export function readState(deps: KnowledgeDeps): Promise<KnowledgeState> {
  return withReadSnapshot(deps.db, (tx) =>
    loadKnowledgeState(tx, { alertRoutes: deps.alertRoutes }),
  );
}

export interface PageData {
  state: KnowledgeState;
  title: string;
  errors?: FieldErrors;
  values?: Record<string, unknown>;
  general?: string;
  blocking?: Warning[];
  [key: string]: unknown;
}

function takeFlash(request: FastifyRequest): string | undefined {
  const flash = request.session.get('flash');
  if (flash !== undefined) request.session.set('flash', undefined);
  return flash;
}

/**
 * Renderiza una página del panel con la cabecera común: estado del negocio y número de avisos
 * calculados en cada petición (nunca guardados).
 */
export async function renderPage(
  request: FastifyRequest,
  reply: FastifyReply,
  view: string,
  data: PageData,
  status = 200,
): Promise<FastifyReply> {
  const warnings = computeWarnings(data.state);
  const html = await reply.viewAsync(view, {
    errors: {},
    values: {},
    ...data,
    warnings,
    h: viewHelpers,
    layout: {
      title: data.title,
      businessName: data.state.business.name,
      status: data.state.business.status,
      warningsCount: warnings.length,
      criticalCount: warnings.filter((w) => w.severity === 'critical').length,
      csrf: reply.generateCsrf(),
      flash: takeFlash(request),
      path: request.url,
    },
  });
  return reply.code(status).type('text/html; charset=utf-8').send(html);
}

/** Respuesta de guardado correcto: 303 con "Guardado", o 200 + HX-Location si es htmx. */
export async function savedResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  redirectTo: string,
  message = 'Guardado',
): Promise<FastifyReply> {
  request.session.set('flash', message);
  if (isHtmx(request)) {
    return reply.code(200).header('HX-Location', redirectTo).send('');
  }
  return reply.redirect(redirectTo, 303);
}

/**
 * Ejecuta un guardado del formulario. Si el dominio rechaza el dato (422), el cambio violaría
 * FR-032 (409) o el elemento no existe (404), llama a `onError` para volver a pintar el
 * formulario con los valores introducidos; cualquier otro error se propaga.
 */
export async function submitForm<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: {
    run: () => Promise<T>;
    redirectTo: string | ((result: T) => string);
    onError: (error: FormErrorResponse) => Promise<FastifyReply>;
    /** Texto del flash; puede depender del resultado del guardado (003, FR-006). */
    message?: string | ((result: T) => string);
  },
): Promise<FastifyReply> {
  let result: T;
  try {
    result = await opts.run();
  } catch (err) {
    const formError = formErrorResponse(err);
    if (!formError) throw err;
    if (formError.status === 404) return renderNotFound(request, reply);
    return opts.onError(formError);
  }
  const target = typeof opts.redirectTo === 'function' ? opts.redirectTo(result) : opts.redirectTo;
  const message = typeof opts.message === 'function' ? opts.message(result) : opts.message;
  return savedResponse(request, reply, target, message);
}

/** Página 404 del panel (elemento inexistente o ruta desconocida). */
export async function renderNotFound(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const state = await readState(request.server.knowledge);
  return renderPage(request, reply, 'not-found', { state, title: 'No encontrado' }, 404);
}

export function formErrorData(error: FormErrorResponse) {
  return { errors: error.errors, general: error.general, blocking: error.warnings };
}
