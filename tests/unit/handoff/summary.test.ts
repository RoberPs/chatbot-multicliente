/** Resumen del motivo de la derivación (005, R4): verificación y respaldo por código. */
import { describe, expect, it } from 'vitest';
import {
  fallbackSummary,
  NO_REASON_SUMMARY,
  summarizeHandoff,
} from '../../../src/handoff/summary.js';
import { FakeSummarizer, RecordingActivityLog } from '../../helpers/fakes.js';

const TEXTS = [
  '¿Cuánto cuesta el tinte completo?',
  'Quiero hablar con una persona',
];

async function run(summarizer: FakeSummarizer, texts = TEXTS, budgetMs = 8_000) {
  const log = new RecordingActivityLog();
  const result = await summarizeHandoff({
    summarizer,
    kind: 'person',
    customerTexts: texts,
    activityLog: log,
    budgetMs,
  });
  return { result, log };
}

describe('resumen del modelo', () => {
  it('se acepta si solo usa lo que escribió el cliente', async () => {
    const { result, log } = await run(
      new FakeSummarizer({ summary: 'Pregunta cuánto cuesta el tinte completo.' }),
    );
    expect(result).toEqual({ summary: 'Pregunta cuánto cuesta el tinte completo.', source: 'model' });
    expect(log.named('handoff_summary_fallback')).toEqual([]);
  });

  it('el resumidor solo recibe los textos del cliente y el tipo', async () => {
    const summarizer = new FakeSummarizer();
    await run(summarizer);
    expect(summarizer.calls).toEqual([{ kind: 'person', customerTexts: TEXTS }]);
  });

  it('un dato que el cliente no dio lo invalida → respaldo', async () => {
    for (const invented of [
      'Pregunta por el tinte, que cuesta 45 €.',
      'Quiere que le llamen al 611 222 333.',
      'Pregunta por el tinte para el 12/10.',
      'Quiere venir a las 17:30.',
      'Pregunta por el tinte que vio en https://ejemplo.com/tinte.',
    ]) {
      const { result, log } = await run(new FakeSummarizer({ summary: invented }));
      expect(result.source).toBe('fallback');
      expect(log.named('handoff_summary_fallback')).toEqual([
        { event: 'handoff_summary_fallback', reason: 'unverified' },
      ]);
    }
  });

  it('un dato que sí escribió el cliente se acepta', async () => {
    const texts = ['¿Tenéis hueco el 12/10 a las 17:30?', 'Quiero hablar con alguien'];
    const { result } = await run(
      new FakeSummarizer({ summary: 'Pregunta si hay hueco el 12/10 a las 17:30.' }),
      texts,
    );
    expect(result.source).toBe('model');
  });

  it('más de 300 caracteres o con saltos de línea → respaldo', async () => {
    for (const summary of ['a'.repeat(301), 'Pregunta por el tinte.\nY por el corte.']) {
      const { result } = await run(new FakeSummarizer({ summary }));
      expect(result.source).toBe('fallback');
    }
  });

  it('fallo del modelo → respaldo con reason model_error', async () => {
    const { result, log } = await run(new FakeSummarizer({ fail: true }));
    expect(result.source).toBe('fallback');
    expect(log.named('handoff_summary_fallback')[0]?.reason).toBe('model_error');
  });

  it('plazo agotado → respaldo con reason timeout', async () => {
    const { result, log } = await run(new FakeSummarizer({ hang: true }), TEXTS, 20);
    expect(result.source).toBe('fallback');
    expect(log.named('handoff_summary_fallback')[0]?.reason).toBe('timeout');
  });
});

describe('respaldo por código', () => {
  it('sin mensajes previos → "sin dar el motivo" (US1-5)', () => {
    expect(fallbackSummary('person', [])).toBe(NO_REASON_SUMMARY);
    expect(fallbackSummary('person', ['Quiero hablar con una persona'])).toBe(NO_REASON_SUMMARY);
    expect(NO_REASON_SUMMARY).toBe('El cliente pidió hablar con una persona sin dar el motivo.');
  });

  it('con mensajes → extracto literal de los últimos, en una línea', () => {
    expect(fallbackSummary('person', TEXTS)).toBe('¿Cuánto cuesta el tinte completo?');
    expect(fallbackSummary('person', ['Hola\n\ntengo  una duda', '¿Abrís el sábado?'])).toBe(
      'Hola tengo una duda / ¿Abrís el sábado?',
    );
  });

  it('recortado a 300 caracteres, quedándose con los últimos', () => {
    const long = Array.from({ length: 10 }, (_, i) => `Mensaje ${i} ${'x'.repeat(40)}`);
    const summary = fallbackSummary('person', long);
    expect(summary.length).toBeLessThanOrEqual(300);
    expect(summary.endsWith(long[9] ?? '')).toBe(true);
    expect(fallbackSummary('person', ['y'.repeat(500)])).toHaveLength(300);
  });

  it('una queja empieza por "Queja:"', () => {
    expect(fallbackSummary('complaint', ['El corte me lo hicieron mal'])).toBe(
      'Queja: El corte me lo hicieron mal',
    );
  });
});
