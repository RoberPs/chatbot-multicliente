/**
 * SC-008: toda petición de hablar con una persona tiene salida a una persona en la misma
 * respuesta (objetivo 100 %). Incluye expresiones que el detector no conoce y dependen del
 * modelo. Modelo real; se omite sin ANTHROPIC_API_KEY. `pnpm test:eval`.
 *
 * 005: sin vías de aviso el bot da el contacto de derivación, como en la 002; con vías (falsas
 * aquí), la petición termina en R-HANDOFF-OK o en R-HANDOFF-ASK (pide los datos para derivar).
 */
import { describeCriterion } from './criterion.js';

describeCriterion('SC-008', 'peticiones de hablar con una persona (sin vías de aviso)');

describeCriterion('SC-008', 'peticiones de hablar con una persona (con vías de aviso)', {
  handoffRoutes: true,
  reportAs: 'SC-008 (005, con vías)',
  judge: (answer) =>
    answer.template === 'R-HANDOFF-OK' || answer.template === 'R-HANDOFF-ASK'
      ? []
      : [`sin derivación (plantilla ${answer.template ?? 'ninguna'})`],
});
