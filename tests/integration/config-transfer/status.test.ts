/**
 * SC-004 (FR-017): la importación nunca cambia el estado del negocio ni la activación del chat
 * web, ni nada fuera de la configuración (conversaciones, derivaciones en curso, uso).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfigInfo } from '../../../src/config-transfer/read.js';
import { withReadSnapshot } from '../../../src/db/client.js';
import {
  fixtureJson,
  importSource,
  previewAndApply,
  seedCustomerData,
  seedFullBusiness,
} from '../../helpers/config-transfer.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

/** Todas las filas de las tablas de clientes finales, conversaciones, derivaciones y uso. */
async function customerTables(t: TestDatabase): Promise<string> {
  const parts: string[] = [];
  for (const table of ['customer', 'conversation', 'message', 'handoff', 'handoff_notice', 'web_usage_day']) {
    const r = await t.db.execute<{ rows: string }>(
      sql`select coalesce(json_agg(x order by x::text), '[]')::text as rows from ${sql.identifier(table)} x`,
    );
    parts.push(`${table}:${r.rows[0]?.rows ?? ''}`);
  }
  return parts.join('\n');
}

/** `valid-full.json` con el estado informativo indicado. */
function file(businessStatus: 'draft' | 'active', webChatEnabled: boolean): Buffer {
  const f = fixtureJson('valid-full.json');
  f.info = { businessStatus, webChatEnabled };
  return Buffer.from(JSON.stringify(f));
}

describe('estado del negocio y del chat web (SC-004)', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });

  it.each([
    ['en preparación ← fichero de activo, chat desactivado ← activado', 'draft', false, 'active', true],
    ['activo ← fichero en preparación, chat activado ← desactivado', 'active', true, 'draft', false],
  ] as const)('%s', async (_name, status, webChatEnabled, fileStatus, fileWebChat) => {
    await seedFullBusiness(t.deps, { status, webChatEnabled });
    await seedCustomerData(t.db);
    const before = await withReadSnapshot(t.db, readConfigInfo);
    const customers = await customerTables(t);

    const source = importSource(file(fileStatus, fileWebChat));
    source.document.faqs.push({ question: '¿Algo nuevo?', answer: 'Sí.' });
    await previewAndApply(t.db, source);

    expect(await withReadSnapshot(t.db, readConfigInfo)).toEqual(before);
    expect(before).toEqual({ businessStatus: status, webChatEnabled });
    expect(await customerTables(t)).toBe(customers);
  });
});
