/* eslint-disable @typescript-eslint/no-non-null-assertion -- los elementos existen por construcción del ejemplo; si no, el test debe fallar */
/**
 * FR-018: en un negocio activo, una importación que lo dejaría con un aviso crítico se
 * rechaza sin cambiar nada; igual con el chat web activado y sin webs o sin enlace de
 * privacidad. Los avisos de la vista previa y del resultado son los del panel (FR-012).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebChatWouldBreakError } from '../../../src/config-transfer/errors.js';
import { applyImport, previewImport } from '../../../src/config-transfer/service.js';
import { withReadSnapshot } from '../../../src/db/client.js';
import { CriticalWarningError } from '../../../src/knowledge/errors.js';
import { loadKnowledgeState } from '../../../src/knowledge/state.js';
import { computeWarnings } from '../../../src/knowledge/warnings.js';
import {
  configTablesFingerprint,
  fixtureJson,
  importSource,
  loadFixture,
  previewAndApply,
  seedFullBusiness,
} from '../../helpers/config-transfer.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

/** `valid-full.json` sin teléfono del negocio ni contacto de derivación. */
function unreachable(): Buffer {
  const f = fixtureJson('valid-full.json') as Record<string, Record<string, unknown>>;
  f.business!.phone = null;
  (f as Record<string, unknown>).handoff = null;
  return Buffer.from(JSON.stringify(f));
}

const now = new Date('2026-09-30T11:00:00.000Z');

describe('avisos críticos y chat web (FR-018)', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });

  it('negocio activo + fichero sin salida a una persona: vista previa blocked_critical y rechazo', async () => {
    await seedFullBusiness(t.deps, { webChatEnabled: false });
    const source = importSource(unreachable());
    const preview = await previewImport(t.db, source, { includeAlerts: false, instanceId: null });
    expect(preview.outcome).toBe('blocked_critical');
    expect(preview.warnings.map((w) => w.code)).toContain('HANDOFF_UNREACHABLE');

    const fingerprint = await configTablesFingerprint(t.db);
    await expect(
      applyImport(t.db, source, {
        includeAlerts: false,
        instanceId: null,
        baseFingerprint: preview.baseFingerprint,
        now,
      }),
    ).rejects.toBeInstanceOf(CriticalWarningError);
    expect(await configTablesFingerprint(t.db)).toBe(fingerprint);
  });

  it('el mismo fichero en un negocio en preparación se aplica', async () => {
    await seedFullBusiness(t.deps, { status: 'draft', webChatEnabled: false });
    const { preview, result } = await previewAndApply(t.db, importSource(unreachable()));
    expect(preview.outcome).toBe('will_apply');
    expect(result.warnings.map((w) => w.code)).toContain('HANDOFF_UNREACHABLE');
  });

  type File = Record<string, Record<string, unknown>>;
  const cases: Array<[string, (f: File) => void, 'origins' | 'privacyUrl']> = [
    ['sin webs permitidas', (f) => void (f.webChat!.allowedOrigins = []), 'origins'],
    ['sin enlace de privacidad', (f) => void (f.webChat!.privacyUrl = null), 'privacyUrl'],
  ];
  it.each(cases)('chat web activado + fichero %s: blocked_web_chat y rechazo', async (_name, change, missing) => {
    await seedFullBusiness(t.deps, { webChatEnabled: true });
    const f = fixtureJson('valid-full.json') as Record<string, Record<string, unknown>>;
    change(f);
    const source = importSource(Buffer.from(JSON.stringify(f)));
    const preview = await previewImport(t.db, source, { includeAlerts: false, instanceId: null });
    expect(preview).toMatchObject({ outcome: 'blocked_web_chat', webChatMissing: missing });

    const fingerprint = await configTablesFingerprint(t.db);
    const error = await applyImport(t.db, source, {
      includeAlerts: false,
      instanceId: null,
      baseFingerprint: preview.baseFingerprint,
      now,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebChatWouldBreakError);
    expect((error as WebChatWouldBreakError).missing).toBe(missing);
    expect(await configTablesFingerprint(t.db)).toBe(fingerprint);
  });

  it('destinos importados en una instancia sin vías: mismos avisos que el panel y se aplica', async () => {
    await seedFullBusiness(t.deps, { webChatEnabled: false });
    const alertRoutes = { whatsapp: false, email: false };
    const { preview, result } = await previewAndApply(
      t.db,
      importSource(loadFixture('valid-full-with-alerts.json')),
      { includeAlerts: true, alertRoutes },
    );
    const panel = computeWarnings(
      await withReadSnapshot(t.db, (tx) => loadKnowledgeState(tx, { alertRoutes })),
    );
    expect(preview.outcome).toBe('will_apply');
    expect(preview.warnings).toEqual(panel);
    expect(result.warnings).toEqual(panel);
    expect(panel.map((w) => w.code)).toContain('HANDOFF_ALERTS_NONE');
    // Con las vías disponibles, el mismo destino ya no da ese aviso.
    const withRoutes = await previewImport(t.db, importSource(loadFixture('valid-full-with-alerts.json')), {
      includeAlerts: true,
      instanceId: null,
      alertRoutes: { whatsapp: true, email: true },
    });
    expect(withRoutes.warnings.map((w) => w.code)).not.toContain('HANDOFF_ALERTS_NONE');
  });
});
