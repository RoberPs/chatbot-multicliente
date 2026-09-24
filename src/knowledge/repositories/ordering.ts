import { eq, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Tx } from '../../db/client.js';
import { touch } from '../../db/timestamps.js';

type SortableTable = PgTable & { id: PgColumn; sortOrder: PgColumn };

/** Siguiente `sort_order` (al final de la lista). */
export async function nextSortOrder(tx: Tx, table: SortableTable): Promise<number> {
  const [row] = await tx
    .select({ next: sql<number>`coalesce(max(${table.sortOrder}), -1) + 1` })
    .from(table);
  return row?.next ?? 0;
}

/**
 * Aplica el orden recibido. Devuelve `false` si algún id no existe (no cambia nada entonces,
 * porque la transacción se revierte al lanzar el error el caso de uso).
 */
export async function applyOrder(tx: Tx, table: SortableTable, ids: string[]): Promise<boolean> {
  for (const [index, id] of ids.entries()) {
    const rows = await tx
      .update(table)
      .set({ sortOrder: index, ...touch() })
      .where(eq(table.id, id))
      .returning({ id: table.id });
    if (rows.length === 0) return false;
  }
  return true;
}
