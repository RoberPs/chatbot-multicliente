/* eslint-disable @typescript-eslint/no-non-null-assertion -- los elementos existen por construcción del ejemplo; si no, el test debe fallar */
/** Reemplazo de la configuración conservando los UUID emparejados (008, research R7). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withReadSnapshot, withTransaction } from '../../../src/db/client.js';
import type { ConfigDocument } from '../../../src/config-transfer/format.js';
import { readConfigDocument, readConfigInfo } from '../../../src/config-transfer/read.js';
import { replaceConfig } from '../../../src/config-transfer/replace.js';
import { readHandoffAlerts } from '../../../src/handoff/settings.js';
import { loadKnowledgeState } from '../../../src/knowledge/state.js';
import type { KnowledgeState } from '../../../src/knowledge/types.js';
import {
  configTablesFingerprint,
  FULL_ALERTS,
  importSource,
  loadFixture,
  seedFullBusiness,
} from '../../helpers/config-transfer.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

describe('replaceConfig', () => {
  let t: TestDatabase;
  const full = () => structuredClone(importSource(loadFixture('valid-full.json')).document);
  const withAlerts = () =>
    structuredClone(importSource(loadFixture('valid-full-with-alerts.json')).document);

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await seedFullBusiness(t.deps, { alerts: { whatsapp: '+34600999000', email: null } });
  });

  const state = (): Promise<KnowledgeState> => withReadSnapshot(t.db, (tx) => loadKnowledgeState(tx));
  const replace = (doc: ConfigDocument, importAlerts = false) =>
    withTransaction(t.db, (tx) => replaceConfig(tx, doc, { importAlerts }));
  const read = () => withReadSnapshot(t.db, (tx) => readConfigDocument(tx, { includeAlerts: false }));

  it('conserva el UUID de los emparejados, borra los ausentes e inserta los nuevos', async () => {
    const before = await state();
    const doc = full();
    doc.services[0]!.name = 'SERVICIO A'; // mismo servicio: cambia solo de mayúsculas
    doc.services[0]!.priceCents = 3000;
    doc.services.splice(1, 1, { ...doc.services[0]!, name: 'Servicio C', priceCents: 100 });
    doc.faqs[1]!.answer = 'Solo en efectivo.';
    doc.faqs.unshift({ question: '¿Nueva pregunta?', answer: 'Nueva respuesta.' });
    doc.resources[0]!.services = ['servicio a', 'Servicio C'];
    await replace(doc);

    const after = await state();
    const a = before.services.find((s) => s.name === 'Servicio A');
    expect(after.services.map((s) => [s.name, s.sortOrder])).toEqual([
      ['SERVICIO A', 0],
      ['Servicio C', 1],
    ]);
    expect(after.services[0]?.id).toBe(a?.id);
    expect(after.services[0]?.priceCents).toBe(3000);
    expect(after.services.some((s) => s.name === 'Servicio B')).toBe(false);
    expect(after.resources[0]?.id).toBe(before.resources[0]?.id);
    expect(after.resources[0]?.serviceIds).toEqual([a?.id, after.services[1]?.id]);
    expect(after.faqs.map((f) => f.question)).toEqual([
      '¿Nueva pregunta?',
      '¿Hay aparcamiento?',
      '¿Se puede pagar con tarjeta?',
    ]);
    expect(after.faqs[2]?.id).toBe(before.faqs[1]?.id);
    expect(after.faqs[2]?.answer).toBe('Solo en efectivo.');
  });

  it('sustituye enlaces, franjas, ausencias, horario, cierres y medios', async () => {
    const doc = full();
    doc.openingHours = [{ weekday: 3, start: '08:00', end: '12:00' }];
    doc.closures = [];
    doc.resources[0]!.hours = [{ weekday: 3, start: '08:00', end: '10:00' }];
    doc.resources[0]!.absences = [];
    doc.handoff = { channels: [{ type: 'whatsapp', value: '+34600123456' }], hours: [] };
    await replace(doc);
    expect(await read()).toEqual(doc);
  });

  it('null en policies, tone y handoff borra su fila', async () => {
    const doc = full();
    doc.policies = null;
    doc.tone = null;
    doc.handoff = null;
    await replace(doc);
    const after = await state();
    expect(after.policies).toBeNull();
    expect(after.tone).toBeNull();
    expect(after.handoff).toBeNull();
  });

  it('no cambia el estado del negocio ni la activación del chat web', async () => {
    const info = await withReadSnapshot(t.db, readConfigInfo);
    const doc = full();
    doc.webChat.allowedOrigins = ['https://otra.example.com'];
    await replace(doc);
    expect(await withReadSnapshot(t.db, readConfigInfo)).toEqual(info);
    expect((await read()).webChat.allowedOrigins).toEqual(['https://otra.example.com']);
  });

  it('handoff_alerts solo cambia con importAlerts y destinos en el documento', async () => {
    const current = { whatsapp: '+34600999000', email: null };
    await replace(withAlerts(), false);
    expect(await readHandoffAlerts(t.db)).toEqual(current);
    await replace(full(), true);
    expect(await readHandoffAlerts(t.db)).toEqual(current);
    await replace(withAlerts(), true);
    expect(await readHandoffAlerts(t.db)).toEqual(FULL_ALERTS);
  });

  it('con el mismo documento no cambia ningún updated_at', async () => {
    const fingerprint = await configTablesFingerprint(t.db);
    await replace(full());
    expect(await configTablesFingerprint(t.db)).toBe(fingerprint);
  });

  it('intercambiar nombres y órdenes no choca con los índices únicos', async () => {
    const doc = full();
    doc.services = [
      { ...doc.services[1]!, name: 'servicio a' },
      { ...doc.services[0]!, name: 'Servicio  B' },
      { ...doc.services[0]!, name: 'Servicio B' },
    ];
    doc.resources = [
      { ...doc.resources[0]!, name: 'Recurso 2', services: ['Servicio B'] },
      { ...doc.resources[0]!, name: 'recurso 1', services: ['servicio a'] },
    ];
    await replace(doc);
    const after = await state();
    expect(after.services.map((s) => s.name)).toEqual(['servicio a', 'Servicio  B', 'Servicio B']);
    expect(after.resources.map((r) => r.name)).toEqual(['Recurso 2', 'recurso 1']);
  });
});
