/**
 * Suite de un criterio de éxito: pasa por el modelo real las preguntas de los tres sectores
 * que miden ese criterio y acumula el resultado por categoría. Se omite sin ANTHROPIC_API_KEY.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clinicQuestions } from '../fixtures/eval/clinic.questions.js';
import { hairSalonQuestions } from '../fixtures/eval/hair-salon.questions.js';
import { workshopQuestions } from '../fixtures/eval/workshop.questions.js';
import {
  createSectorRunner,
  hasApiKey,
  type Criterion,
  type EvalQuestion,
  type SectorQuestions,
  type SectorRunner,
} from './harness.js';
import { printReport, record } from './report.js';

export const sectors = [hairSalonQuestions, clinicQuestions, workshopQuestions];

export const measures = (question: EvalQuestion, criterion: Criterion) =>
  (question.criterion ?? 'SC-001') === criterion;

export interface CriterionOptions {
  /** Otras preguntas en lugar de las de tests/fixtures/eval/. */
  sectors?: SectorQuestions[];
  /** Audios con Whisper real. */
  audio?: boolean;
  skip?: boolean;
}

export function describeCriterion(
  criterion: Criterion,
  title: string,
  opts: CriterionOptions = {},
): void {
  describe.skipIf(!hasApiKey || opts.skip === true)(`${criterion}: ${title}`, () => {
    afterAll(() => {
      printReport(`${criterion} — ${title}`);
    });

    for (const sector of opts.sectors ?? sectors) {
      const questions = sector.questions.filter((q) => measures(q, criterion));
      if (questions.length === 0) continue;
      describe(sector.fixture.sector, () => {
        let runner: SectorRunner;
        beforeAll(async () => {
          runner = await createSectorRunner(sector, { audio: opts.audio ?? false });
        });
        afterAll(async () => {
          await runner.close();
        });

        for (const question of questions) {
          it(`${question.category}: ${question.text}`, async () => {
            const answer = await runner.ask(question);
            const ok = answer.problems.length === 0;
            record(
              criterion,
              question.category,
              ok,
              `[${question.id}] ${answer.problems.join('; ')} ← ${JSON.stringify(answer.body)}`,
            );
            expect.soft(answer.problems, answer.body).toEqual([]);
          });
        }
      });
    }
  });
}
