/**
 * SC-001: preguntas con dato registrado contestadas correctamente (objetivo 100 %).
 * Modelo real; se omite sin ANTHROPIC_API_KEY. `pnpm test:eval`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clinicQuestions } from '../fixtures/eval/clinic.questions.js';
import { hairSalonQuestions } from '../fixtures/eval/hair-salon.questions.js';
import { workshopQuestions } from '../fixtures/eval/workshop.questions.js';
import { createSectorRunner, hasApiKey, type SectorRunner } from './harness.js';
import { printReport, record } from './report.js';

const sectors = [hairSalonQuestions, clinicQuestions, workshopQuestions];

describe.skipIf(!hasApiKey)('SC-001: preguntas con dato registrado', () => {
  afterAll(() => {
    printReport('SC-001 — preguntas con dato registrado');
  });

  for (const sector of sectors) {
    describe(sector.fixture.sector, () => {
      let runner: SectorRunner;
      beforeAll(async () => {
        runner = await createSectorRunner(sector);
      });
      afterAll(async () => {
        await runner.close();
      });

      for (const question of sector.questions) {
        it(`${question.category}: ${question.text}`, async () => {
          const answer = await runner.ask(question);
          const ok = answer.problems.length === 0;
          record(
            'SC-001',
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
