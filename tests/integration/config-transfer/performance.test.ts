/**
 * SC-007 (research R13): con 200 servicios, 50 recursos (~10 franjas y ~20 servicios cada uno)
 * y 200 preguntas, la vista previa y la aplicación tardan menos de 5 s cada una (objetivo
 * interno < 1 s) y la exportación menos de 1 s.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyImport,
  exportConfig,
  previewImport,
  type ImportSource,
} from '../../../src/config-transfer/service.js';
import {
  buildLargeDocument,
  fileFromDocument,
  importSource,
  seedFullBusiness,
} from '../../helpers/config-transfer.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

async function time<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

describe('rendimiento de la importación (SC-007)', () => {
  let t: TestDatabase;
  let source: ImportSource;

  beforeAll(async () => {
    t = await createTestDatabase();
    await seedFullBusiness(t.deps, { status: 'draft', webChatEnabled: false });
    source = importSource(fileFromDocument(buildLargeDocument({ services: 200, resources: 50, faqs: 200 })));
  });
  afterAll(async () => {
    await t.close();
  });

  it('vista previa y aplicación < 5 s; exportación < 1 s', async () => {
    const options = { includeAlerts: false, instanceId: null };
    const preview = await time(() => previewImport(t.db, source, options));
    const apply = await time(() =>
      applyImport(t.db, source, {
        ...options,
        baseFingerprint: preview.value.baseFingerprint,
        now: new Date(),
      }),
    );
    const exported = await time(() =>
      exportConfig(t.db, { includeAlerts: true, instanceId: null, now: new Date() }),
    );
    // Segunda importación del mismo fichero: el caso de "sin cambios" también debe ser rápido.
    const again = await time(() => previewImport(t.db, source, options));

    console.info(
      `SC-007: vista previa ${preview.ms.toFixed(0)} ms · aplicación ${apply.ms.toFixed(0)} ms · ` +
        `exportación ${exported.ms.toFixed(0)} ms · vista previa sin cambios ${again.ms.toFixed(0)} ms`,
    );
    expect(exported.value.counts).toMatchObject({ services: 200, resources: 50, faqs: 200 });
    expect(again.value.sections).toEqual([]);
    expect(preview.ms).toBeLessThan(5000);
    expect(apply.ms).toBeLessThan(5000);
    expect(exported.ms).toBeLessThan(1000);
  });
});
