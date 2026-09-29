/**
 * Vía simulada de "Probar el bot" (005, FR-021): los avisos no salen de la instancia. Siempre
 * entrega y devuelve el texto del aviso tal como lo recibiría el negocio (el del email, sin
 * enlaces), que se guarda en `handoff_notice.body` para el operador.
 */
import type { Clock } from '../conversation/ports.js';
import { alertEmail, forwardEmail, type EmailContent } from './notices.js';
import type { AlertRoute } from './ports.js';
import type { BusinessNotice } from './types.js';

function contentFor(notice: BusinessNotice, now: Date): EmailContent | null {
  switch (notice.type) {
    case 'alert':
      return alertEmail(notice, now, null);
    case 'forward':
      return forwardEmail(notice, null);
    default:
      return null;
  }
}

export function createSimulatedRoute(clock: Clock): AlertRoute {
  return {
    name: 'simulated',
    async send(notice) {
      const content = contentFor(notice, clock.now());
      const body = content ? `${content.subject}\n\n${content.text}` : '';
      return { ok: true, ref: null, body };
    },
  };
}
