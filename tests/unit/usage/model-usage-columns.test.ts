/**
 * `model_usage` no guarda conversación, cliente, textos ni IP (010, FR-003): solo las columnas
 * permitidas y ninguna clave ajena. Si una feature necesita otra columna, tiene que cambiar esta
 * lista a propósito.
 */
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { modelUsage } from '../../../src/db/schema.js';

const ALLOWED = [
  'id',
  'at',
  'day',
  'channel',
  'purpose',
  'model',
  'calls',
  'input_tokens',
  'output_tokens',
  'cache_write_tokens',
  'cache_read_tokens',
  'cost_pico',
  'currency',
];

describe('columnas de model_usage (FR-003)', () => {
  const config = getTableConfig(modelUsage);

  it('solo tiene las columnas permitidas', () => {
    const columns = config.columns.map((c) => c.name);
    expect(columns.filter((c) => !ALLOWED.includes(c))).toEqual([]);
    expect([...columns].sort()).toEqual([...ALLOWED].sort());
  });

  it('no tiene claves ajenas', () => {
    expect(config.foreignKeys).toEqual([]);
  });
});
