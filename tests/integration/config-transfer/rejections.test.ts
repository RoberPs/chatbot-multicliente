/* eslint-disable @typescript-eslint/no-non-null-assertion -- los elementos existen por construcción del ejemplo; si no, el test debe fallar */
/**
 * SC-005 y US3-4: tras cualquier rechazo de la subida, la configuración, los avisos y la
 * configuración anterior guardada del destino son los mismos que antes.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withReadSnapshot } from '../../../src/db/client.js';
import { loadKnowledgeState } from '../../../src/knowledge/state.js';
import { computeWarnings } from '../../../src/knowledge/warnings.js';
import { buildTestApp, login, type Session } from '../../helpers/app.js';
import {
  configTablesFingerprint,
  fixtureJson,
  importSource,
  loadFixture,
  multipartBody,
  previewAndApply,
  seedFullBusiness,
} from '../../helpers/config-transfer.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

describe('rechazos de la subida sin cambios (SC-005)', () => {
  let t: TestDatabase;
  let app: FastifyInstance;
  let session: Session;

  beforeAll(async () => {
    t = await createTestDatabase();
    app = await buildTestApp(t.db);
    await seedFullBusiness(t.deps, { status: 'draft', webChatEnabled: false });
    // Con una configuración anterior ya guardada, que un rechazo tampoco debe tocar.
    await previewAndApply(t.db, importSource(loadFixture('valid-full.json')));
    session = await login(app);
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  const warnings = async () =>
    computeWarnings(await withReadSnapshot(t.db, (tx) => loadKnowledgeState(tx)));

  const invalid = () => {
    const f = fixtureJson('valid-full.json') as Record<string, Array<Record<string, unknown>>>;
    f.services![0]!.priceCents = -1;
    f.faqs = [];
    return Buffer.from(JSON.stringify(f));
  };

  it.each([
    ['ilegible', () => Buffer.from('{ esto no es json'), 422],
    ['versión futura', () => Buffer.from(JSON.stringify({ ...fixtureJson('valid-full.json'), formatVersion: 7 })), 422],
    ['inválido', invalid, 422],
    ['demasiado grande', () => Buffer.alloc(5 * 1024 * 1024 + 10, 0x20), 413],
  ])('%s', async (_name, file, status) => {
    const fingerprint = await configTablesFingerprint(t.db);
    const before = await warnings();
    const { payload, contentType } = multipartBody([
      { name: '_csrf', value: session.csrf },
      { name: 'file', value: file(), filename: 'configuracion.json' },
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/admin/config/import',
      headers: { cookie: session.cookie, 'content-type': contentType },
      payload,
    });
    expect(res.statusCode).toBe(status);
    expect(await configTablesFingerprint(t.db)).toBe(fingerprint);
    expect(await warnings()).toEqual(before);
  });
});
