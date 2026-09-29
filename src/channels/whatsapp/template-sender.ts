/**
 * Vía de aviso por WhatsApp (005, R6, contracts/business-alerts.md): traduce un
 * `BusinessNotice` a una plantilla *utility* aprobada con los botones «Le atiendo» y
 * «Terminado». Reutiliza el cliente y los reintentos de la Graph API; no lanza.
 */
import {
  alertTemplateVars,
  forwardTemplateVars,
  sanitizeTemplateVar,
} from '../../handoff/notices.js';
import type { AlertRoute, AlertSendResult } from '../../handoff/ports.js';
import { buttonPayload } from '../../handoff/tokens.js';
import type { BusinessNotice } from '../../handoff/types.js';
import type { GraphClient, GraphPostResult } from './graph-client.js';

/** Plantillas que la instancia tiene que tener aprobadas en su cuenta de Meta. */
export const HANDOFF_TEMPLATES = {
  alert: {
    name: 'derivacion_aviso',
    body:
      'Nueva derivación del asistente: {{1}} ({{2}}), por {{3}}, {{4}}.\n' +
      'Motivo: {{5}}\n' +
      'Contacta con el cliente desde tu teléfono. Pulsa «Le atiendo» cuando lo hagas y ' +
      '«Terminado» cuando acabes; mientras tanto el asistente no le responde.',
  },
  reminder: {
    name: 'derivacion_recordatorio',
    body:
      'Recordatorio: {{1}} ({{2}}) sigue esperando respuesta desde {{3}}.\n' +
      'Motivo: {{4}}\n' +
      'Contacta con el cliente desde tu teléfono. Pulsa «Le atiendo» si ya le estás atendiendo ' +
      'o «Terminado» si ya acabaste.',
  },
  forward: {
    name: 'derivacion_mensaje',
    body:
      'Mensaje nuevo de {{1}} ({{2}}) durante la derivación:\n' +
      '«{{3}}»\n' +
      'Contéstale desde tu teléfono; el asistente no le responde mientras tanto.',
  },
} as const;

/** Botones de respuesta rápida, en este orden (índices 0 y 1). */
export const HANDOFF_BUTTONS = ['Le atiendo', 'Terminado'] as const;

/** Códigos de la Graph API que indican un destinatario no válido. */
const RECIPIENT_ERRORS = new Set([131021, 131026, 131030]);

export interface TemplateSenderOptions {
  graph: Pick<GraphClient, 'postMessage'>;
  /** WHATSAPP_TEMPLATE_LANG (`es` por defecto). */
  language: string;
}

/** Nombre y variables de la plantilla de un aviso; `null` si esta vía aún no lo envía. */
function templateFor(notice: BusinessNotice): { name: string; vars: string[] } | null {
  switch (notice.type) {
    case 'alert':
      return { name: HANDOFF_TEMPLATES.alert.name, vars: alertTemplateVars(notice) };
    case 'forward':
      return { name: HANDOFF_TEMPLATES.forward.name, vars: forwardTemplateVars(notice) };
    default:
      return null;
  }
}

/** Cuerpo JSON del `POST /messages` (contracts/business-alerts.md § Envío). */
export function templatePayload(
  notice: BusinessNotice,
  to: string,
  language: string,
): Record<string, unknown> | null {
  const template = templateFor(notice);
  if (!template) return null;
  const token = notice.handoff.token;
  const button = (index: number, action: 'attend' | 'end') => ({
    type: 'button',
    sub_type: 'quick_reply',
    index: String(index),
    parameters: [{ type: 'payload', payload: buttonPayload(action, token) }],
  });
  return {
    to: to.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: template.name,
      language: { code: language },
      components: [
        {
          type: 'body',
          parameters: template.vars.map((text) => ({
            type: 'text',
            text: sanitizeTemplateVar(text),
          })),
        },
        button(0, 'attend'),
        button(1, 'end'),
      ],
    },
  };
}

/** Código corto del fallo, sin textos del proveedor (contracts/activity-log.md). */
export function failureCode(result: Extract<GraphPostResult, { ok: false }>, timedOut: boolean) {
  if (timedOut) return 'timeout';
  const { status, errorCode } = result;
  if (status === undefined) return 'network';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'http_5xx';
  if (errorCode !== undefined && RECIPIENT_ERRORS.has(errorCode)) return 'recipient_invalid';
  return 'template_rejected';
}

/** Vía WhatsApp hacia el número de avisos `to` (E.164). */
export function createTemplateSender(opts: TemplateSenderOptions, to: string): AlertRoute {
  return {
    name: 'whatsapp',
    async send(notice, { signal }): Promise<AlertSendResult> {
      const payload = templatePayload(notice, to, opts.language);
      if (!payload) return { ok: false, failure: 'unsupported' };
      const result = await opts.graph.postMessage(payload, { signal });
      if (result.ok) return { ok: true, ref: result.id };
      return { ok: false, failure: failureCode(result, signal.aborted) };
    },
  };
}
