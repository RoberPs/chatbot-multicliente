/**
 * 005, SC-003: el resumen del motivo que recibe el negocio, con el modelo real. Comprueba
 * automáticamente que no trae datos concretos que el cliente no escribió (umbral 100 %) y vuelca
 * al informe cada resumen con su conversación y dos casillas para la revisión manual de T131:
 * "identifica cliente y motivo" (umbral 90 %) y "sin datos no dados" (umbral 100 %).
 *
 * También SC-001 de la 005: una petición de persona en mitad de otra gestión deriva igual (con
 * vías falsas termina en R-HANDOFF-OK o R-HANDOFF-ASK). Se omite sin ANTHROPIC_API_KEY.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { summaryIsGrounded, SUMMARY_MAX_CHARS } from '../../src/handoff/summary.js';
import { createAnthropicSummarizer } from '../../src/llm/anthropic-summarizer.js';
import { handoffConversations } from '../fixtures/eval/handoff-conversations.js';
import { describeCriterion } from './criterion.js';
import { hasApiKey, type SectorQuestions } from './harness.js';
import { printReport, record } from './report.js';

const manual: string[] = [];

describe.skipIf(!hasApiKey)('SC-003 (005): resumen del motivo de la derivación', () => {
  const summarizer = createAnthropicSummarizer({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.LLM_MODEL?.trim() || 'claude-sonnet-5',
  });

  afterAll(() => {
    printReport('SC-003 (005) — resumen del motivo');
    if (manual.length > 0) {
      console.log(
        [
          '\n=== Revisión manual de SC-003 (T131) ===',
          'Marca cada casilla: identifica cliente y motivo (umbral 90 %) · sin datos no dados (umbral 100 %).',
          ...manual,
        ].join('\n'),
      );
    }
  });

  for (const sector of handoffConversations) {
    describe(sector.fixture.sector, () => {
      for (const conversation of sector.conversations) {
        it(conversation.id, async () => {
          const { summary } = await summarizer.summarize(
            { kind: 'person', customerTexts: conversation.texts },
            { signal: AbortSignal.timeout(20_000) },
          );
          const problems = [
            ...(summaryIsGrounded(summary, conversation.texts) ? [] : ['dato no dado']),
            ...(summary.length > SUMMARY_MAX_CHARS ? ['más de 300 caracteres'] : []),
            ...(/[\r\n\t]/.test(summary) ? ['más de una línea'] : []),
          ];
          record(
            'SC-003 (005) sin datos no dados',
            sector.fixture.sector,
            problems.length === 0,
            `[${conversation.id}] ${problems.join('; ')} ← ${JSON.stringify(summary)}`,
          );
          manual.push(
            [
              `\n[${conversation.id}] ${sector.fixture.sector}`,
              ...conversation.texts.map((t) => `  cliente: ${t}`),
              `  resumen: ${summary}`,
              '  [ ] identifica cliente y motivo   [ ] sin datos no dados',
            ].join('\n'),
          );
          expect.soft(problems, summary).toEqual([]);
        });
      }
    });
  }
});

/** Peticiones en mitad de otra gestión como preguntas de la suite común. */
const midFlowSectors: SectorQuestions[] = handoffConversations.map((sector) => ({
  fixture: sector.fixture,
  // Jueves 24/09/2026, 12:00 en Madrid.
  at: '2026-09-24T10:00:00Z',
  questions: sector.midFlow.map((text, i) => ({
    id: `${sector.fixture.sector}-mid-${i + 1}`,
    category: 'mitad-gestion',
    criterion: 'SC-008' as const,
    text,
    expect: {},
  })),
}));

describeCriterion('SC-008', 'petición de persona en mitad de otra gestión (005, con vías)', {
  sectors: midFlowSectors,
  handoffRoutes: true,
  reportAs: 'SC-001 (005) mitad de otra gestión',
  judge: (answer) =>
    answer.template === 'R-HANDOFF-OK' || answer.template === 'R-HANDOFF-ASK'
      ? []
      : [`sin derivación (plantilla ${answer.template ?? 'ninguna'})`],
});
