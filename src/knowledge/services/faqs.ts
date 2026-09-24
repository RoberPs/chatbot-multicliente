import { NotFoundError } from '../errors.js';
import * as repo from '../repositories/faqs.js';
import { faqSchema } from '../schemas/faq.js';
import type { KnowledgeDeps } from './deps.js';
import { runGuardedWrite } from './guarded-write.js';
import { assertId, parseReorder } from './ids.js';

/** Preguntas frecuentes (FR-014). */
export async function createFaq(deps: KnowledgeDeps, input: unknown): Promise<string> {
  const data = faqSchema.parse(input);
  return runGuardedWrite(deps.db, (tx) => repo.createFaq(tx, data));
}

export async function updateFaq(deps: KnowledgeDeps, id: string, input: unknown): Promise<void> {
  assertId(id, 'Pregunta');
  const data = faqSchema.parse(input);
  await runGuardedWrite(deps.db, async (tx) => {
    if (!(await repo.updateFaq(tx, id, data))) throw new NotFoundError('Pregunta');
  });
}

export async function deleteFaq(deps: KnowledgeDeps, id: string): Promise<void> {
  assertId(id, 'Pregunta');
  await runGuardedWrite(deps.db, async (tx) => {
    if (!(await repo.deleteFaq(tx, id))) throw new NotFoundError('Pregunta');
  });
}

export async function reorderFaqs(deps: KnowledgeDeps, input: unknown): Promise<void> {
  const ids = parseReorder(input, 'Pregunta');
  await runGuardedWrite(deps.db, async (tx) => {
    if (!(await repo.reorderFaqs(tx, ids))) throw new NotFoundError('Pregunta');
  });
}
