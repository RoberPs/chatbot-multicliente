/**
 * Destinos de los avisos de derivación (005, R16): fila única `handoff_alerts`, editable en el
 * panel y leída sin caché en cada uso. Nunca entra en el `KnowledgeSnapshot`.
 */
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../conversation/repositories/customer.js';
import { handoffAlerts } from '../db/schema.js';
import { touch } from '../db/timestamps.js';
import type { KnowledgeDeps } from '../knowledge/services/deps.js';
import { runGuardedWrite } from '../knowledge/services/guarded-write.js';
import type { AlertRouteAvailability } from '../knowledge/types.js';
import { handoffAlertsSchema } from './schemas.js';

export interface HandoffAlerts {
  /** WhatsApp del negocio para los avisos, en E.164. */
  whatsapp: string | null;
  /** Email del negocio para los avisos, en minúsculas. */
  email: string | null;
}

export async function readHandoffAlerts(tx: DbOrTx): Promise<HandoffAlerts> {
  const [row] = await tx
    .select({ whatsapp: handoffAlerts.whatsappPhone, email: handoffAlerts.email })
    .from(handoffAlerts)
    .where(eq(handoffAlerts.id, 1));
  return row ?? { whatsapp: null, email: null };
}

/**
 * Guarda los destinos con la escritura protegida de la 001 (aplicar → avisos → revertir si
 * crítico; aquí nunca hay críticos). Es la fila singleton: siempre `UPDATE`.
 */
export async function saveHandoffAlerts(
  deps: KnowledgeDeps,
  input: unknown,
): Promise<HandoffAlerts> {
  const data = handoffAlertsSchema(deps.phoneRegion).parse(input);
  await runGuardedWrite(deps.db, (tx) =>
    tx
      .update(handoffAlerts)
      .set({ whatsappPhone: data.whatsapp, email: data.email, ...touch() })
      .where(eq(handoffAlerts.id, 1)),
  );
  return data;
}

/** Vías que se pueden usar: destino configurado y la instancia puede enviar por ella. */
export function availability(
  alerts: HandoffAlerts,
  instance: AlertRouteAvailability,
): AlertRouteAvailability {
  return {
    whatsapp: alerts.whatsapp !== null && instance.whatsapp,
    email: alerts.email !== null && instance.email,
  };
}
