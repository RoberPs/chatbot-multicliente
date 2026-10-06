/**
 * La copia no pausa al bot y sale de un único instante (US1-2, FR-002, R2): mientras vuelca,
 * otras conexiones escriben sin esperar y lo escrito no entra en la copia.
 */
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readKeys } from '../../../src/backup/config.js';
import { readDump } from '../../../src/backup/dump.js';
import { openBackup } from '../../../src/backup/format.js';
import { createBackup } from '../../../src/backup/service.js';
import { business, conversation, customer, message } from '../../../src/db/schema.js';
import {
  seedInstance,
  tempBackupDir,
  testBackupConfig,
  withClient,
  type TempDir,
} from '../../helpers/backup.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';

let test: TestDatabase;
let dir: TempDir;

beforeAll(async () => {
  test = await createTestDatabase();
  await seedInstance(test.db);
  dir = await tempBackupDir();
});
afterAll(async () => {
  await test.close();
  await dir.remove();
});

async function counts(): Promise<Record<string, number>> {
  return withClient(test.url, async (client) => {
    const out: Record<string, number> = {};
    for (const name of ['conversation', 'message', 'customer']) {
      const r = await client.query<{ n: string }>(`select count(*)::text as n from "${name}"`);
      out[name] = Number(r.rows[0]?.n);
    }
    return out;
  });
}

describe('copia con escrituras concurrentes', () => {
  it('las escrituras no esperan a la copia y la copia es de un único instante', async () => {
    const before = await counts();
    const [{ name: nameBefore } = { name: '' }] = await test.db
      .select({ name: business.name })
      .from(business);
    const writeTimes: number[] = [];
    let wrote = false;

    const concurrentWrites = async () => {
      for (let i = 0; i < 5; i++) {
        const t0 = Date.now();
        await test.db.transaction(async (tx) => {
          const [c] = await tx
            .insert(customer)
            .values({ channel: 'web', channelUserId: `concurrente-${i}` })
            .returning({ id: customer.id });
          const now = new Date();
          const [conv] = await tx
            .insert(conversation)
            .values({
              customerId: c?.id ?? '',
              startedAt: now,
              lastInboundAt: now,
              lastMessageAt: now,
            })
            .returning({ id: conversation.id });
          await tx.insert(message).values({
            conversationId: conv?.id ?? '',
            direction: 'inbound',
            kind: 'text',
            body: 'escrito durante la copia',
            sentAt: now,
            receivedAt: now,
            status: 'pending',
          });
        });
        await test.db
          .update(business)
          .set({ name: `Cambiado ${i}` })
          .where(eq(business.id, 1));
        writeTimes.push(Date.now() - t0);
      }
      wrote = true;
    };

    // Destino lento: la copia sigue abierta mientras se escribe.
    const slow = () =>
      new Transform({
        transform(chunk: Buffer, _e, callback) {
          setTimeout(() => {
            callback(null, chunk);
          }, 5);
        },
      });

    const config = testBackupConfig({ dir: dir.path });
    let started = false;
    const report = await createBackup({
      databaseUrl: test.url,
      config,
      reason: 'manual',
      internal: {
        throughput: slow,
        // Sincronización por evento: se escribe cuando el volcador ya ha emitido su primera tabla.
        onTable: async () => {
          if (started) return;
          started = true;
          await concurrentWrites();
        },
      },
    });

    expect(wrote).toBe(true);
    for (const ms of writeTimes) expect(ms).toBeLessThan(1000);
    expect((await counts()).conversation).toBe((before.conversation ?? 0) + 5);

    // Lo que hay en la copia es el estado anterior a las escrituras concurrentes.
    const { header, stream } = await openBackup(join(dir.path, report.file), readKeys(config));
    const rowsInDump: Record<string, number> = {};
    let businessRow = '';
    await readDump(stream, header, {
      async table(table, rows) {
        let n = 0;
        for await (const chunk of rows) {
          const text = chunk.toString('utf8');
          n += text.split('\n').length - 1;
          if (table.name === 'business') businessRow += text;
        }
        rowsInDump[table.name] = n;
      },
    });
    for (const t of header.tables) expect(rowsInDump[t.name]).toBe(t.rows);
    expect(rowsInDump.conversation).toBe(before.conversation);
    expect(rowsInDump.message).toBe(before.message);
    expect(rowsInDump.customer).toBe(before.customer);
    expect(businessRow).toContain(nameBefore);
    expect(businessRow).not.toContain('Cambiado');
  });
});
