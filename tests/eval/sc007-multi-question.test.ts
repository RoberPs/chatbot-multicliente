/**
 * SC-007: en un mensaje con varias preguntas, todas reciben respuesta o declaración de falta
 * de información, con una sola oferta de contacto (objetivo 100 %).
 * Modelo real; se omite sin ANTHROPIC_API_KEY. `pnpm test:eval`.
 */
import { describeCriterion } from './criterion.js';

describeCriterion('SC-007', 'varias preguntas en un mensaje');
