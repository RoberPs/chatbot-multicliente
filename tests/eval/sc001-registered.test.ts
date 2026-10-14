/**
 * SC-001: preguntas con dato registrado contestadas correctamente (objetivo 100 %):
 * horario, cierres, "abierto ahora", ubicación, servicios, FAQ, duraciones, políticas y
 * precios. Con los mismos resultados comprueba SC-010 (tres sectores, mismo comportamiento).
 * Modelo real; se omite sin la credencial del proveedor declarado. `pnpm test:eval`.
 */
import { describeCriterion } from './criterion.js';

describeCriterion('SC-001', 'preguntas con dato registrado', { compareSectors: true });
