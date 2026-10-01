/**
 * Aplicación todo o nada con la configuración anterior guardada (FR-015, FR-020 – FR-022,
 * SC-005).
 */
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readConfigDocument } from '../../../src/config-transfer/read.js';
import {
  applyImport,
  previewImport,
  readPreImport,
} from '../../../src/config-transfer/service.js';
import { withReadSnapshot } from '../../../src/db/client.js';
import {
  configTablesFingerprint,
  FULL_ALERTS,
  importSource,
  loadFixture,
  previewAndApply,
  seedFullBusiness,
} from '../../helpers/config-transfer.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

describe('aplicar una importación', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(async () => {
    await t.db.execute(sql`drop trigger if exists fallo_a_mitad on faq`);
    await t.db.execute(sql`drop function if exists fallo_a_mitad()`);
  });

  const current = () => withReadSnapshot(t.db, (tx) => readConfigDocument(tx, { includeAlerts: true }));

  /**
   * Un negocio en preparación distinto del fichero: otro nombre, sin preguntas y con destinos
   * propios (en preparación, para poder importar también el fichero vacío).
   */
  async function seedDifferent() {
    await seedFullBusiness(t.deps, {
      status: 'draft',
      webChatEnabled: false,
      alerts: { whatsapp: '+34600999000', email: 'antes@example.com' },
    });
    await t.db.execute(sql`update business set name = 'Negocio anterior'`);
    await t.db.execute(sql`delete from faq`);
  }

  it('guarda la configuración anterior con destinos, hora y origen; la siguiente la sustituye', async () => {
    await seedDifferent();
    const before = await current();
    const first = new Date('2026-09-30T11:00:00.000Z');
    const source = importSource(loadFixture('valid-full.json'));
    const { result } = await previewAndApply(t.db, source, { now: first });

    const copy = await readPreImport(t.db);
    expect(copy?.importedAt.toISOString()).toBe(first.toISOString());
    expect(copy?.sourceInstance).toBe('demo-01');
    const saved = importSource(Buffer.from(copy?.content ?? ''));
    expect(saved.envelope.includesAlertDestinations).toBe(true);
    expect(saved.document).toEqual(before);

    // El resultado trae el diff aplicado y los avisos vigentes.
    expect(result.sections.find((s) => s.section === 'faqs')?.added).toHaveLength(2);
    expect(result.sections.find((s) => s.section === 'business')?.modified[0]?.fields[0]).toMatchObject({
      field: 'name',
      before: 'Negocio anterior',
      after: 'Negocio de ejemplo',
    });
    expect(Array.isArray(result.warnings)).toBe(true);

    const second = new Date('2026-09-30T12:00:00.000Z');
    await previewAndApply(t.db, importSource(loadFixture('valid-empty.json')), { now: second });
    const next = await readPreImport(t.db);
    expect(next?.importedAt.toISOString()).toBe(second.toISOString());
    expect(next?.sourceInstance).toBeNull();
    expect(importSource(Buffer.from(next?.content ?? '')).document.faqs).toHaveLength(2);
  });

  it('SC-005: un fallo a mitad no deja nada aplicado ni sustituye la copia anterior', async () => {
    await seedDifferent();
    await previewAndApply(t.db, importSource(loadFixture('valid-empty.json')));
    const copyBefore = await readPreImport(t.db);
    const fingerprint = await configTablesFingerprint(t.db);

    // Las preguntas se escriben después de servicios y recursos.
    await t.db.execute(sql`create function fallo_a_mitad() returns trigger as $$
      begin raise exception 'fallo inyectado'; end $$ language plpgsql`);
    await t.db.execute(sql`create trigger fallo_a_mitad before insert on faq
      for each row execute function fallo_a_mitad()`);

    const source = importSource(loadFixture('valid-full.json'));
    const preview = await previewImport(t.db, source, { includeAlerts: false, instanceId: null }).catch(
      () => null,
    );
    // El ensayo también choca con el fallo; se confirma con la huella calculada a mano.
    expect(preview).toBeNull();
    const base = await previewImportFingerprint();
    await expect(
      applyImport(t.db, source, { includeAlerts: false, instanceId: null, baseFingerprint: base, now: new Date() }),
    ).rejects.toThrow();
    expect(await configTablesFingerprint(t.db)).toBe(fingerprint);
    expect(await readPreImport(t.db)).toEqual(copyBefore);
  });

  /** Huella de la configuración actual sin pasar por el ensayo (que falla con el trigger). */
  async function previewImportFingerprint(): Promise<string> {
    await t.db.execute(sql`alter table faq disable trigger fallo_a_mitad`);
    try {
      const preview = await previewImport(t.db, importSource(loadFixture('valid-full.json')), {
        includeAlerts: false,
        instanceId: null,
      });
      return preview.baseFingerprint;
    } finally {
      await t.db.execute(sql`alter table faq enable trigger fallo_a_mitad`);
    }
  }

  it('importar la configuración anterior con destinos deja todo como antes (US2-9)', async () => {
    await seedDifferent();
    const original = await current();
    await previewAndApply(t.db, importSource(loadFixture('valid-full-with-alerts.json')), {
      includeAlerts: true,
    });
    expect((await current()).alertDestinations).toEqual(FULL_ALERTS);

    const copy = await readPreImport(t.db);
    await previewAndApply(t.db, importSource(Buffer.from(copy?.content ?? '')), { includeAlerts: true });
    expect(await current()).toEqual(original);
  });
});
