/**
 * Lo que el negocio escribe al número del bot (005, R10, contracts/business-alerts.md): antes
 * de la recepción de clientes, los botones «Le atiendo» y «Terminado» de las plantillas actúan
 * sobre su derivación y reciben un acuse, y lo que escriba el WhatsApp de avisos recibe una
 * ayuda (como mucho cada 15 min). Nada de esto crea clientes, conversaciones ni mensajes.
 */
import type { ActivityLog } from '../../conversation/activity-log.js';
import type { Intake } from '../../conversation/intake.js';
import type { ChannelSender, Clock } from '../../conversation/ports.js';
import type { InboundEvent } from '../../conversation/types.js';
import type { Db } from '../../db/client.js';
import { BUSINESS_HELP, businessReply, INVALID_BUTTON } from '../../handoff/business-replies.js';
import type { HandoffService } from '../../handoff/service.js';
import { readHandoffAlerts } from '../../handoff/settings.js';
import { parseButtonPayload } from '../../handoff/tokens.js';

/** Una ayuda por número como mucho cada 15 min (FR-008b). */
export const HELP_INTERVAL_MS = 15 * 60 * 1000;
/** Ids de mensajes ya tratados: Meta reintenta el webhook y el acuse no se repite. */
const SEEN_MAX = 1000;
const PAYLOAD_PREFIX = 'h1:';

export interface BusinessRouterDeps {
  db: Db;
  handoff: HandoffService;
  /** Envío de texto por WhatsApp (la ventana del negocio está abierta: acaba de escribir). */
  sender: ChannelSender;
  activityLog: ActivityLog;
  clock: Clock;
}

export interface BusinessRouter {
  /** Trata los eventos del negocio y devuelve los que son de clientes. */
  route(events: InboundEvent[]): Promise<InboundEvent[]>;
}

export function createBusinessRouter(deps: BusinessRouterDeps): BusinessRouter {
  const { handoff, sender, activityLog, clock } = deps;
  const lastHelp = new Map<string, number>();
  const seen = new Set<string>();

  const reply = async (to: string, text: string) => {
    try {
      await sender.sendText(to, text);
    } catch {
      // El acuse es una cortesía: si no sale, la acción ya está hecha.
    }
  };

  /** `true` si el mensaje ya se trató (reintento del webhook). */
  const duplicate = (id: string): boolean => {
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > SEEN_MAX) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return false;
  };

  async function button(event: InboundEvent, payload: string): Promise<void> {
    if (duplicate(event.channelMessageId)) return;
    activityLog.log({ event: 'handoff_business_message', kind: 'button', helpSent: false });
    const parsed = parseButtonPayload(payload);
    if (!parsed) {
      activityLog.log({ event: 'handoff_action_ignored', reason: 'invalid', via: 'whatsapp' });
      await reply(event.channelUserId, INVALID_BUTTON);
      return;
    }
    // Se acepta desde cualquier número: el token es lo que identifica la derivación (R9).
    const outcome = await handoff.act(parsed.token, parsed.action, 'whatsapp');
    await reply(
      event.channelUserId,
      businessReply(parsed.action, outcome.result, outcome.customer),
    );
  }

  async function fromAlertsNumber(event: InboundEvent): Promise<void> {
    if (duplicate(event.channelMessageId)) return;
    const now = clock.now().getTime();
    const previous = lastHelp.get(event.channelUserId);
    const helpSent = previous === undefined || now - previous >= HELP_INTERVAL_MS;
    if (helpSent) {
      lastHelp.set(event.channelUserId, now);
      await reply(event.channelUserId, BUSINESS_HELP);
    }
    // Sin seudónimo: el negocio no es un cliente y su número no se registra.
    activityLog.log({
      event: 'handoff_business_message',
      kind: event.kind === 'text' ? 'text' : 'other',
      helpSent,
    });
  }

  return {
    async route(events) {
      const customers: InboundEvent[] = [];
      let alerts: { whatsapp: string | null } | undefined;
      for (const event of events) {
        if (event.channel !== 'whatsapp') {
          customers.push(event);
          continue;
        }
        const payload = event.buttonPayload;
        if (payload?.startsWith(PAYLOAD_PREFIX)) {
          await button(event, payload);
          continue;
        }
        // Destino de avisos leído sin caché (R16), una vez por lote.
        alerts ??= await readHandoffAlerts(deps.db);
        if (alerts.whatsapp !== null && event.channelUserId === alerts.whatsapp) {
          await fromAlertsNumber(event);
          continue;
        }
        customers.push(event);
      }
      return customers;
    },
  };
}

/** Recepción con el enrutador del negocio delante (solo afecta a eventos de WhatsApp). */
export function withBusinessRouter(intake: Intake, router: BusinessRouter): Intake {
  return {
    async handle(events) {
      const customers = await router.route(events);
      return customers.length > 0 ? intake.handle(customers) : [];
    },
  };
}
