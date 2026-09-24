/** Bot completo con dobles (modelo, canal, reloj) para los tests de integración. */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { createIntake, type Intake } from '../../src/conversation/intake.js';
import type { ChatModel } from '../../src/conversation/ports.js';
import { createProcessor, type Processor } from '../../src/conversation/processor.js';
import { message } from '../../src/db/schema.js';
import { activateBusiness } from '../../src/knowledge/services/business-status.js';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import type { KnowledgeReader } from '../../src/knowledge/types.js';
import { hairSalon } from '../fixtures/hair-salon.js';
import { loadFixture } from '../fixtures/load.js';
import type { BusinessFixture } from '../fixtures/types.js';
import { buildTestApp } from './app.js';
import { resetDb, type TestDatabase } from './db.js';
import { FakeChannelSender, FakeChatModel, ManualClock, RecordingActivityLog } from './fakes.js';
import { CUSTOMER_WA, postWebhook, testWhatsApp, textMessage, webhookPayload } from './whatsapp.js';

export const EMERGENCY_PHONE = '+34600999888';

export interface TestBot {
  app: FastifyInstance;
  clock: ManualClock;
  model: FakeChatModel;
  sender: FakeChannelSender;
  log: RecordingActivityLog;
  intake: Intake;
  processor: Processor;
  /** Envía un texto por el webhook con la hora del reloj manual. */
  send(text: string, opts?: { id?: string; from?: string }): Promise<number>;
  /** Avanza el reloj (por defecto la espera de agrupado) y procesa lo que esté listo. */
  settle(ms?: number): Promise<void>;
  /** Nuevo procesador sobre la misma BD (reinicio del proceso). */
  newProcessor(): Processor;
  messages(): Promise<Array<typeof message.$inferSelect>>;
  close(): Promise<void>;
}

export interface TestBotOptions {
  fixture?: BusinessFixture | null;
  activate?: boolean;
  /** Instante inicial del reloj. Por defecto jueves 24/09/2026 10:00 en Madrid. */
  start?: string;
  reader?: KnowledgeReader;
  chatModel?: ChatModel;
}

export async function createTestBot(t: TestDatabase, opts: TestBotOptions = {}): Promise<TestBot> {
  await resetDb(t.db);
  const fixture = opts.fixture === undefined ? hairSalon : opts.fixture;
  if (fixture) await loadFixture(t.deps, fixture);
  if (opts.activate ?? true) await activateBusiness(t.db);

  const clock = new ManualClock(opts.start ?? '2026-09-24T08:00:00Z');
  const model = new FakeChatModel(clock);
  const sender = new FakeChannelSender();
  const log = new RecordingActivityLog();
  const reader = opts.reader ?? createKnowledgeReader(t.db);
  const makeProcessor = () =>
    createProcessor({
      db: t.db,
      reader,
      chatModel: opts.chatModel ?? model,
      sender,
      clock,
      activityLog: log,
      emergencyContactPhone: EMERGENCY_PHONE,
    });
  const processor = makeProcessor();
  const intake = createIntake({
    db: t.db,
    reader,
    clock,
    activityLog: log,
    wake: (id) => {
      processor.wake(id);
    },
  });
  const app = await buildTestApp(t.db, undefined, {
    whatsapp: testWhatsApp,
    audioTranscription: false,
    activityLog: log,
    intake,
  });

  return {
    app,
    clock,
    model,
    sender,
    log,
    intake,
    processor,
    async send(text, sendOpts = {}) {
      const res = await postWebhook(
        app,
        webhookPayload({
          messages: [
            textMessage(text, {
              id: sendOpts.id,
              from: sendOpts.from ?? CUSTOMER_WA,
              timestamp: clock.now(),
            }),
          ],
        }),
      );
      return res.statusCode;
    },
    async settle(ms = 3000) {
      clock.advance(ms);
      await processor.runOnce();
    },
    newProcessor: makeProcessor,
    messages: () => t.db.select().from(message).orderBy(message.receivedAt, message.sentAt),
    async close() {
      await processor.stop();
      await app.close();
    },
  };
}

export const inboundOf = async (t: TestDatabase) =>
  t.db.select().from(message).where(eq(message.direction, 'inbound'));
