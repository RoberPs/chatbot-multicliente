import { asc, eq } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { service } from '../../db/schema.js';
import { touch, touchBusiness } from '../../db/timestamps.js';
import type { ServiceInput } from '../schemas/service.js';
import { applyOrder, nextSortOrder } from './ordering.js';

export function listServices(tx: Tx) {
  return tx.select().from(service).orderBy(asc(service.sortOrder), asc(service.name));
}

export async function getService(tx: Tx, id: string) {
  const [row] = await tx.select().from(service).where(eq(service.id, id));
  return row;
}

export async function createService(tx: Tx, data: ServiceInput): Promise<string> {
  const sortOrder = await nextSortOrder(tx, service);
  const [row] = await tx
    .insert(service)
    .values({ ...data, sortOrder, ...touch() })
    .returning({ id: service.id });
  if (!row) throw new Error('No se pudo crear el servicio');
  return row.id;
}

export async function updateService(tx: Tx, id: string, data: ServiceInput): Promise<boolean> {
  const rows = await tx
    .update(service)
    .set({ ...data, ...touch() })
    .where(eq(service.id, id))
    .returning({ id: service.id });
  return rows.length > 0;
}

/** Borra el servicio; sus asociaciones con recursos caen en cascada. */
export async function deleteService(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx.delete(service).where(eq(service.id, id)).returning({ id: service.id });
  if (rows.length > 0) await touchBusiness(tx);
  return rows.length > 0;
}

export function reorderServices(tx: Tx, ids: string[]): Promise<boolean> {
  return applyOrder(tx, service, ids);
}
