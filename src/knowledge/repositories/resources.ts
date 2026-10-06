import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import {
  resource,
  resourceAbsence,
  resourceHours,
  resourceService,
  service,
} from '../../db/schema.js';
import { touch, touchBusiness } from '../../db/timestamps.js';
import type { DateRangeInput } from '../schemas/date-range-block.js';
import type { WeeklySlot } from '../types.js';
import { nextSortOrder } from './ordering.js';

export interface ResourceData {
  name: string;
  active: boolean;
}

export async function listResources(tx: Tx) {
  const rows = await tx
    .select()
    .from(resource)
    .orderBy(asc(resource.sortOrder), asc(resource.name));
  const links = await tx.select().from(resourceService);
  return rows.map((r) => ({
    ...r,
    serviceIds: links.filter((l) => l.resourceId === r.id).map((l) => l.serviceId),
  }));
}

export async function getResource(tx: Tx, id: string) {
  const [row] = await tx.select().from(resource).where(eq(resource.id, id));
  return row;
}

/** ¿Existen todos estos servicios? */
export async function allServicesExist(tx: Tx, serviceIds: string[]): Promise<boolean> {
  if (serviceIds.length === 0) return true;
  const rows = await tx
    .select({ id: service.id })
    .from(service)
    .where(inArray(service.id, serviceIds));
  return rows.length === new Set(serviceIds).size;
}

export async function createResource(tx: Tx, data: ResourceData): Promise<string> {
  const sortOrder = await nextSortOrder(tx, resource);
  const [row] = await tx
    .insert(resource)
    .values({ ...data, sortOrder, ...touch() })
    .returning({ id: resource.id });
  if (!row) throw new Error('No se pudo crear el recurso');
  return row.id;
}

export async function updateResource(tx: Tx, id: string, data: ResourceData): Promise<boolean> {
  const rows = await tx
    .update(resource)
    .set({ ...data, ...touch() })
    .where(eq(resource.id, id))
    .returning({ id: resource.id });
  return rows.length > 0;
}

/** Reemplaza los servicios que presta el recurso. */
export async function setResourceServices(
  tx: Tx,
  resourceId: string,
  serviceIds: string[],
): Promise<void> {
  await tx.delete(resourceService).where(eq(resourceService.resourceId, resourceId));
  if (serviceIds.length > 0) {
    await tx
      .insert(resourceService)
      .values(serviceIds.map((serviceId) => ({ resourceId, serviceId, ...touch() })));
  }
  await tx.update(resource).set(touch()).where(eq(resource.id, resourceId));
}

export async function replaceResourceHours(
  tx: Tx,
  resourceId: string,
  slots: WeeklySlot[],
): Promise<void> {
  await tx.delete(resourceHours).where(eq(resourceHours.resourceId, resourceId));
  if (slots.length > 0) {
    await tx.insert(resourceHours).values(
      slots.map((s) => ({
        resourceId,
        weekday: s.weekday,
        startTime: s.start,
        endTime: s.end,
        ...touch(),
      })),
    );
  }
  await tx.update(resource).set(touch()).where(eq(resource.id, resourceId));
}

export async function getAbsence(tx: Tx, resourceId: string, absenceId: string) {
  const [row] = await tx
    .select()
    .from(resourceAbsence)
    .where(and(eq(resourceAbsence.id, absenceId), eq(resourceAbsence.resourceId, resourceId)));
  return row;
}

export async function createAbsence(
  tx: Tx,
  resourceId: string,
  data: DateRangeInput,
): Promise<string> {
  const [row] = await tx
    .insert(resourceAbsence)
    .values({ resourceId, ...data, ...touch() })
    .returning({ id: resourceAbsence.id });
  if (!row) throw new Error('No se pudo crear la ausencia');
  return row.id;
}

export async function updateAbsence(
  tx: Tx,
  resourceId: string,
  absenceId: string,
  data: DateRangeInput,
): Promise<boolean> {
  const rows = await tx
    .update(resourceAbsence)
    .set({ ...data, ...touch() })
    .where(and(eq(resourceAbsence.id, absenceId), eq(resourceAbsence.resourceId, resourceId)))
    .returning({ id: resourceAbsence.id });
  return rows.length > 0;
}

export async function deleteAbsence(
  tx: Tx,
  resourceId: string,
  absenceId: string,
): Promise<boolean> {
  const rows = await tx
    .delete(resourceAbsence)
    .where(and(eq(resourceAbsence.id, absenceId), eq(resourceAbsence.resourceId, resourceId)))
    .returning({ id: resourceAbsence.id });
  if (rows.length > 0) await tx.update(resource).set(touch()).where(eq(resource.id, resourceId));
  return rows.length > 0;
}

/** Borra el recurso; asociaciones, horario y ausencias caen en cascada. */
export async function deleteResource(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx.delete(resource).where(eq(resource.id, id)).returning({ id: resource.id });
  if (rows.length > 0) await touchBusiness(tx);
  return rows.length > 0;
}
