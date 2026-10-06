/**
 * Coste lineal de la validación de la importación (012, US6, FR-030): con el doble de errores
 * repetidos y de elementos, la eliminación de repetidos y el orden en el fichero no tardan más del
 * doble (con margen). Antes eran cuadráticos (`findIndex` e `indexOf` por comparación).
 */
import { describe, expect, it } from 'vitest';
import { validateConfigFile } from '../../../src/config-transfer/parse.js';

/** Fichero con `n` servicios, todos con los mismos tres errores. */
function broken(n: number): Record<string, unknown> {
  return {
    format: 'business-config',
    formatVersion: 1,
    services: Array.from({ length: n }, () => ({ nombre: 'x', precio: 'y', otra: 'z' })),
    faqs: Array.from({ length: n }, () => ({ pregunta: 'x' })),
  };
}

function time(fn: () => void): number {
  // La mejor de tres: menos ruido de la máquina.
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    fn();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

describe('coste lineal de la validación', () => {
  it('el doble de elementos con errores no tarda más del doble (margen ×3)', () => {
    // Calentamiento del esquema.
    validateConfigFile(broken(50), 'ES');
    const small = time(() => validateConfigFile(broken(250), 'ES'));
    const large = time(() => validateConfigFile(broken(500), 'ES'));
    expect(large).toBeLessThan(Math.max(small, 5) * 3);
  });
});
