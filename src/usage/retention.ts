/**
 * Retención del consumo (010, FR-006, R14): se conservan el mes local actual y los 12 anteriores.
 * Precios y ajustes no caducan.
 */
import { lt } from 'drizzle-orm';
import type { DbOrTx } from '../conversation/repositories/customer.js';
import { modelUsage } from '../db/schema.js';
import { localDay } from '../knowledge/time/local-date.js';

/** Primer día (`AAAA-MM-01`) del mes local de hace 12 meses: el más antiguo que se conserva. */
export function usageCutoff(now: Date, timezone: string): string {
  const today = localDay(now, timezone);
  const year = Number(today.slice(0, 4)) - 1;
  return `${String(year).padStart(4, '0')}-${today.slice(5, 7)}-01`;
}

/** Borra los registros con `day` anterior al corte; devuelve cuántos. */
export async function purgeModelUsage(tx: DbOrTx, now: Date, timezone: string): Promise<number> {
  const rows = await tx
    .delete(modelUsage)
    .where(lt(modelUsage.day, usageCutoff(now, timezone)))
    .returning({ id: modelUsage.id });
  return rows.length;
}
