import { NotFoundError } from '../errors.js';
import * as servicesRepo from '../repositories/services.js';
import { serviceSchema } from '../schemas/service.js';
import type { KnowledgeDeps } from './deps.js';
import { runGuardedWrite } from './guarded-write.js';
import { assertId, parseReorder } from './ids.js';

/** Servicios (FR-007 – FR-009). */
export async function createService(deps: KnowledgeDeps, input: unknown): Promise<string> {
  const data = serviceSchema.parse(input);
  return runGuardedWrite(deps.db, (tx) => servicesRepo.createService(tx, data));
}

export async function updateService(
  deps: KnowledgeDeps,
  id: string,
  input: unknown,
): Promise<void> {
  assertId(id, 'Servicio');
  const data = serviceSchema.parse(input);
  await runGuardedWrite(deps.db, async (tx) => {
    if (!(await servicesRepo.updateService(tx, id, data))) throw new NotFoundError('Servicio');
  });
}

export async function deleteService(deps: KnowledgeDeps, id: string): Promise<void> {
  assertId(id, 'Servicio');
  await runGuardedWrite(deps.db, async (tx) => {
    if (!(await servicesRepo.deleteService(tx, id))) throw new NotFoundError('Servicio');
  });
}

export async function reorderServices(deps: KnowledgeDeps, input: unknown): Promise<void> {
  const ids = parseReorder(input, 'Servicio');
  await runGuardedWrite(deps.db, async (tx) => {
    if (!(await servicesRepo.reorderServices(tx, ids))) throw new NotFoundError('Servicio');
  });
}
