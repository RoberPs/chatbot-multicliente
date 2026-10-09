/**
 * Respuesta al cliente final cuando la base de datos no está (016, FR-002, research R5).
 *
 * Por qué hace falta: la 012 ya tiene escrito qué responder cuando la base de datos no da
 * servicio, pero **toda** esa maquinaria necesita la base de datos para funcionar —guarda el
 * entrante, lee el snapshot, apunta el saliente—, así que durante un corte no llega a
 * ejecutarse. El chat web se salva porque su error acaba en un 503 con contacto que la propia
 * petición del cliente recoge; WhatsApp no, porque allí la respuesta es un mensaje saliente que
 * alguien tiene que enviar.
 *
 * Este envoltorio es ese alguien: cuando la recepción falla por indisponibilidad, envía la
 * disculpa con el teléfono de emergencia **sin tocar la base de datos** y vuelve a lanzar el
 * error, para que el webhook siga respondiendo 503 y Meta reintente la entrega.
 *
 * Es dominio: decide qué se le dice al cliente y con qué contacto, no sabe de HTTP y vale para
 * cualquier canal. Quien lo conecta es `src/app.ts`.
 *
 * El contacto es siempre el de emergencia, por construcción: el del negocio se lee de la base de
 * datos en cada respuesta y sin caché, así que mientras la base no está no hay ninguno que
 * ofrecer (FR-002).
 */
import type { ActivityLog } from './activity-log.js';
import type { Channel } from './channels.js';
import type { Intake, IntakeOutcome } from './intake.js';
import type { ChannelSender } from './ports.js';
import { emergencyContact, errorReply } from './templates.js';
import type { InboundEvent } from './types.js';
import { isDbUnavailable } from '../db/client.js';
import type { OutageWatcher } from '../db/outage.js';

export interface DegradedReplyDeps {
  /** Vigilante del corte: registra el corte y recuerda a quién se ha avisado ya. */
  watcher: Pick<OutageWatcher, 'note' | 'markNotified'>;
  activityLog: ActivityLog;
  /** Contacto de la instancia; sin él no hay nada que ofrecer (FR-022 de la 012). */
  emergencyContactPhone: string | null;
  /**
   * Remitente de cada canal que necesita un mensaje saliente. El chat web y el playground no
   * están: sus respuestas las recoge la propia petición del cliente.
   */
  senders: Partial<Record<Channel, ChannelSender>>;
}

/**
 * El aviso: la disculpa fija de la 012 con el contacto de emergencia. Sin nombre del negocio ni
 * forma de trato, porque no se pueden leer; en `tu`, como `unreadableSnapshotReply`.
 */
function degradedText(phone: string): string {
  return `${errorReply('tu')}\n\n${emergencyContact(phone)}`;
}

/**
 * Envuelve la recepción de cualquier canal. Ante un fallo de indisponibilidad avisa al vigilante,
 * manda la disculpa una sola vez por cliente y corte, y **vuelve a lanzar**.
 */
export function withDegradedReply(intake: Intake, deps: DegradedReplyDeps): Intake {
  return {
    async handle(events: InboundEvent[]): Promise<IntakeOutcome[]> {
      try {
        return await intake.handle(events);
      } catch (error) {
        if (!isDbUnavailable(error)) throw error;
        deps.watcher.note(error);
        // Un lote puede traer varios mensajes del mismo cliente: la memoria de avisos del
        // vigilante se encarga de que solo salga uno.
        for (const event of events) await notify(event, deps);
        throw error;
      }
    },
  };
}

/**
 * El orden de las comprobaciones importa, y es lo que mantiene acotado el registro (FR-014).
 *
 * Durante un corte largo, la plataforma reintenta la entrega del mismo mensaje muchas veces. Si
 * cada reintento pudiera escribir una anotación, el volumen del registro crecería con el número
 * de peticiones, que es exactamente lo que FR-014 prohíbe y lo que SC-008 comprueba. Así que:
 *
 * 1. sin remitente, nada que hacer y **nada que registrar**: es una decisión de diseño del canal
 *    —el chat web y el playground no tienen remitente porque sus respuestas las recoge la propia
 *    petición del cliente—, no un suceso;
 * 2. **se reserva el aviso antes de cualquier otra cosa**, así que todo lo que venga después
 *    ocurre como mucho una vez por cliente y corte, salga bien o mal;
 * 3. solo entonces se mira si hay contacto y se intenta enviar.
 *
 * El resultado es que el registro queda acotado por el número de clientes distintos del corte,
 * nunca por el de peticiones ni por su duración.
 */
async function notify(event: InboundEvent, deps: DegradedReplyDeps): Promise<void> {
  const { channel, channelUserId } = event;
  const skip = (reason: 'no_contact' | 'send_failed') => {
    deps.activityLog.log({ event: 'db_degraded_reply_skipped', channel, reason });
  };

  const sender = deps.senders[channel];
  if (!sender) return;
  // Reserva el aviso: `false` si este cliente ya lo recibió en este corte (FR-002).
  if (!deps.watcher.markNotified(`${channel}:${channelUserId}`)) return;
  if (deps.emergencyContactPhone === null) {
    skip('no_contact');
    return;
  }

  try {
    await sender.sendText(channelUserId, degradedText(deps.emergencyContactPhone));
    deps.activityLog.log({ event: 'db_degraded_reply_sent', channel }, { channel, customerKey: channelUserId });
  } catch {
    // El envío es lo último que se intenta: si falla, no hay nada más que hacer y el error
    // original sigue su camino. Sin el mensaje del fallo, que puede llevar datos del canal.
    skip('send_failed');
  }
}
