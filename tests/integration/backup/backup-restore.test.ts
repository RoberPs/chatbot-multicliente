/**
 * Ciclo copia → cambios → restauración con los negocios de ejemplo de todos los sectores
 * (US2, SC-002, FR-013, FR-023): la BD vuelve exactamente al estado de la copia.
 */
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { restoreBackup, createBackup } from '../../../src/backup/service.js';
import { createRetention } from '../../../src/conversation/retention.js';
import { silentActivityLog } from '../../../src/conversation/activity-log.js';
import {
  business,
  conversation,
  customer,
  service,
  webChatSettings,
} from '../../../src/db/schema.js';
import { createKnowledgeReader } from '../../../src/knowledge/snapshot.js';
import { allFixtures } from '../../fixtures/load.js';
import {
  captureLogger,
  seedInstance,
  tableSnapshot,
  tempBackupDir,
  testBackupConfig,
  testClock,
  withClient,
  type TempDir,
} from '../../helpers/backup.js';
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
      expect((await test.db.select().from(webChatSettings))[0]?.enabled).toBe(enabled);

      expect(report).toMatchObject({
        file: backup.file,
        sourceInstance: config.instanceId,
        crossInstance: false,
        schema: '0004_handoff',
        installedSchema: '0004_handoff',
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
