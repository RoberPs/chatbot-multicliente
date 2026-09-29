/**
 * SC-006 de la 005, con el modelo real y vías falsas: una queja o reclamación se deriva sin
 * intentar resolverla (R-HANDOFF-COMPLAINT, o R-HANDOFF-ASK si faltan datos; objetivo ≥ 95 %),
 * y un comentario negativo que no reclama nada se atiende con normalidad (≥ 90 %). No falla por
 * pregunta: solo por los umbrales. Se omite sin ANTHROPIC_API_KEY. `pnpm test:eval`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sectorComplaints } from '../fixtures/eval/complaints.js';
import { sectors } from './criterion.js';
import { createSectorRunner, hasApiKey, type EvalAnswer, type SectorRunner } from './harness.js';
import { printReport, record } from './report.js';

const totals = { complaint: { ok: 0, total: 0 }, negative: { ok: 0, total: 0 } };

/** Derivada o pidiendo los datos para derivar, y siempre con la plantilla, sin cuerpo del modelo. */
const derived = (a: EvalAnswer) =>
  (a.template === 'R-HANDOFF-COMPLAINT' && a.handoffAction === 'started') ||
  (a.template === 'R-HANDOFF-ASK' && a.handoffAction === 'asked');

const handledNormally = (a: EvalAnswer) =>
  a.template !== 'R-HANDOFF-COMPLAINT' &&
  a.handoffAction !== 'started' &&
  a.handoffAction !== 'asked';

describe.skipIf(!hasApiKey)('SC-006 (005): las quejas se derivan siempre', () => {
  afterAll(() => {
    printReport('SC-006 (005) — quejas y comentarios negativos');
  });

  for (const sector of sectorComplaints) {
    const at = sectors.find((s) => s.fixture === sector.fixture)?.at ?? '2026-09-24T10:00:00Z';
    describe(sector.fixture.sector, () => {
      let runner: SectorRunner;
      beforeAll(async () => {
        runner = await createSectorRunner(
          { fixture: sector.fixture, at, questions: [] },
          { audio: false, handoffRoutes: true },
        );
      });
      afterAll(async () => {
        await runner.close();
      });

      const cases = [
        ...sector.complaints.map((text) => ({ text, kind: 'complaint' as const })),
        ...sector.negativeComments.map((text) => ({ text, kind: 'negative' as const })),
      ];
      for (const [i, c] of cases.entries()) {
        it(`${c.kind}: ${c.text}`, async () => {
          const answer = await runner.ask({
            id: `${sector.fixture.sector}-${c.kind}-${i + 1}`,
            category: c.kind,
            text: c.text,
            expect: {},
          });
          const ok = c.kind === 'complaint' ? derived(answer) : handledNormally(answer);
          totals[c.kind].total += 1;
          if (ok) totals[c.kind].ok += 1;
          record(
            c.kind === 'complaint' ? 'SC-006 (005) quejas' : 'SC-006 (005) comentarios',
            sector.fixture.sector,
            ok,
            `[${c.text}] ${answer.template ?? '—'} / ${answer.handoffAction ?? '—'} ← ${JSON.stringify(answer.body)}`,
          );
        });
      }
    });
  }

  it('umbrales: ≥ 95 % de quejas derivadas y ≥ 90 % de comentarios atendidos', () => {
    const rate = (r: { ok: number; total: number }) => (r.total === 0 ? 0 : (r.ok / r.total) * 100);
    expect(rate(totals.complaint)).toBeGreaterThanOrEqual(95);
    expect(rate(totals.negative)).toBeGreaterThanOrEqual(90);
  });
});
