/**
 * SC-001: una instancia con 30 días de actividad típica (del orden de 10⁴ mensajes) se copia en
 * menos de un minuto sin pausar al bot; restaurar y comprobar son del mismo orden.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackup, restoreBackup, verifyBackup } from '../../../src/backup/service.js';
import { customer } from '../../../src/db/schema.js';
import {
  seedInstance,
  tempBackupDir,
  testBackupConfig,
  withClient,
  type TempDir,
} from '../../helpers/backup.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

const MINUTE = 60_000;
let test: TestDatabase;
let dir: TempDir;

beforeAll(async () => {
  test = await createTestDatabase();
  dir = await tempBackupDir();
  await seedInstance(test.db);
  // 1 000 conversaciones de los últimos 30 días con 10 mensajes cada una.
  await withClient(test.url, async (client) => {
    await client.query(`
      insert into customer (channel, channel_user_id, created_at)
      select 'web', 'perf-' || g, now() - (g % 30) * interval '1 day'
      from generate_series(1, 1000) g`);
    await client.query(`
      insert into conversation (customer_id, started_at, last_inbound_at, last_message_at, greeted)
      select id, created_at, created_at, created_at, true from customer
      where channel_user_id like 'perf-%'`);
    await client.query(`
      insert into message (conversation_id, direction, kind, body, sent_at, received_at, status)
      select c.id, case when g % 2 = 0 then 'inbound' else 'outbound' end::message_direction,
             'text', repeat('Texto de ejemplo de un mensaje ', 4), c.started_at, c.started_at,
             'answered'
      from conversation c
      join customer cu on cu.id = c.customer_id and cu.channel_user_id like 'perf-%'
      cross join generate_series(1, 10) g`);
  });
}, 120_000);
afterAll(async () => {
  await test.close();
  await dir.remove();
});

describe('rendimiento de las copias (SC-001)', () => {
  it('copia < 1 min con escrituras concurrentes < 1 s; restauración y comprobación del mismo orden', async () => {
    const messages = await withClient(test.url, async (client) => {
      const r = await client.query<{ n: string }>('select count(*)::text as n from message');
      return Number(r.rows[0]?.n);
    });
    expect(messages).toBeGreaterThanOrEqual(10_000);

    const config = testBackupConfig({ dir: dir.path });
    const writes: number[] = [];
    let first = true;
    const t0 = Date.now();
    const backup = await createBackup({
      databaseUrl: test.url,
      config,
      reason: 'manual',
      internal: {
        onTable: async () => {
          if (!first) return;
          first = false;
          const w0 = Date.now();
          await test.db
            .insert(customer)
            .values({ channel: 'web', channelUserId: 'durante-la-copia' });
          writes.push(Date.now() - w0);
        },
      },
    });
    const backupMs = Date.now() - t0;
    expect(backupMs).toBeLessThan(MINUTE);
    expect(writes).toHaveLength(1);
    for (const ms of writes) expect(ms).toBeLessThan(1000);

    const r0 = Date.now();
    await restoreBackup({ databaseUrl: test.url, file: join(dir.path, backup.file), config });
    expect(Date.now() - r0).toBeLessThan(MINUTE);

    const v0 = Date.now();
    const report = await verifyBackup({ file: join(dir.path, backup.file), config });
    expect(report.restorable).toBe(true);
    expect(Date.now() - v0).toBeLessThan(MINUTE);
  }, 240_000);
});
