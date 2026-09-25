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
  evalChannel,
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
  /**
   * SC-010 con los mismos resultados: al final compara el porcentaje de acierto de cada
   * sector (todos ≥ 90 % y a ≤ 10 puntos entre sí), sin llamadas adicionales al modelo.
   */
  compareSectors?: boolean;
}

export function describeCriterion(
  criterion: Criterion,
  title: string,
  opts: CriterionOptions = {},
): void {
  describe.skipIf(!hasApiKey || opts.skip === true)(`${criterion}: ${title}`, () => {
    const bySector = new Map<string, { ok: number; total: number }>();
    afterAll(() => {
      printReport(`${criterion} — ${title}`);
    });

    for (const sector of opts.sectors ?? sectors) {
      // La web solo admite texto (FR-020): las preguntas con archivos no aplican a ese canal.
      const questions = sector.questions.filter(
        (q) => measures(q, criterion) && (evalChannel === 'whatsapp' || !q.media),
      );
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
            const row = bySector.get(sector.fixture.sector) ?? { ok: 0, total: 0 };
            row.total += 1;
            if (ok) row.ok += 1;
            bySector.set(sector.fixture.sector, row);
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

    if (opts.compareSectors) {
      it('SC-010: mismo comportamiento en los tres sectores', () => {
        const rates = [...bySector.entries()].map(([name, r]) => {
          const rate = (r.ok / r.total) * 100;
          record('SC-010', name, rate >= 90, `[${name}] ${r.ok}/${r.total}`);
          return rate;
        });
        expect(rates).toHaveLength(sectors.length);
        for (const rate of rates) expect(rate).toBeGreaterThanOrEqual(90);
        expect(Math.max(...rates) - Math.min(...rates)).toBeLessThanOrEqual(10);
      });
    }
  });
}
