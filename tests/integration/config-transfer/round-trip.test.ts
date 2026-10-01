/**
 * SC-001 (exportar de una instancia e importar en otra deja la misma vista del bot) y SC-002
 * (exportar e importar en la misma instancia no cambia nada).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportConfig, previewImport } from '../../../src/config-transfer/service.js';
import { activateBusiness } from '../../../src/knowledge/services/business-status.js';
import { createKnowledgeReader } from '../../../src/knowledge/snapshot.js';
import type { KnowledgeSnapshot } from '../../../src/knowledge/types.js';
import {
  configTablesFingerprint,
  importSource,
  loadFixture,
  previewAndApply,
  seedFullBusiness,
} from '../../helpers/config-transfer.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

/** Snapshot sin identificadores ni marcas de tiempo: lo que el bot usa para responder. */
function comparable(snapshot: KnowledgeSnapshot) {
  const names = new Map(snapshot.services.map((s) => [s.id, s.name]));
  const scheduling =
    snapshot.scheduling.mode === 'resources'
      ? {
          mode: 'resources',
          resources: snapshot.scheduling.resources.map(({ id: _id, serviceIds, ...r }) => ({
            ...r,
            services: serviceIds.map((id) => names.get(id)),
          })),
        }
      : snapshot.scheduling;
  const resourceNames =
    snapshot.scheduling.mode === 'resources'
      ? new Map(snapshot.scheduling.resources.map((r) => [r.id, r.name]))
      : new Map<string, string>();
  return {
    ...snapshot,
    updatedAt: 'x',
    services: snapshot.services.map(({ id: _id, resourceIds, ...s }) => ({
      ...s,
      resources: resourceIds.map((id) => resourceNames.get(id)),
    })),
    scheduling,
  };
}

describe('ida y vuelta de la configuración', () => {
  let origin: TestDatabase;
  let target: TestDatabase;
  const now = new Date('2026-09-30T10:00:00.000Z');

  beforeAll(async () => {
    origin = await createTestDatabase();
    target = await createTestDatabase();
  });
  afterAll(async () => {
    await origin.close();
    await target.close();
  });

  it('SC-001: la instancia vacía queda con la misma vista del bot que la de origen', async () => {
    await seedFullBusiness(origin.deps);
    await resetDb(target.db);
    const { content } = await exportConfig(origin.db, { includeAlerts: false, instanceId: 'pruebas-01', now });
    await previewAndApply(target.db, importSource(Buffer.from(content)), { instanceId: 'produccion-01' });
    // La importación no activa el negocio (FR-017): el operador lo activa después.
    await activateBusiness(target.db);

    const a = await createKnowledgeReader(origin.db).getSnapshot();
    const b = await createKnowledgeReader(target.db).getSnapshot();
    expect(comparable(b)).toEqual(comparable(a));
  });

  it('SC-002: exportar e importar en la misma instancia da una vista previa sin cambios', async () => {
    await seedFullBusiness(origin.deps, { alerts: { whatsapp: '+34600123456', email: null } });
    const { content } = await exportConfig(origin.db, { includeAlerts: true, instanceId: 'pruebas-01', now });
    const source = importSource(Buffer.from(content));

    const preview = await previewImport(origin.db, source, {
      includeAlerts: true,
      instanceId: 'pruebas-01',
    });
    expect(preview.sections).toEqual([]);
    expect(preview.highlights.sameInstance).toBe(true);
    expect(preview.outcome).toBe('will_apply');

    const fingerprint = await configTablesFingerprint(origin.db, { exclude: ['config_pre_import'] });
    await previewAndApply(origin.db, source, { includeAlerts: true, instanceId: 'pruebas-01' });
    expect(await configTablesFingerprint(origin.db, { exclude: ['config_pre_import'] })).toBe(
      fingerprint,
    );
  });

  it('importar valid-empty.json elimina todo lo del destino (listas vacías)', async () => {
    await seedFullBusiness(target.deps, { status: 'draft', webChatEnabled: false });
    const { preview } = await previewAndApply(target.db, importSource(loadFixture('valid-empty.json')));
    expect(preview.sections.find((s) => s.section === 'services')?.removed).toEqual([
      { label: 'Servicio A' },
      { label: 'Servicio B' },
    ]);
    const snapshot = await createKnowledgeReader(target.db).getSnapshot();
    expect(snapshot.services).toEqual([]);
    expect(snapshot.faqs).toEqual([]);
    expect(snapshot.openingHours).toEqual([]);
    expect(snapshot.business.name).toBe('');
  });
});
