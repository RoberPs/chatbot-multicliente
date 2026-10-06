import type { Tx } from '../../db/client.js';
import { handoffChannel, handoffContact, handoffHours } from '../../db/schema.js';
import { touch, touchBusiness } from '../../db/timestamps.js';
import type { HandoffChannelType, WeeklySlot } from '../types.js';

/**
 * Guarda el contacto de derivación completo. Sin medios, el contacto deja de existir
 * (FR-018) y se usará el teléfono del negocio (FR-019).
 */
export async function saveHandoff(
  tx: Tx,
  channels: Array<{ type: HandoffChannelType; value: string }>,
  slots: WeeklySlot[],
): Promise<void> {
  await tx.delete(handoffChannel);
  await tx.delete(handoffHours);

  if (channels.length === 0) {
    await tx.delete(handoffContact);
    await touchBusiness(tx);
    return;
  }

  await tx
    .insert(handoffContact)
    .values({ id: 1, ...touch() })
    .onConflictDoUpdate({ target: handoffContact.id, set: touch() });
  await tx
    .insert(handoffChannel)
    .values(
      channels.map((c, sortOrder) => ({ type: c.type, value: c.value, sortOrder, ...touch() })),
    );
  if (slots.length > 0) {
    await tx
      .insert(handoffHours)
      .values(
        slots.map((s) => ({ weekday: s.weekday, startTime: s.start, endTime: s.end, ...touch() })),
      );
  }
}
