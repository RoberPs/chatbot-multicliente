/**
 * SC-010: negocios de tres sectores distintos se atienden con el mismo comportamiento, sin
 * cambios de código. Corre las mismas categorías de SC-001 con la peluquería, la clínica y el
 * taller de tests/fixtures/ y compara los porcentajes: todos por encima del 90 % y a no más de
 * 10 puntos entre sí. Modelo real; se omite sin ANTHROPIC_API_KEY. `pnpm test:eval`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measures, sectors } from './criterion.js';
import { createSectorRunner, hasApiKey, type SectorRunner } from './harness.js';
import { printReport, record } from './report.js';

/** Categorías que existen en los tres sectores. */
const CATEGORIES = [
  'horario',
  'abierto_ahora',
  'ubicacion',
  'servicios',
  'faq',
  'precios',
  'duraciones',
  'politicas',
];
const results = new Map<string, { ok: number; total: number }>();

describe.skipIf(!hasApiKey)('SC-010: mismo comportamiento en tres sectores', () => {
  afterAll(() => {
    printReport('SC-010 — mismo comportamiento en tres sectores');
  });

  for (const sector of sectors) {
    const name = sector.fixture.sector;
    const questions = sector.questions.filter(
      (q) => measures(q, 'SC-001') && CATEGORIES.includes(q.category),
    );
    describe(name, () => {
      let runner: SectorRunner;
      beforeAll(async () => {
        runner = await createSectorRunner(sector);
      });
      afterAll(async () => {
        await runner.close();
      });

      for (const question of questions) {
        it(`${question.category}: ${question.text}`, async () => {
          const answer = await runner.ask(question);
          const ok = answer.problems.length === 0;
          const row = results.get(name) ?? { ok: 0, total: 0 };
          row.total += 1;
          if (ok) row.ok += 1;
          results.set(name, row);
          record('SC-010', name, ok, `[${question.id}] ${answer.problems.join('; ')}`);
        });
      }
    });
  }

  it('los tres sectores, por encima del 90 % y a menos de 10 puntos entre sí', () => {
    const rates = [...results.values()].map((r) => (r.ok / r.total) * 100);
    expect(rates).toHaveLength(sectors.length);
    for (const rate of rates) expect(rate).toBeGreaterThanOrEqual(90);
    expect(Math.max(...rates) - Math.min(...rates)).toBeLessThanOrEqual(10);
  });
});
