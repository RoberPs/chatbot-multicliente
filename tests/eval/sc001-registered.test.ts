/**
 * SC-001: preguntas con dato registrado contestadas correctamente (objetivo 100 %):
 * horario, cierres, "abierto ahora", ubicación, servicios, FAQ y precios.
 * Modelo real; se omite sin ANTHROPIC_API_KEY. `pnpm test:eval`.
 */
import { describeCriterion } from './criterion.js';

describeCriterion('SC-001', 'preguntas con dato registrado');
