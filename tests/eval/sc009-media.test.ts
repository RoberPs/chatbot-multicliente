/**
 * SC-009: todo mensaje de un tipo no atendido (imagen, sticker, vídeo, documento, o audio con
 * los audios apagados) recibe el aviso de tipos atendidos, y si trae pie se contesta además
 * (objetivo 100 %). Modelo real; se omite sin ANTHROPIC_API_KEY. `pnpm test:eval`.
 */
import { describeCriterion } from './criterion.js';
import { evalChannel } from './harness.js';

// La web solo admite texto (FR-020): con EVAL_CHANNEL=web este criterio no aplica.
describeCriterion('SC-009', 'tipos de mensaje no atendidos', { skip: evalChannel === 'web' });
