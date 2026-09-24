/** Forma exacta de `KnowledgeSnapshot` (contracts/knowledge-reader.md): sin campos extra ni `undefined`. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import { allFixtures, loadFixture } from '../fixtures/load.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../helpers/db.js';

const localTime = z.string().regex(/^\d{2}:\d{2}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().regex(/^[0-9a-f-]{36}$/);
const weeklySlot = z.strictObject({
  weekday: z.number().int().min(1).max(7),
  start: localTime,
  end: localTime,
});
const block = z.strictObject({
  startDate: isoDate,
  endDate: isoDate,
  startTime: localTime.nullable(),
  endTime: localTime.nullable(),
  reason: z.string().nullable(),
});

const snapshotSchema = z.strictObject({
  status: z.enum(['draft', 'active']),
  business: z.strictObject({
    name: z.string(),
    address: z.string().nullable(),
    directions: z.string().nullable(),
    phone: z
      .string()
      .regex(/^\+\d{6,15}$/)
      .nullable(),
    email: z.string().nullable(),
    timezone: z.string(),
    currency: z.string().length(3),
  }),
  openingHours: z.array(weeklySlot),
  closures: z.array(block),
  services: z.array(
    z.strictObject({
      id: uuid,
      name: z.string(),
      description: z.string().nullable(),
      price: z.discriminatedUnion('type', [
        z.strictObject({ type: z.literal('fixed'), amountCents: z.number().int().min(0) }),
        z.strictObject({ type: z.literal('from'), amountCents: z.number().int().min(0) }),
        z.strictObject({ type: z.literal('on_request') }),
        z.strictObject({ type: z.literal('missing') }),
      ]),
      durationMinutes: z.number().int().positive().nullable(),
      bookable: z.boolean(),
      resourceIds: z.array(uuid),
    }),
  ),
  scheduling: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('single_agenda') }),
    z.strictObject({
      mode: z.literal('resources'),
      resources: z.array(
        z.strictObject({
          id: uuid,
          name: z.string(),
          serviceIds: z.array(uuid),
          hours: z.array(weeklySlot),
          absences: z.array(block),
        }),
      ),
    }),
  ]),
  faqs: z.array(z.strictObject({ question: z.string(), answer: z.string() })),
  policies: z.strictObject({
    cancellationText: z.string().nullable(),
    cancellationNoticeMinutes: z.number().int().nullable(),
    minAdvanceMinutes: z.number().int().nullable(),
    maxAdvanceMinutes: z.number().int().nullable(),
    paymentMethods: z.array(z.string()),
  }),
  tone: z.strictObject({
    addressForm: z.enum(['informal', 'formal']).nullable(),
    styleDescription: z.string().nullable(),
  }),
  handoff: z.strictObject({
    source: z.enum(['configured', 'business_phone', 'none']),
    channels: z.array(
      z.strictObject({ type: z.enum(['phone', 'whatsapp', 'email']), value: z.string() }),
    ),
    hours: z.array(weeklySlot),
  }),
  updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
});

/** Falla si algún valor es `undefined` (el contrato usa `null` o listas vacías). */
function assertNoUndefined(value: unknown, path = 'snapshot'): void {
  expect(value, path).not.toBeUndefined();
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, `${path}.${k}`);
  }
}

describe('forma de KnowledgeSnapshot', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  beforeEach(async () => {
    await resetDb(t.db);
  });
  afterAll(async () => {
    await t.close();
  });

  it('instancia vacía', async () => {
    const snap = await createKnowledgeReader(t.db).getSnapshot();
    expect(() => snapshotSchema.parse(snap)).not.toThrow();
    assertNoUndefined(snap);
    expect(snap.handoff.source).toBe('none');
  });

  it.each(allFixtures.map((f) => [f.sector, f] as const))(
    'fixture de %s',
    async (_sector, fixture) => {
      await loadFixture(t.deps, fixture);
      const snap = await createKnowledgeReader(t.db).getSnapshot();
      const result = snapshotSchema.safeParse(snap);
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
      assertNoUndefined(snap);
    },
  );
});
