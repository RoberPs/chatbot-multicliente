/**
 * El consumo no es configuración del negocio (010, FR-024, R15): sus tablas no están en el
 * formato del fichero de la 008 y el formato no cambia de versión. Que una exportación real no
 * lleve precios, moneda ni tope lo comprueba tests/integration/config-transfer/privacy.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  COLUMN_COVERAGE,
  CURRENT_FORMAT_VERSION,
  EXCLUDED_COLUMNS,
  UPDATERS,
} from '../../../src/config-transfer/format.js';

const USAGE_TABLES = ['model_usage', 'model_price', 'usage_settings'];

describe('tablas de consumo fuera del formato de la 008', () => {
  it('no están cubiertas ni excluidas: no son tablas de configuración', () => {
    for (const table of USAGE_TABLES) {
      expect(COLUMN_COVERAGE, table).not.toHaveProperty(table);
      expect(EXCLUDED_COLUMNS, table).not.toHaveProperty(table);
    }
  });

  it('formatVersion no cambia con la 010', () => {
    expect(CURRENT_FORMAT_VERSION).toBe(1);
    expect(Object.keys(UPDATERS)).toEqual([]);
  });
});
