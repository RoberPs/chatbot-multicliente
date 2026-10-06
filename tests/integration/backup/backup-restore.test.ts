/**
 * Ciclo copia → cambios → restauración con los negocios de ejemplo de todos los sectores
 * (US2, SC-002, FR-013, FR-023): la BD vuelve exactamente al estado de la copia.
 */
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installedSchema } from '../../../src/backup/schema-version.js';
import { restoreBackup, createBackup, verifyBackup } from '../../../src/backup/service.js';
import { createRetention } from '../../../src/conversation/retention.js';
import { silentActivityLog } from '../../../src/conversation/activity-log.js';
import {
  business,
  chatDesign,
  configPreImport,
  conversation,
  customer,
  modelPrice,
  handoffDay,
  handoffLimits,
  modelUsage,
  transcriptionPrice,
  whatsappUsageDay,
  service,
  usageSettings,
  webChatSettings,
} from '../../../src/db/schema.js';
import { createKnowledgeReader } from '../../../src/knowledge/snapshot.js';
import { spendCapState } from '../../../src/usage/spend-cap.js';
import { allFixtures } from '../../fixtures/load.js';
import {
  captureLogger,
  CURRENT_SCHEMA,
  seedInstance,
  tableSnapshot,
  tempBackupDir,
  testBackupConfig,
  testClock,
  withClient,
  type TempDir,
} from '../../helpers/backup.js';
import {
  designImages,
  designRow,
  GREEN_PALETTE,
  seedChatDesignWithImages,
} from '../../helpers/chat-design.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

let dir: TempDir;
const opened: TestDatabase[] = [];

beforeAll(async () => {
  dir = await tempBackupDir();
});
afterAll(async () => {
  for (const d of opened) await d.close();
  await dir.remove();
});

describe.each(allFixtures.map((f) => [f.sector, f] as const))(
  'copia y restauración (%s)',
  (_sector, fixture) => {
    it('la BD y el snapshot del bot vuelven al estado de la copia', async () => {
      const test = await createTestDatabase();
      opened.push(test);
      const clock = testClock('2026-09-29T10:15:00.000Z');
      const seeded = await seedInstance(test.db, fixture, clock.now());
      // La configuración anterior a la última importación (008) entra en la copia y se restaura.
      await test.db.insert(configPreImport).values({
        content: '{"format":"business-config"}',
        importedAt: clock.now(),
        sourceInstance: 'origen-prueba',
      });
      const reader = createKnowledgeReader(test.db);
      const before = await tableSnapshot(test.url);
      const snapshotBefore = await reader.getSnapshot();

      const config = testBackupConfig({ dir: dir.path, instanceId: `r-${String(opened.length)}` });
      const backup = await createBackup({ databaseUrl: test.url, config, reason: 'manual', clock });

      // Cambios después de la copia.
      await test.db
        .update(business)
        .set({ name: 'Otro nombre', status: 'draft' })
        .where(eq(business.id, 1));
      const [first] = await test.db.select({ id: service.id }).from(service).limit(1);
      if (first) await test.db.delete(service).where(eq(service.id, first.id));
      const [c] = await test.db
        .insert(customer)
        .values({ channel: 'web', channelUserId: 'nueva-sesion' })
        .returning({ id: customer.id });
      await test.db.insert(conversation).values({
        customerId: c?.id ?? '',
        startedAt: clock.now(),
        lastInboundAt: clock.now(),
        lastMessageAt: clock.now(),
      });
      const [settings] = await test.db
        .select({ enabled: webChatSettings.enabled })
        .from(webChatSettings);
      const enabled = settings?.enabled ?? false;
      await test.db.update(webChatSettings).set({ enabled: !enabled });
      await test.db.update(configPreImport).set({ content: '{}' });
      expect(await tableSnapshot(test.url)).not.toEqual(before);

      const logger = captureLogger();
      const report = await restoreBackup({
        databaseUrl: test.url,
        file: join(dir.path, backup.file),
        config,
        clock,
        logger,
      });

      // Igualdad tabla a tabla, migraciones y secuencias incluidas.
      expect(await tableSnapshot(test.url)).toEqual(before);
      expect(await reader.getSnapshot()).toEqual(snapshotBefore);
      const [restored] = await test.db
        .select({ status: business.status, name: business.name })
        .from(business);
      expect(restored?.name).toBe(seeded.businessName);
      expect((await test.db.select().from(configPreImport))[0]?.content).toBe(
        '{"format":"business-config"}',
      );
      expect((await test.db.select().from(webChatSettings))[0]?.enabled).toBe(enabled);

      expect(report).toMatchObject({
        file: backup.file,
        sourceInstance: config.instanceId,
        crossInstance: false,
        schema: CURRENT_SCHEMA,
        installedSchema: CURRENT_SCHEMA,
        pendingMigrations: [],
        expiredConversations: seeded.expiredConversations,
      });
      expect(report.tables).toEqual(backup.tables);
      expect(logger.events('restore_completed')).toHaveLength(1);

      // Las caducadas desaparecen con la purga que hace el arranque (SC-005).
      const purge = await createRetention({
        db: test.db,
        clock,
        activityLog: silentActivityLog,
      }).purge();
      expect(purge.conversations).toBe(seeded.expiredConversations);
      const remaining = await withClient(test.url, async (client) => {
        const r = await client.query<{ n: string }>(
          `select count(*)::text as n from conversation where last_message_at < $1::timestamptz - interval '30 days'`,
          [clock.now()],
        );
        return Number(r.rows[0]?.n);
      });
      expect(remaining).toBe(0);
    });
  },
);

describe('consumo y coste (010, FR-025)', () => {
  it('precios, ajustes y registros vuelven y el gasto del mes es el restaurado', async () => {
    const test = await createTestDatabase();
    opened.push(test);
    const clock = testClock('2026-09-29T10:15:00.000Z');
    await seedInstance(test.db, undefined, clock.now());
    await test.db.insert(modelPrice).values({
      model: 'modelo-copia',
      inputMicrosPerMtok: 3_000_000n,
      outputMicrosPerMtok: 15_000_000n,
      cacheWriteMicrosPerMtok: 3_750_000n,
      cacheReadMicrosPerMtok: 300_000n,
    });
    await test.db
      .update(usageSettings)
      .set({ currency: 'EUR', capEnabled: true, monthlyCapCents: 2500, capNotifiedMonth: null });
    await test.db.insert(modelUsage).values(
      ['2026-09-03', '2026-09-28', '2026-08-15'].map((day, i) => ({
        at: new Date(`${day}T10:00:00Z`),
        day,
        channel: (['whatsapp', 'web', 'playground'] as const)[i] ?? 'whatsapp',
        purpose: 'reply' as const,
        model: 'modelo-copia',
        calls: 1,
        inputTokens: 1000,
        outputTokens: 100,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        costPico: BigInt(i + 1) * 1_000_000_000_000n,
        currency: 'EUR',
      })),
    );
    const spent = async () =>
      (await spendCapState(test.db, clock.now(), 'Europe/Madrid')).spentPico;
    expect(await spent()).toBe(3_000_000_000_000n);
    const before = await tableSnapshot(test.url);

    const config = testBackupConfig({ dir: dir.path, instanceId: 'consumo-01' });
    const backup = await createBackup({ databaseUrl: test.url, config, reason: 'manual', clock });

    // Cambios después de la copia.
    await test.db.delete(modelUsage);
    await test.db.update(modelPrice).set({ inputMicrosPerMtok: 9_000_000n });
    await test.db.update(usageSettings).set({ capEnabled: false, capNotifiedMonth: '2026-09-01' });
    expect(await spent()).toBe(0n);

    const report = await restoreBackup({
      databaseUrl: test.url,
      file: join(dir.path, backup.file),
      config,
      clock,
    });

    expect(await tableSnapshot(test.url)).toEqual(before);
    expect(await spent()).toBe(3_000_000_000_000n);
    expect(await test.db.select().from(usageSettings)).toEqual([
      expect.objectContaining({ currency: 'EUR', capEnabled: true, monthlyCapCents: 2500 }),
    ]);
    // La última migración se reaplica y su hash es el del núcleo instalado.
    expect(report).toMatchObject({ schema: CURRENT_SCHEMA, installedSchema: CURRENT_SCHEMA });
    const applied = await withClient(test.url, async (client) => {
      const r = await client.query<{ hash: string }>(
        'select hash from drizzle.__drizzle_migrations order by created_at desc limit 1',
      );
      return r.rows[0]?.hash;
    });
    expect(applied).toBe(installedSchema().hash);
  });
});

describe('protección frente a abuso (012, FR-036)', () => {
  it('precios de transcripción, contadores, límites y audio_ms vuelven; la copia se verifica', async () => {
    const test = await createTestDatabase();
    opened.push(test);
    const clock = testClock('2026-09-29T10:15:00.000Z');
    await seedInstance(test.db, undefined, clock.now());
    await test.db.insert(transcriptionPrice).values({ model: 'whisper-1', microsPerMinute: 6000n });
    await test.db.insert(whatsappUsageDay).values({ day: '2026-09-29', replies: 42 });
    await test.db
      .update(handoffLimits)
      .set({ dailyMax: 7, forwardIntervalMinutes: 30, noticesDailyMax: 25 });
    await test.db
      .insert(handoffDay)
      .values({ day: '2026-09-29', started: 3, refused: 1, notices: 9, noticesHeld: 2 });
    await test.db.insert(modelUsage).values({
      at: clock.now(),
      day: '2026-09-29',
      channel: 'whatsapp',
      purpose: 'transcription',
      model: 'whisper-1',
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      audioMs: 3000,
      costPico: 300_000_000_000n,
      currency: 'EUR',
    });
    const before = await tableSnapshot(test.url);

    const config = testBackupConfig({ dir: dir.path, instanceId: 'proteccion-01' });
    const backup = await createBackup({ databaseUrl: test.url, config, reason: 'manual', clock });

    await test.db.delete(transcriptionPrice);
    await test.db.delete(whatsappUsageDay);
    await test.db.delete(handoffDay);
    await test.db.delete(modelUsage);
    await test.db
      .update(handoffLimits)
      .set({ dailyMax: 20, forwardIntervalMinutes: 15, noticesDailyMax: 60 });

    const report = await restoreBackup({
      databaseUrl: test.url,
      file: join(dir.path, backup.file),
      config,
      clock,
    });
    expect(await tableSnapshot(test.url)).toEqual(before);
    expect((await test.db.select().from(modelUsage))[0]).toMatchObject({ audioMs: 3000 });
    expect((await test.db.select().from(handoffLimits))[0]).toMatchObject({ dailyMax: 7 });
    // La 0008 se reaplica comparando su hash.
    expect(report).toMatchObject({ schema: CURRENT_SCHEMA, installedSchema: CURRENT_SCHEMA });
    const verified = await verifyBackup({ file: join(dir.path, backup.file), config, clock });
    expect(verified.restorable).toBe(true);
  });
});

describe('secuencias', () => {
  it('tras restaurar, el siguiente valor de cada secuencia es el mismo que antes', async () => {
    const test = await createTestDatabase();
    opened.push(test);
    await seedInstance(test.db);
    const config = testBackupConfig({ dir: dir.path, instanceId: 'seq-01' });
    const backup = await createBackup({ databaseUrl: test.url, config, reason: 'manual' });
    const next = () =>
      withClient(test.url, async (client) => {
        const r = await client.query<{ v: string }>(
          `select nextval('drizzle.__drizzle_migrations_id_seq')::text as v`,
        );
        return r.rows[0]?.v;
      });
    const expected = await next();
    await next();
    await restoreBackup({ databaseUrl: test.url, file: join(dir.path, backup.file), config });
    expect(await next()).toBe(expected);
  });
});

describe('copia y restauración con diseño del chat (011, FR-028)', () => {
  it('la fila y las imágenes vuelven con los mismos bytes, y la copia se verifica', async () => {
    const test = await createTestDatabase();
    opened.push(test);
    const clock = testClock('2026-10-02T10:15:00.000Z');
    await seedChatDesignWithImages(
      test.db,
      { logo: 'valid.png', avatar: 'valid.jpg', icon: 'animated.webp' },
      { ...GREEN_PALETTE, shape: 'soft', chatName: 'Recepción' },
    );
    const rowBefore = await designRow(test.db);
    const imagesBefore = await designImages(test.db);

    const config = testBackupConfig({ dir: dir.path, instanceId: 'diseno-01' });
    const backup = await createBackup({ databaseUrl: test.url, config, reason: 'manual', clock });

    // Restaurar el aspecto original después de la copia.
    await test.db.delete(chatDesign);
    expect(await designRow(test.db)).toBeUndefined();

    await restoreBackup({
      databaseUrl: test.url,
      file: join(dir.path, backup.file),
      config,
      clock,
    });
    expect(await designRow(test.db)).toEqual(rowBefore);
    const imagesAfter = await designImages(test.db);
    for (const slot of ['logo', 'avatar', 'icon']) {
      expect(imagesAfter[slot]?.bytes.equals(imagesBefore[slot]?.bytes ?? Buffer.alloc(0))).toBe(
        true,
      );
      expect(imagesAfter[slot]?.sha256).toBe(imagesBefore[slot]?.sha256);
    }

    const verified = await verifyBackup({ file: join(dir.path, backup.file), config, clock });
    expect(verified.restorable).toBe(true);
  });
});
