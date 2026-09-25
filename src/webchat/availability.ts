/**
 * ¿Puede atender ahora el chat web? (004 US2, FR-022, contracts/web-chat-http.md).
 *
 * Una sola respuesta para el frame y para la API: o está disponible (con la configuración y el
 * snapshot ya leídos, sin caché) o no lo está, y entonces trae el mensaje y el contacto que ve
 * el visitante. No sabe nada de HTTP: las cabeceras y la comprobación de origen viven en
 * `src/channels/web`.
 */
import { unavailableContact } from '../conversation/templates.js';
import type { DbOrTx } from '../conversation/repositories/customer.js';
import type { KnowledgeReader, KnowledgeSnapshot } from '../knowledge/types.js';
import { readWebChatSettings, type WebChatSettings } from './settings.js';
import { capReached, readWebUsage } from './usage.js';

/** Por qué no se puede atender; `ip_limit` lo añade la capa HTTP (US4). */
export type UnavailableReason = 'disabled' | 'not_active' | 'quota' | 'no_bot' | 'ip_limit';

export interface Unavailable {
  reason: UnavailableReason;
  message: string;
  /** Texto plano del contacto; `null` si la instancia no tiene ninguno. */
  contact: string | null;
}

export type WebChatAvailability =
  | { available: true; settings: WebChatSettings; snapshot: KnowledgeSnapshot }
  | { available: false; unavailable: Unavailable };

export const UNAVAILABLE_MESSAGE = 'Ahora mismo el chat no está disponible.';

/** Objeto `unavailable` del contrato, con el contacto del negocio o el de emergencia. */
export function unavailable(
  reason: UnavailableReason,
  snapshot: KnowledgeSnapshot | null,
  emergencyPhone: string | null,
): Unavailable {
  return {
    reason,
    message: UNAVAILABLE_MESSAGE,
    contact: unavailableContact(snapshot, emergencyPhone),
  };
}

export interface AvailabilityDeps {
  tx: DbOrTx;
  reader: KnowledgeReader;
  /** Hay bot en la instancia (ANTHROPIC_API_KEY, R11). */
  botPresent: boolean;
  emergencyPhone: string | null;
  now: Date;
}

/** Comprueba en el orden del contrato: bot, snapshot, chat activado, negocio activo y tope. */
export async function webChatAvailability({
  tx,
  reader,
  botPresent,
  emergencyPhone,
  now,
}: AvailabilityDeps): Promise<WebChatAvailability> {
  const no = (reason: UnavailableReason, snapshot: KnowledgeSnapshot | null) => ({
    available: false as const,
    unavailable: unavailable(reason, snapshot, emergencyPhone),
  });
  if (!botPresent) return no('no_bot', null);

  let snapshot: KnowledgeSnapshot;
  try {
    snapshot = await reader.getSnapshot();
  } catch {
    // FR-022: sin información del negocio se atiende con el contacto de emergencia.
    return no('no_bot', null);
  }

  const settings = await readWebChatSettings(tx);
  if (!settings.enabled) return no('disabled', snapshot);
  if (snapshot.status !== 'active') return no('not_active', snapshot);

  const timezone = snapshot.business.timezone;
  if (capReached(await readWebUsage(tx, now, timezone), settings) !== null) {
    return no('quota', snapshot);
  }
  return { available: true, settings, snapshot };
}
