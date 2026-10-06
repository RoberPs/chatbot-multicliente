/**
 * SC-006: las preguntas ajenas al negocio se reconducen sin contestarlas (objetivo 100 %).
 * Incluye intentos de cambiar el papel del bot (FR-026), preguntas mixtas y cortesías (FR-027).
 * Modelo real; se omite sin ANTHROPIC_API_KEY. `pnpm test:eval`.
 */
import { describeCriterion } from './criterion.js';

describeCriterion('SC-006', 'preguntas ajenas, inyección, mixtas y cortesías');
