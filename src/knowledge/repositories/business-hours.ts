import type { Tx } from '../../db/client.js';
import { businessHours } from '../../db/schema.js';
import { touch, touchBusiness } from '../../db/timestamps.js';
import type { WeeklySlot } from '../types.js';

/** Reemplaza toda la semana de forma atómica (dentro de la transacción recibida). */
export async function replaceBusinessHours(tx: Tx, slots: WeeklySlot[]): Promise<void> {
  await tx.delete(businessHours);
  if (slots.length > 0) {
    await tx
      .insert(businessHours)
      .values(
        slots.map((s) => ({ weekday: s.weekday, startTime: s.start, endTime: s.end, ...touch() })),
      );
  } else {
    await touchBusiness(tx);
  }
}
