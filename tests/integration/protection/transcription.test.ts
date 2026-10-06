/**
 * Audios y protección (012 US1, R6, SC-002): con el tope alcanzado, con el tope diario del canal o
 * sin precio de la transcripción en producción, un audio no se descarga ni se transcribe y el
 * cliente recibe R-CAP; bajo el tope, cada transcripción suma al gasto del mes en `model_usage`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SpeechToTextError } from '../../../src/conversation/ports.js';
import {
  modelPrice,
  modelUsage,
  transcriptionPrice,
  usageSettings,
  whatsappUsageDay,
} from '../../../src/db/schema.js';
import { createUsageMeter, type UsageMeter } from '../../../src/usage/meter.js';
import type { CapReason } from '../../../src/usage/types.js';
import { spendCapState } from '../../../src/usage/spend-cap.js';
import {
  createTestBot,
  inboundOf,
  TEST_LLM_MODEL,
  TEST_STT_MODEL,
  type TestBot,
  type TestBotOptions,
} from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import {
  FakeMediaFetcher,
  FakeSpeechToText,
  RecordingActivityLog,
  reply,
} from '../../helpers/fakes.js';
import { audioMessage } from '../../helpers/whatsapp.js';

const CENT = 10_000_000_000n;
const R_CAP =
  'Ahora mismo no puedo atenderte por este chat.\n\nPara hablar con una persona de Peluquería Tijeras:';
/** 6000 millonésimas por minuto = 0,006 por minuto. */
const STT_MICROS = 6000n;

describe('audios con la protección de la 012', () => {
  let t: TestDatabase;
  let bot: TestBot | null = null;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  afterEach(async () => {
    await bot?.close();
    bot = null;
  });

  interface Started {
    b: TestBot;
    stt: FakeSpeechToText;
    media: FakeMediaFetcher;
  }

  /** Producción con tope, precios y audios; `reason` rompe una de las condiciones. */
  async function start(
    reason: CapReason | null,
    opts: { stt?: FakeSpeechToText; bot?: TestBotOptions } = {},
  ): Promise<Started> {
    const stt = opts.stt ?? new FakeSpeechToText().queue({ text: '¿Abrís el sábado?' });
    const media = new FakeMediaFetcher();
    const b = (bot = await createTestBot(t, {
      production: true,
      audio: { stt, media },
      ...opts.bot,
    }));
    await t.db.insert(modelPrice).values({
      model: TEST_LLM_MODEL,
      inputMicrosPerMtok: 3_000_000n,
      outputMicrosPerMtok: 15_000_000n,
      cacheWriteMicrosPerMtok: 0n,
      cacheReadMicrosPerMtok: 0n,
    });
    await t.db.update(usageSettings).set({ capEnabled: true, monthlyCapCents: 1000 });
    if (reason !== 'stt_unpriced') {
      await t.db
        .insert(transcriptionPrice)
        .values({ model: TEST_STT_MODEL, microsPerMinute: STT_MICROS });
    }
    if (reason === 'spend_cap') {
      await t.db.insert(modelUsage).values({
        at: b.clock.now(),
        day: '2026-09-24',
        channel: 'web',
        purpose: 'reply',
        model: TEST_LLM_MODEL,
        calls: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        costPico: 1000n * CENT,
        currency: 'USD',
      });
    }
    if (reason === 'whatsapp_daily') {
      await t.db.update(usageSettings).set({ whatsappDailyCap: 2 });
      await t.db.insert(whatsappUsageDay).values({ day: '2026-09-24', replies: 2 });
    }
    return { b, stt, media };
  }
  const sendAudio = async (b: TestBot) => {
    await b.sendMessage(audioMessage({ mediaId: 'media-1' }));
    await b.transcriber?.idle();
    await b.settle();
  };
  const transcriptions = () =>
    t.db
      .select()
      .from(modelUsage)
      .then((rows) => rows.filter((r) => r.purpose === 'transcription'));

  it.each(['spend_cap', 'whatsapp_daily', 'stt_unpriced'] as const)(
    '%s: ni descarga ni transcripción, failed { blocked } y R-CAP',
    async (reason) => {
      const { b, stt, media } = await start(reason);
      await sendAudio(b);

      expect(media.calls).toEqual([]);
      expect(stt.calls).toEqual([]);
      expect(b.model.calls).toHaveLength(0);
      const [row] = await inboundOf(t);
      expect(row).toMatchObject({ kind: 'audio', transcription: 'failed', body: null });
      expect(b.log.named('transcription_failed')).toEqual([
        expect.objectContaining({ reason: 'blocked' }),
      ]);
      expect(b.sender.sent).toHaveLength(1);
      expect(b.sender.sent[0]?.body.startsWith(R_CAP)).toBe(true);
      expect(await transcriptions()).toEqual([]);
    },
  );

  it('bajo el tope: una fila de transcripción con audio_ms y coste que suma al gasto', async () => {
    const { b, stt, media } = await start(null);
    b.model.queue(reply('El sábado abrimos de 9:00 a 14:00.'));
    await sendAudio(b);

    expect(media.calls).toEqual(['media-1']);
    expect(stt.calls).toHaveLength(1);
    expect(b.model.calls).toHaveLength(1);
    const rows = await transcriptions();
    expect(rows).toHaveLength(1);
    // 5 s del proveedor: ceil(5000 × 6000 × 50 / 3) billonésimas.
    expect(rows[0]).toMatchObject({
      purpose: 'transcription',
      model: TEST_STT_MODEL,
      channel: 'whatsapp',
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      audioMs: 5000,
      costPico: 500_000_000n,
      currency: 'USD',
    });
    const state = await spendCapState(t.db, b.clock.now(), 'Europe/Madrid');
    expect(state.spentPico).toBeGreaterThanOrEqual(500_000_000n);
  });

  it('sin precio fuera de producción: la fila se guarda con coste nulo', async () => {
    const stt = new FakeSpeechToText().queue({ text: '¿Abrís el sábado?' });
    const b = (bot = await createTestBot(t, { audio: { stt, media: new FakeMediaFetcher() } }));
    b.model.queue(reply('Sí.'));
    await sendAudio(b);
    const rows = await transcriptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ audioMs: 5000, costPico: null, currency: null });
  });

  it('un error tras responder el proveedor también se registra', async () => {
    const stt = new FakeSpeechToText().queue(
      new SpeechToTextError('provider_error', 500, { responded: true, durationSeconds: 3 }),
    );
    const { b } = await start(null, { stt });
    await sendAudio(b);
    expect(b.log.named('transcription_failed')).toEqual([
      expect.objectContaining({ reason: 'provider_error' }),
    ]);
    const rows = await transcriptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ audioMs: 3000, costPico: 300_000_000n });
  });

  it('un error sin respuesta del proveedor no se registra', async () => {
    const stt = new FakeSpeechToText().queue(new SpeechToTextError('provider_error', 500));
    const { b } = await start(null, { stt });
    await sendAudio(b);
    expect(await transcriptions()).toEqual([]);
  });

  it('un fallo del registro emite transcription_usage_failed y no rompe la respuesta', async () => {
    const real = createUsageMeter({ db: t.db, activityLog: new RecordingActivityLog() });
    const meter: UsageMeter = {
      record: (input, ctx) => real.record(input, ctx),
      recordTranscription: () => Promise.reject(new Error('caída')),
    };
    const { b } = await start(null, { bot: { usageMeter: meter } });
    b.model.queue(reply('El sábado abrimos de 9:00 a 14:00.'));
    await sendAudio(b);
    expect(b.log.named('transcription_usage_failed')).toHaveLength(1);
    expect(b.model.calls).toHaveLength(1);
    const [row] = await inboundOf(t);
    expect(row).toMatchObject({ transcription: 'done', status: 'answered' });
    expect(b.sender.sent[0]?.body).toContain('El sábado abrimos de 9:00 a 14:00.');
  });
});
