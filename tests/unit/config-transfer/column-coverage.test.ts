/**
 * Cobertura del formato del fichero (008, research R4): toda columna de las tablas de
 * configuración viaja en el fichero o está excluida a propósito. Si una migración añade una
 * columna de configuración, este test falla hasta que se trate en el formato.
 */
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { COLUMN_COVERAGE, EXCLUDED_COLUMNS } from '../../../src/config-transfer/format.js';
import * as schema from '../../../src/db/schema.js';

const CONFIG_TABLES = [
  'business',
  'business_hours',
  'closure',
  'service',
  'resource',
  'resource_service',
  'resource_hours',
  'resource_absence',
  'faq',
  'policies',
  'tone',
  'handoff_contact',
  'handoff_channel',
  'handoff_hours',
  'web_chat_settings',
  'handoff_alerts',
  'chat_design',
  'chat_design_image',
];

const tables = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => value instanceof PgTable)
  .map((table) => getTableConfig(table));

const REMINDER =
  'Columna de configuración sin tratar en el formato del fichero: sube CURRENT_FORMAT_VERSION ' +
  'en src/config-transfer/format.ts, añade su actualizador a UPDATERS y cúbrela en ' +
  'COLUMN_COVERAGE (o exclúyela en EXCLUDED_COLUMNS si no es configuración del negocio)';

describe('cobertura de columnas del formato (R4)', () => {
  it('todas las tablas de configuración existen en el esquema', () => {
    const names = tables.map((t) => t.name);
    for (const name of CONFIG_TABLES) expect(names).toContain(name);
  });

  it('cada columna de configuración está cubierta o excluida', () => {
    const untreated: string[] = [];
    for (const table of tables.filter((t) => CONFIG_TABLES.includes(t.name))) {
      const covered = Object.keys(COLUMN_COVERAGE[table.name] ?? {});
      const excluded = EXCLUDED_COLUMNS[table.name] ?? [];
      for (const column of table.columns) {
        if (!covered.includes(column.name) && !excluded.includes(column.name)) {
          untreated.push(`${table.name}.${column.name}`);
        }
      }
    }
    expect(untreated, REMINDER).toEqual([]);
  });

  it('el mapa no cita columnas que ya no existen', () => {
    const stale: string[] = [];
    for (const [tableName, columns] of Object.entries(COLUMN_COVERAGE)) {
      const table = tables.find((t) => t.name === tableName);
      const names = table?.columns.map((c) => c.name) ?? [];
      for (const column of [...Object.keys(columns), ...(EXCLUDED_COLUMNS[tableName] ?? [])]) {
        if (!names.includes(column)) stale.push(`${tableName}.${column}`);
      }
    }
    expect(stale).toEqual([]);
  });
});
