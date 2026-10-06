import type { Tx } from '../../db/client.js';
import { FieldConflictError, NotFoundError } from '../errors.js';
import * as repo from '../repositories/resources.js';
import { absenceSchema, resourceSchema } from '../schemas/resource.js';
import { weeklyScheduleSchema } from '../schemas/weekly-slots.js';
import type { KnowledgeDeps } from './deps.js';
import { runGuardedWrite } from './guarded-write.js';
import { assertId } from './ids.js';

async function assertServicesExist(tx: Tx, serviceIds: string[]): Promise<void> {
  if (!(await repo.allServicesExist(tx, serviceIds))) {
    throw new FieldConflictError('service_ids', 'Alguno de los servicios no existe');
  }
}

/** Recursos (FR-010 – FR-013). */
export async function createResource(deps: KnowledgeDeps, input: unknown): Promise<string> {
  const data = resourceSchema.parse(input);
  return runGuardedWrite(deps.db, async (tx) => {
    await assertServicesExist(tx, data.serviceIds);
    const id = await repo.createResource(tx, { name: data.name, active: data.active });
    await repo.setResourceServices(tx, id, data.serviceIds);
    return id;
  });
}

export async function updateResource(
  deps: KnowledgeDeps,
  id: string,
  input: unknown,
): Promise<void> {
  assertId(id, 'Recurso');
  const data = resourceSchema.parse(input);
  await runGuardedWrite(deps.db, async (tx) => {
    if (!(await repo.updateResource(tx, id, { name: data.name, active: data.active }))) {
      throw new NotFoundError('Recurso');
    }
    await assertServicesExist(tx, data.serviceIds);
    await repo.setResourceServices(tx, id, data.serviceIds);
  });
}

export async function saveResourceHours(
  deps: KnowledgeDeps,
  id: string,
  input: unknown,
): Promise<void> {
  assertId(id, 'Recurso');
  const { slots } = weeklyScheduleSchema.parse(input);
  await runGuardedWrite(deps.db, async (tx) => {
    if (!(await repo.getResource(tx, id))) throw new NotFoundError('Recurso');
    await repo.replaceResourceHours(tx, id, slots);
  });
}

export async function createAbsence(
  deps: KnowledgeDeps,
  resourceId: string,
  input: unknown,
): Promise<string> {
  assertId(resourceId, 'Recurso');
  const data = absenceSchema.parse(input);
  return runGuardedWrite(deps.db, async (tx) => {
    if (!(await repo.getResource(tx, resourceId))) throw new NotFoundError('Recurso');
    return repo.createAbsence(tx, resourceId, data);
  });
}

export async function updateAbsence(
  deps: KnowledgeDeps,
  resourceId: string,
  absenceId: string,
  input: unknown,
): Promise<void> {
  assertId(resourceId, 'Recurso');
  assertId(absenceId, 'Ausencia');
  const data = absenceSchema.parse(input);
  await runGuardedWrite(deps.db, async (tx) => {
    if (!(await repo.updateAbsence(tx, resourceId, absenceId, data))) {
      throw new NotFoundError('Ausencia');
    }
  });
}

export async function deleteAbsence(
  deps: KnowledgeDeps,
  resourceId: string,
  absenceId: string,
): Promise<void> {
  assertId(resourceId, 'Recurso');
  assertId(absenceId, 'Ausencia');
  await runGuardedWrite(deps.db, async (tx) => {
    if (!(await repo.deleteAbsence(tx, resourceId, absenceId))) throw new NotFoundError('Ausencia');
  });
}

export async function deleteResource(deps: KnowledgeDeps, id: string): Promise<void> {
  assertId(id, 'Recurso');
  await runGuardedWrite(deps.db, async (tx) => {
    if (!(await repo.deleteResource(tx, id))) throw new NotFoundError('Recurso');
  });
}
