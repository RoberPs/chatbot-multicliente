/**
 * Respuestas de WhatsApp que llamaron al modelo, por día local del negocio (012, research R5).
 * Se suman en la transacción del saliente, haya o no registro de consumo (FR-005): así el tope
 * diario cuenta aunque el medidor falle o el proveedor no informe tokens.
 */
import { eq, lt, sql } from 'drizzle-orm';
import type { DbOrTx } from '../conversation/repositories/customer.js';
import { whatsappUsageDay } from '../db/schema.js';

/** Respuestas con modelo del día local `day`; 0 si no hay fila. */
export async function readWhatsappReplies(tx: DbOrTx, day: string): Promise<number> {
  const [row] = await tx
    .select({ replies: whatsappUsageDay.replies })
    .from(whatsappUsageDay)
    .where(eq(whatsappUsageDay.day, day));
  return row?.replies ?? 0;
}

/** Hay algún día con respuestas de WhatsApp (la sección del panel se muestra sin WhatsApp). */
export async function hasWhatsappUsage(tx: DbOrTx): Promise<boolean> {
  const [row] = await tx.select({ day: whatsappUsageDay.day }).from(whatsappUsageDay).limit(1);
  return row !== undefined;
}

/** Suma una respuesta al día local `day` (`AAAA-MM-DD`). */
export async function incrementWhatsappReplies(tx: DbOrTx, day: string): Promise<void> {
  await tx
    .insert(whatsappUsageDay)
    .values({ day, replies: 1 })
    .onConflictDoUpdate({
      target: whatsappUsageDay.day,
      set: { replies: sql`${whatsappUsageDay.replies} + 1` },
    });
}

/** Borra los días de hace más de 400 días (en la pasada de `web_usage_day`). Devuelve cuántos. */
export async function purgeWhatsappUsage(tx: DbOrTx, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await tx
    .delete(whatsappUsageDay)
    .where(lt(whatsappUsageDay.day, cutoff))
    .returning({ day: whatsappUsageDay.day });
  return rows.length;
}
