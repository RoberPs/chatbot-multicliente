/**
 * SC-007 de la 005: con vías de aviso, toda consulta sin dato registrado (y toda gestión que no
 * se hace por este medio) termina en la OFERTA de derivación (objetivo 100 %), y la respuesta
 * del cliente a la oferta se clasifica bien: aceptar deriva (o pide los datos) y rechazar o
 * cambiar de tema no. Modelo real, vías falsas; se omite sin ANTHROPIC_API_KEY.
 * `pnpm test:eval`.
 */
import type { EvalAnswer, EvalQuestion, SectorQuestions } from './harness.js';
import { describeCriterion, sectors } from './criterion.js';

const OFFER_CATEGORIES = new Set(['sin-dato', 'insistencia', 'cita']);

const ACCEPTS = ['Sí, por favor', 'Vale, que me llamen', 'Venga, sí', 'Me parece bien'];
const REFUSES = ['No, gracias', 'No hace falta', 'Da igual, déjalo', '¿Y a qué hora abrís?'];

/** Las preguntas sin dato de cada sector, con otra respuesta del cliente detrás. */
function questionsFrom(
  make: (q: EvalQuestion, i: number) => EvalQuestion | EvalQuestion[],
): SectorQuestions[] {
  return sectors.map((sector) => ({
    ...sector,
    questions: sector.questions
      .filter((q) => q.criterion === 'SC-002' && OFFER_CATEGORIES.has(q.category))
      .flatMap(make),
  }));
}

const started = (a: EvalAnswer) => a.handoffAction === 'started' || a.handoffAction === 'asked';

describeCriterion('SC-002', 'consultas sin dato: la respuesta ofrece la derivación', {
  sectors: questionsFrom((q) => q),
  handoffRoutes: true,
  reportAs: 'SC-007 (005, oferta)',
  judge: (a) => (a.handoffAction === 'offered' ? [] : [`sin oferta (${a.handoffAction ?? '—'})`]),
});

describeCriterion('SC-002', 'el cliente acepta la oferta', {
  sectors: questionsFrom((q, i) => ({
    ...q,
    id: `${q.id}-acepta`,
    category: 'acepta',
    previous: [q.text],
    text: ACCEPTS[i % ACCEPTS.length] ?? 'Sí',
  })),
  handoffRoutes: true,
  reportAs: 'SC-007 (005, aceptaciones)',
  judge: (a) => (started(a) ? [] : [`no deriva (${a.handoffAction ?? '—'})`]),
});

describeCriterion('SC-002', 'el cliente rechaza la oferta o cambia de tema', {
  sectors: questionsFrom((q, i) => ({
    ...q,
    id: `${q.id}-rechaza`,
    category: 'rechaza',
    previous: [q.text],
    text: REFUSES[i % REFUSES.length] ?? 'No',
  })),
  handoffRoutes: true,
  reportAs: 'SC-007 (005, rechazos)',
  judge: (a) => (started(a) ? [`deriva sin aceptar (${a.handoffAction ?? '—'})`] : []),
});
