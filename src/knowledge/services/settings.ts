import * as handoffRepo from '../repositories/handoff.js';
import * as policiesRepo from '../repositories/policies.js';
import * as toneRepo from '../repositories/tone.js';
import { handoffSchema } from '../schemas/handoff.js';
import { policiesSchema } from '../schemas/policies.js';
import { toneSchema } from '../schemas/tone.js';
import type { KnowledgeDeps } from './deps.js';
import { runGuardedWrite } from './guarded-write.js';

/** Políticas (FR-015, FR-016). */
export async function savePolicies(deps: KnowledgeDeps, input: unknown): Promise<void> {
  const data = policiesSchema.parse(input);
  await runGuardedWrite(deps.db, (tx) => policiesRepo.upsertPolicies(tx, data));
}

/** Tono (FR-017). */
export async function saveTone(deps: KnowledgeDeps, input: unknown): Promise<void> {
  const data = toneSchema.parse(input);
  await runGuardedWrite(deps.db, (tx) => toneRepo.upsertTone(tx, data));
}

/** Contacto de derivación (FR-018, FR-019). Protegido por FR-032 en un negocio activo. */
export async function saveHandoff(deps: KnowledgeDeps, input: unknown): Promise<void> {
  const data = handoffSchema(deps.phoneRegion).parse(input);
  await runGuardedWrite(deps.db, (tx) => handoffRepo.saveHandoff(tx, data.channels, data.slots));
}
