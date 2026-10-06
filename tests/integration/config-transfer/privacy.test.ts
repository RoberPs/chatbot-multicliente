/**
 * SC-003 (FR-004, FR-005): la exportación no contiene ningún dato de clientes finales, ni uso
 * del chat web, ni secretos de la instancia; los destinos de avisos solo con la casilla.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfigFile } from '../../../src/config-transfer/parse.js';
import { exportConfig } from '../../../src/config-transfer/service.js';
import { modelPrice, usageSettings } from '../../../src/db/schema.js';
import { TEST_SESSION_SECRET } from '../../helpers/app.js';
import {
  FULL_ALERTS,
  seedCustomerData,
  seedFullBusiness,
} from '../../helpers/config-transfer.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

describe('privacidad de la exportación (SC-003)', () => {
  let t: TestDatabase;
  let sensitive: string[];
  const now = new Date('2026-09-30T10:00:00.000Z');
  const secrets = [TEST_SESSION_SECRET, 'f0e1d2c3'.repeat(8), 'sk-ant-prueba-secreta'];

  beforeAll(async () => {
    t = await createTestDatabase();
    await seedFullBusiness(t.deps, { alerts: FULL_ALERTS, webChatEnabled: true });
    sensitive = await seedCustomerData(t.db);
  });
  afterAll(async () => {
    await t.close();
  });

  const exported = (includeAlerts: boolean) =>
    exportConfig(t.db, { includeAlerts, instanceId: 'demo-01', now });

  it('sin la casilla no aparece ningún dato de clientes, ni destinos, ni uso, ni secretos', async () => {
    const { content } = await exported(false);
    for (const value of [...sensitive, ...secrets, FULL_ALERTS.whatsapp, FULL_ALERTS.email]) {
      expect(content, value).not.toContain(value);
    }
    expect(content).not.toContain('alertDestinations');
    // Ninguna clave que no sea del contrato: nada de uso, conversaciones ni estados de la BD.
    // `source.schema` es el nombre de la última migración (p. ej. `0006_usage`, 010), no un dato.
    const parsed = JSON.parse(content) as { source: { schema: string } };
    expect(content.replace(JSON.stringify(parsed.source.schema), '""')).not.toMatch(
      /replies|usage|conversation|customer|message|handoff_notice/i,
    );
  });

  it('no lleva precios, moneda de coste ni tope de gasto (010, FR-024)', async () => {
    await t.db.insert(modelPrice).values({
      model: 'modelo-con-precio-privado',
      inputMicrosPerMtok: 3_141_592n,
      outputMicrosPerMtok: 0n,
      cacheWriteMicrosPerMtok: 0n,
      cacheReadMicrosPerMtok: 0n,
    });
    await t.db
      .update(usageSettings)
      .set({ currency: 'GBP', capEnabled: true, monthlyCapCents: 432_199 });
    for (const includeAlerts of [false, true]) {
      const { content } = await exported(includeAlerts);
      for (const value of ['modelo-con-precio-privado', '3141592', '3,141592', 'GBP', '432199']) {
        expect(content, value).not.toContain(value);
      }
      // `webChat.monthlyCap` es el tope de respuestas de la 004 (sí es configuración).
      // Los servicios sí llevan `priceType`/`priceCents` (precios del negocio, no del modelo).
      expect(content).not.toMatch(/modelPrice|micros|capEnabled|spendCap|usageSettings/i);
    }
  });

  it('con la casilla solo añade los destinos de los avisos', async () => {
    const without = await exported(false);
    const withAlerts = await exported(true);
    for (const value of [...sensitive, ...secrets]) expect(withAlerts.content).not.toContain(value);

    const a = parseConfigFile(Buffer.from(without.content), { phoneRegion: 'ES' });
    const b = parseConfigFile(Buffer.from(withAlerts.content), { phoneRegion: 'ES' });
    if (!a.ok || !b.ok) throw new Error('exportación no válida');
    expect(b.document.alertDestinations).toEqual(FULL_ALERTS);
    const { alertDestinations: _ignored, ...rest } = b.document;
    expect(rest).toEqual(a.document);
  });

  it('info refleja el estado del negocio y del chat web', async () => {
    const parsed = parseConfigFile(Buffer.from((await exported(false)).content), {
      phoneRegion: 'ES',
    });
    if (!parsed.ok) throw new Error('exportación no válida');
    expect(parsed.envelope.info).toEqual({ businessStatus: 'active', webChatEnabled: true });
  });
});
