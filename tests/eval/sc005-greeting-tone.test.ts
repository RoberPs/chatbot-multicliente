/**
 * SC-005: el saludo aparece solo en la primera respuesta de cada conversación y se respeta la
 * forma de trato registrada (tú en la peluquería y el taller, usted en la clínica).
 * Modelo real; se omite sin la credencial del proveedor declarado. `pnpm test:eval`.
 */
import { describeCriterion } from './criterion.js';

describeCriterion('SC-005', 'saludo al inicio y forma de trato');
