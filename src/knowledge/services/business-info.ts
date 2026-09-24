import { NotFoundError } from '../errors.js';
import * as businessRepo from '../repositories/business.js';
import * as hoursRepo from '../repositories/business-hours.js';
import * as closuresRepo from '../repositories/closures.js';
import { businessSchema } from '../schemas/business.js';
import { closureSchema } from '../schemas/closure.js';
import { weeklyScheduleSchema } from '../schemas/weekly-slots.js';
import type { KnowledgeDeps } from './deps.js';
import { assertId } from './ids.js';
import { runGuardedWrite } from './guarded-write.js';

/** Datos del negocio (FR-001, FR-002). */
export async function saveBusiness(deps: KnowledgeDeps, input: unknown): Promise<void> {
  const data = businessSchema(deps.phoneRegion).parse(input);
  await runGuardedWrite(deps.db, (tx) => businessRepo.updateBusiness(tx, data));
}

/** Horario semanal completo (FR-003, FR-006). */
export async function saveBusinessHours(deps: KnowledgeDeps, input: unknown): Promise<void> {
  const { slots } = weeklyScheduleSchema.parse(input);
  await runGuardedWrite(deps.db, (tx) => hoursRepo.replaceBusinessHours(tx, slots));
}

export async function createClosure(deps: KnowledgeDeps, input: unknown): Promise<string> {
  const data = closureSchema.parse(input);
  return runGuardedWrite(deps.db, (tx) => closuresRepo.createClosure(tx, data));
}

export async function updateClosure(
  deps: KnowledgeDeps,
  id: string,
  input: unknown,
): Promise<void> {
  assertId(id, 'Cierre');
  const data = closureSchema.parse(input);
  await runGuardedWrite(deps.db, async (tx) => {
    if (!(await closuresRepo.updateClosure(tx, id, data))) throw new NotFoundError('Cierre');
  });
}

export async function deleteClosure(deps: KnowledgeDeps, id: string): Promise<void> {
  assertId(id, 'Cierre');
  await runGuardedWrite(deps.db, async (tx) => {
    if (!(await closuresRepo.deleteClosure(tx, id))) throw new NotFoundError('Cierre');
  });
}
