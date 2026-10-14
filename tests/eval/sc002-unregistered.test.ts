/**
 * SC-002: preguntas sin dato registrado (objetivo: 0 % con cifras, 100 % con contacto):
 * precios "a consultar" o sin importe (US2), servicios o datos que no existen, insistencia y
 * peticiones de cita (US3). Al menos 30 preguntas entre los tres sectores.
 * Modelo real; se omite sin la credencial del proveedor declarado. `pnpm test:eval`.
 */
import { describeCriterion } from './criterion.js';

describeCriterion('SC-002', 'preguntas sin dato registrado');
