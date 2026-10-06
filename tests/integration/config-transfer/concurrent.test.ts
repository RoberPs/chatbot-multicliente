/** FR-019: si la configuración cambia entre la vista previa y la confirmación, no se aplica nada. */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigChangedError } from '../../../src/config-transfer/errors.js';
import {
  applyImport,
  previewImport,
  type ImportPreview,
  type ImportSource,
} from '../../../src/config-transfer/service.js';
import { faq } from '../../../src/db/schema.js';
import { saveHandoffAlerts } from '../../../src/handoff/settings.js';
import { deactivateBusiness } from '../../../src/knowledge/services/business-status.js';
import { deleteFaq, updateFaq } from '../../../src/knowledge/services/faqs.js';
import { saveWebChatSettings } from '../../../src/webchat/settings.js';
import {
  configTablesFingerprint,
  importSource,
  loadFixture,
  seedFullBusiness,
} from '../../helpers/config-transfer.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

describe('cambio concurrente entre vista previa y confirmación (FR-019)', () => {
  let t: TestDatabase;
  let source: ImportSource;
  let preview: ImportPreview;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await seedFullBusiness(t.deps, { webChatEnabled: false });
    source = importSource(loadFixture('valid-full.json'));
    source.document.faqs.push({ question: '¿Nueva?', answer: 'Sí.' });
    preview = await previewImport(t.db, source, { includeAlerts: false, instanceId: null });
  });

  const firstFaqId = async () => (await t.db.select({ id: faq.id }).from(faq).orderBy(faq.sortOrder))[0]?.id ?? '';

  it.each([
    [
      'cambiar una pregunta',
      async () =>
        updateFaq(t.deps, await firstFaqId(), { question: '¿Hay aparcamiento?', answer: 'Ya no.' }),
    ],
    ['borrar una pregunta', async () => deleteFaq(t.deps, await firstFaqId())],
    ['cambiar el estado del negocio', async () => deactivateBusiness(t.db)],
    [
      'cambiar el chat web',
      async () =>
        saveWebChatSettings(t.db, {
          allowed_origins: 'https://www.example.com',
          privacy_url: 'https://www.example.com/privacidad',
          daily_cap: '150',
          monthly_cap: '3000',
        }),
    ],
    [
      'cambiar los destinos de los avisos',
      async () => saveHandoffAlerts(t.deps, { whatsapp: '+34600111000', email: '' }),
    ],
  ])('%s → ConfigChangedError sin cambiar nada', async (_name, change) => {
    await change();
    const fingerprint = await configTablesFingerprint(t.db);
    await expect(
      applyImport(t.db, source, {
        includeAlerts: false,
        instanceId: null,
        baseFingerprint: preview.baseFingerprint,
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(ConfigChangedError);
    expect(await configTablesFingerprint(t.db)).toBe(fingerprint);
    expect(await t.db.select().from(faq).where(eq(faq.question, '¿Nueva?'))).toEqual([]);
  });

  it('sin cambios entre medias, se aplica', async () => {
    await applyImport(t.db, source, {
      includeAlerts: false,
      instanceId: null,
      baseFingerprint: preview.baseFingerprint,
      now: new Date(),
    });
    expect(await t.db.select().from(faq).where(eq(faq.question, '¿Nueva?'))).toHaveLength(1);
  });
});
