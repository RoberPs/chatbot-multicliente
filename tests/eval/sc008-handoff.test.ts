/**
 * SC-008: toda petición de hablar con una persona recibe el contacto en la misma respuesta
 * (objetivo 100 %). Incluye expresiones que el detector no conoce y dependen del modelo.
 * Modelo real; se omite sin ANTHROPIC_API_KEY. `pnpm test:eval`.
 */
import { describeCriterion } from './criterion.js';

describeCriterion('SC-008', 'peticiones de hablar con una persona');
