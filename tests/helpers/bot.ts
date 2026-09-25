/** Bot completo con dobles (modelo, canal, reloj) para los tests de integración. */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  createActivityLog,
  type ActivityLog,
  type LoggerLike,
} from '../../src/conversation/activity-log.js';
import { createIntake, type Intake } from '../../src/conversation/intake.js';
import type { ChatModel } from '../../src/conversation/ports.js';
import { createProcessor, type Processor } from '../../src/conversation/processor.js';
import { createTranscriber, type Transcriber } from '../../src/conversation/transcription.js';
import {
  conversationSettings,
  type ConversationSettings,
} from '../../src/conversation/settings.js';
import { message } from '../../src/db/schema.js';
import { activateBusiness } from '../../src/knowledge/services/business-status.js';
import { createKnowledgeReader } from '../../src/knowledge/snapshot.js';
import type { KnowledgeReader } from '../../src/knowledge/types.js';
import { hairSalon } from '../fixtures/hair-salon.js';
import { loadFixture } from '../fixtures/load.js';
import type { BusinessFixture } from '../fixtures/types.js';
import { buildTestApp } from './app.js';
import { resetDb, type TestDatabase } from './db.js';
import {
  FakeChannelSender,
  FakeChatModel,
  ManualClock,
  RecordingActivityLog,
  type FakeMediaFetcher,
  type FakeSpeechToText,
} from './fakes.js';
import { CUSTOMER_WA, postWebhook, testWhatsApp, textMessage, webhookPayload } from './whatsapp.js';

export const EMERGENCY_PHONE = '+34600999888';

/** Saludo de la primera respuesta de cada conversación con el fixture por defecto. */
export const GREETING =
  '¡Hola! Soy el asistente automático de Peluquería Tijeras. Puedo informarte sobre horario, ' +
  'ubicación, servicios, precios y dudas frecuentes.';

/** Texto de una primera respuesta: saludo y cuerpo. */
export const greeted = (body: string): string => `${GREETING}\n\n${body}`;

export interface TestBot {
  app: FastifyInstance;
  clock: ManualClock;
  model: FakeChatModel;
  sender: FakeChannelSender;
  log: RecordingActivityLog;
  intake: Intake;
  processor: Processor;
  /** Solo con los audios activados. */
  transcriber: Transcriber | null;
  /** Envía un mensaje de cualquier tipo (tests/helpers/whatsapp.ts) con la hora del reloj. */
  sendMessage(msg: { timestamp: string }): Promise<number>;
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
  /** Ajustes del procesador distintos de los de producción (plazos cortos). */
  settings?: Partial<ConversationSettings>;
  /** Activa los audios (AUDIO_TRANSCRIPTION=on) con estos dobles. */
  audio?: { stt: FakeSpeechToText; media: FakeMediaFetcher };
  /** Además de guardarlos en `log`, escribe los eventos con el registro real en este logger. */
  logger?: LoggerLike;
}

export const TEST_SESSION_SECRET = 'secreto-de-sesion-de-prueba-con-32-caracteres';

export async function createTestBot(t: TestDatabase, opts: TestBotOptions = {}): Promise<TestBot> {
  await resetDb(t.db);
  const fixture = opts.fixture === undefined ? hairSalon : opts.fixture;
  if (fixture) await loadFixture(t.deps, fixture);
  if (opts.activate ?? true) await activateBusiness(t.db);

  const clock = new ManualClock(opts.start ?? '2026-09-24T08:00:00Z');
  const model = new FakeChatModel(clock);
  const sender = new FakeChannelSender();
  const log = new RecordingActivityLog();
  const real = opts.logger ? createActivityLog(opts.logger, TEST_SESSION_SECRET) : null;
  const activityLog: ActivityLog = real
    ? {
        pseudonym: (phone) => real.pseudonym(phone),
        log(event, context) {
          log.log(event, context);
          real.log(event, context);
        },
      }
    : log;
  const reader = opts.reader ?? createKnowledgeReader(t.db);
  const settings = { ...conversationSettings, ...opts.settings };
  const audioTranscription = opts.audio !== undefined;
  const makeProcessor = () =>
    createProcessor({
      db: t.db,
      reader,
      chatModel: opts.chatModel ?? model,
      sender,
      clock,
      activityLog,
      emergencyContactPhone: EMERGENCY_PHONE,
      settings,
      audioTranscription,
    });
  const processor = makeProcessor();
  const wake = (id: string) => {
    processor.wake(id);
  };
  const transcriber = opts.audio
    ? createTranscriber({
        db: t.db,
        media: opts.audio.media,
        stt: opts.audio.stt,
        activityLog,
        wake,
        settings,
      })
    : null;
  const intake = createIntake({
    db: t.db,
    reader,
    clock,
    activityLog,
    wake,
    notifyRateLimit: (id) => {
      void processor.sendRateLimitNotice(id);
    },
    transcriber: transcriber ?? undefined,
  });
  const app = await buildTestApp(t.db, undefined, {
    whatsapp: testWhatsApp,
    audioTranscription,
    activityLog,
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
    transcriber,
    async sendMessage(msg) {
      const at = String(Math.floor(clock.now().getTime() / 1000));
      const res = await postWebhook(app, webhookPayload({ messages: [{ ...msg, timestamp: at }] }));
      return res.statusCode;
    },
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
      await transcriber?.stop();
      await processor.stop();
      await app.close();
    },
  };
}

export const inboundOf = async (t: TestDatabase) =>
  t.db.select().from(message).where(eq(message.direction, 'inbound'));
