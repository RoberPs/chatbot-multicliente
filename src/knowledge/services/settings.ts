import { describeHandoffChange, effectiveHandoff, sameChannels } from '../handoff.js';
import * as handoffRepo from '../repositories/handoff.js';
import * as policiesRepo from '../repositories/policies.js';
import * as toneRepo from '../repositories/tone.js';
import { handoffSchema } from '../schemas/handoff.js';
import { policiesSchema } from '../schemas/policies.js';
import { toneSchema } from '../schemas/tone.js';
import type { KnowledgeDeps } from './deps.js';
import type { HandoffChange, KnowledgeState } from '../types.js';
import { runGuardedWrite, runTrackedWrite } from './guarded-write.js';

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

/** Medios guardados en orden, sin el horario. */
const savedChannels = (state: KnowledgeState) =>
  [...(state.handoff?.channels ?? [])]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((c) => ({ type: c.type, value: c.value }));

/**
 * Contacto de derivación (FR-018, FR-019). Protegido por FR-032 en un negocio activo.
 * Devuelve cómo queda el contacto que usa el bot (003, FR-006).
 */
export async function saveHandoff(deps: KnowledgeDeps, input: unknown): Promise<HandoffChange> {
  const data = handoffSchema(deps.phoneRegion).parse(input);
  const { before, after } = await runTrackedWrite(deps.db, (tx) =>
    handoffRepo.saveHandoff(tx, data.channels, data.slots),
  );
  return describeHandoffChange(
    effectiveHandoff(before),
    effectiveHandoff(after),
    !sameChannels(savedChannels(before), savedChannels(after)),
    after.business.status,
  );
}
