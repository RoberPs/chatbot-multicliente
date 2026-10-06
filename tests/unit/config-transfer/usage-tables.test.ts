/**
 * El consumo y la protección frente a abuso no son configuración del negocio (010 FR-024, R15;
 * 012 FR-036): sus tablas no están en el formato del fichero de la 008 y el formato no cambia de
 * versión. Que una exportación real no
 * lleve precios, moneda ni tope lo comprueba tests/integration/config-transfer/privacy.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  COLUMN_COVERAGE,
  CURRENT_FORMAT_VERSION,
  EXCLUDED_COLUMNS,
  UPDATERS,
} from '../../../src/config-transfer/format.js';

const USAGE_TABLES = [
  'model_usage',
  'model_price',
  'usage_settings',
  // 012
  'transcription_price',
  'whatsapp_usage_day',
  'handoff_limits',
  'handoff_day',
];

describe('tablas de consumo fuera del formato de la 008', () => {
  it('no están cubiertas ni excluidas: no son tablas de configuración', () => {
    for (const table of USAGE_TABLES) {
      expect(COLUMN_COVERAGE, table).not.toHaveProperty(table);
      expect(EXCLUDED_COLUMNS, table).not.toHaveProperty(table);
    }
  });

  it('formatVersion no cambia con la 010 ni con la 012 (la 2 es la del diseño del chat de la 011)', () => {
    expect(CURRENT_FORMAT_VERSION).toBe(2);
    expect(Object.keys(UPDATERS)).toEqual(['1']);
  });
});
