/* eslint-disable @typescript-eslint/no-dynamic-delete -- se borra una clave del JSON de ejemplo a propósito */
/** Estado de la BD → documento del formato (008, data-model §1). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withReadSnapshot } from '../../../src/db/client.js';
import { readConfigDocument, readConfigInfo } from '../../../src/config-transfer/read.js';
import { FULL_ALERTS, fixtureJson, seedFullBusiness } from '../../helpers/config-transfer.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

const ENVELOPE_KEYS = [
  'format',
  'formatVersion',
  'exportedAt',
  'source',
  'includesAlertDestinations',
  'info',
];

/** Secciones de un fichero de ejemplo, sin el sobre. */
function sectionsOf(name: string): Record<string, unknown> {
  const file = fixtureJson(name);
  for (const key of ENVELOPE_KEYS) delete file[key];
  return file;
}

describe('readConfigDocument', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });

  const read = (includeAlerts: boolean) =>
    withReadSnapshot(t.db, (tx) => readConfigDocument(tx, { includeAlerts }));

  it('el negocio completo se lee igual que valid-full.json salvo el sobre, en el mismo orden', async () => {
    await seedFullBusiness(t.deps);
    const doc = await read(false);
    expect(doc).toEqual(sectionsOf('valid-full.json'));
    // Mismo orden de claves y de listas que el fichero.
    expect(JSON.stringify(doc)).toBe(JSON.stringify(sectionsOf('valid-full.json')));
  });

  it('las listas siguen sort_order y las franjas día → inicio; los recursos citan servicios por nombre', async () => {
    await seedFullBusiness(t.deps);
    const doc = await read(false);
    expect(doc.services.map((s) => s.name)).toEqual(['Servicio A', 'Servicio B']);
    expect(doc.faqs.map((f) => f.question)).toEqual([
      '¿Hay aparcamiento?',
      '¿Se puede pagar con tarjeta?',
    ]);
    expect(doc.openingHours.map((h) => `${h.weekday} ${h.start}`)).toEqual([
      '1 09:00',
      '1 16:00',
      '2 09:00',
      '6 10:00',
    ]);
    expect(doc.resources[0]?.services).toEqual(['Servicio A']);
  });

  it('includeAlerts añade alertDestinations; readConfigInfo da estado y chat web', async () => {
    await seedFullBusiness(t.deps, { alerts: FULL_ALERTS, webChatEnabled: false, status: 'draft' });
    const doc = await read(true);
    expect(doc.alertDestinations).toEqual(FULL_ALERTS);
    expect(await withReadSnapshot(t.db, readConfigInfo)).toEqual({
      businessStatus: 'draft',
      webChatEnabled: false,
    });
  });

  it('una BD recién migrada equivale a valid-empty.json', async () => {
    await resetDb(t.db);
    expect(await read(false)).toEqual(sectionsOf('valid-empty.json'));
    expect(await read(true)).toMatchObject({ alertDestinations: { whatsapp: null, email: null } });
  });
});
