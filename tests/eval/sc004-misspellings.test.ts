/**
 * SC-004: al menos el 90 % de las preguntas con faltas o lenguaje coloquial obtiene la misma
 * respuesta que su versión bien escrita, y el resto pide reformular; nunca un dato erróneo.
 * Usa las `variants` de las preguntas de horario, ubicación y precios (US1, US2).
 * Modelo real; se omite sin la credencial del proveedor declarado. `pnpm test:eval`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sectors } from './criterion.js';
import { createSectorRunner, hasApiKey, normalize, type SectorRunner } from './harness.js';
import { printReport, record } from './report.js';

/** Pide al cliente que lo diga de otra forma. */
const REPHRASE =
  /reformul|no (?:te|le) he entendido|no (?:lo )?entiendo|(?:puedes|podrias|puede|podria) (?:repetir|decirmelo|explicar)|a que (?:te|se) refieres|concretar/;

type Outcome = 'igual' | 'reformular' | 'fallo';
const outcomes: Outcome[] = [];

describe.skipIf(!hasApiKey)('SC-004: faltas de ortografía y lenguaje coloquial', () => {
  afterAll(() => {
    printReport('SC-004 — faltas de ortografía y lenguaje coloquial');
  });

  for (const sector of sectors) {
    const questions = sector.questions.filter((q) => (q.variants ?? []).length > 0);
    describe(sector.fixture.sector, () => {
      let runner: SectorRunner;
      beforeAll(async () => {
        runner = await createSectorRunner(sector);
      });
      afterAll(async () => {
        await runner.close();
      });

      for (const question of questions) {
        for (const [i, variant] of (question.variants ?? []).entries()) {
          it(`${question.category}: ${variant}`, async () => {
            const answer = await runner.ask({
              ...question,
              id: `${question.id}-v${i + 1}`,
              text: variant,
            });
            const outcome: Outcome =
              answer.problems.length === 0
                ? 'igual'
                : REPHRASE.test(normalize(answer.body))
                  ? 'reformular'
                  : 'fallo';
            outcomes.push(outcome);
            record(
              'SC-004',
              question.category,
              outcome === 'igual',
              `[${question.id}-v${i + 1}] ${outcome}: ${answer.problems.join('; ')} ← ${JSON.stringify(answer.body)}`,
            );
            // Pedir que reformule es aceptable; un dato erróneo o que falte, no.
            expect.soft(outcome, answer.body).not.toBe('fallo');
          });
        }
      }
    });
  }

  it('al menos el 90 % igual que la versión bien escrita', () => {
    const same = outcomes.filter((o) => o === 'igual').length;
    expect(outcomes.length).toBeGreaterThan(0);
    expect(same / outcomes.length).toBeGreaterThanOrEqual(0.9);
  });
});
