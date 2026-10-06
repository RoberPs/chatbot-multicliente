/**
 * `claimReady` respeta `process_after` (012, data-model §1.8): una conversación con pendientes y
 * espera futura no se reclama hasta que vence; `resetBatch` la deja lista otra vez.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as conversations from '../../../src/conversation/repositories/conversation.js';
import * as messages from '../../../src/conversation/repositories/message.js';
import { conversation, customer } from '../../../src/db/schema.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

const NOW = new Date('2026-09-24T08:00:00Z');
const limits = { quietMs: 2500, maxWaitMs: 8000, limit: 10, transcriptionWaitMs: 10_000, excludeIds: [] };

describe('claimReady con process_after', () => {
  let t: TestDatabase;
  let conversationId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetDb(t.db);
    const [c] = await t.db
      .insert(customer)
      .values({ channel: 'whatsapp', channelUserId: '+34600111222' })
      .returning({ id: customer.id });
    const row = await conversations.create(t.db, {
      customerId: c?.id ?? '',
      sentAt: new Date(NOW.getTime() - 60_000),
      receivedAt: new Date(NOW.getTime() - 60_000),
    });
    conversationId = row.id;
    await messages.insertInbound(t.db, {
      conversationId,
      channelMessageId: 'wamid.claim.1',
      kind: 'text',
      body: 'hola',
      otherType: null,
      sentAt: new Date(NOW.getTime() - 60_000),
      receivedAt: new Date(NOW.getTime() - 60_000),
      status: 'pending',
    });
  });

  const claim = (at: Date) => t.db.transaction((tx) => conversations.claimReady(tx, at, limits));

  it('sin espera se reclama', async () => {
    expect(await claim(NOW)).toEqual([conversationId]);
  });

  it('con process_after futuro no se reclama, y sí al vencer', async () => {
    const after = new Date(NOW.getTime() + 30_000);
    await conversations.setProcessAfter(t.db, conversationId, after);
    expect(await claim(NOW)).toEqual([]);
    expect(await claim(new Date(after.getTime() - 1))).toEqual([]);
    expect(await claim(after)).toEqual([conversationId]);
  });

  it('addBatchAttempt cuenta hasta 5 y resetBatch quita intentos y espera', async () => {
    for (let i = 1; i <= 6; i++) {
      expect(await conversations.addBatchAttempt(t.db, conversationId)).toBe(Math.min(i, 5));
    }
    await conversations.setProcessAfter(t.db, conversationId, new Date(NOW.getTime() + 60_000));
    await conversations.resetBatch(t.db, conversationId);
    const [row] = await t.db
      .select({ attempts: conversation.batchAttempts, after: conversation.processAfter })
      .from(conversation)
      .where(eq(conversation.id, conversationId));
    expect(row).toEqual({ attempts: 0, after: null });
    expect(await claim(NOW)).toEqual([conversationId]);
  });
});
