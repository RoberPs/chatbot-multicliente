/** Fase 8: tipos no atendidos y audios (FR-028, FR-028a, SC-009; research R10). */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SpeechToTextError } from '../../../src/conversation/ports.js';
import { createTestBot, greeted, inboundOf, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { FakeMediaFetcher, FakeSpeechToText, reply } from '../../helpers/fakes.js';
import { audioMessage, imageMessage, stickerMessage } from '../../helpers/whatsapp.js';

const R_MEDIA_OFF = 'Solo puedo atender mensajes de texto. ¿Me escribes tu consulta?';
const R_MEDIA_ON =
  'Solo puedo atender mensajes de texto y audios. ¿Me escribes o me grabas tu consulta?';
const NOTICE_OFF =
  'No puedo ver archivos, imágenes, stickers ni escuchar audios; solo leo mensajes de texto.';
const R_AUDIO = 'No he podido entender el audio. ¿Puedes repetirlo o escribirme tu consulta?';

describe('Fase 8: archivos y audios', () => {
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

  async function withAudio(stt = new FakeSpeechToText(), media = new FakeMediaFetcher()) {
    const b = (bot = await createTestBot(t, { audio: { stt, media } }));
    return { b, stt, media };
  }

  describe('con los audios apagados (por defecto)', () => {
    it('una foto sin pie recibe R-MEDIA sin llamar al modelo', async () => {
      const b = (bot = await createTestBot(t));
      expect(await b.sendMessage(imageMessage())).toBe(200);
      await b.settle();
      expect(b.model.calls).toHaveLength(0);
      expect(b.sender.sent[0]?.body).toBe(greeted(R_MEDIA_OFF));
      expect(b.log.named('reply_sent')[0]).toMatchObject({
        template: 'R-MEDIA',
        kinds: ['other'],
        contactBlock: false,
      });
    });

    it('un sticker también', async () => {
      const b = (bot = await createTestBot(t));
      await b.sendMessage(stickerMessage());
      await b.settle();
      expect(b.sender.sent[0]?.body).toBe(greeted(R_MEDIA_OFF));
    });

    it('una foto con pie: se responde al pie y se añade el aviso', async () => {
      const b = (bot = await createTestBot(t));
      b.model.queue(reply('El sábado abrimos de 9:00 a 14:00.'));
      await b.sendMessage(imageMessage({ caption: '¿abrís el sábado?' }));
      await b.settle();
      expect(b.model.calls[0]?.context.pending).toEqual([
        { kind: 'other', text: '¿abrís el sábado?' },
      ]);
      expect(b.sender.sent[0]?.body).toBe(
        greeted(`El sábado abrimos de 9:00 a 14:00.\n\n${NOTICE_OFF}`),
      );
    });

    it('un audio se guarda como otro tipo, no se descarga y recibe R-MEDIA', async () => {
      const b = (bot = await createTestBot(t));
      await b.sendMessage(audioMessage());
      await b.settle();
      const [row] = await inboundOf(t);
      expect(row).toMatchObject({ kind: 'other', otherType: 'audio', transcription: null });
      expect(b.transcriber).toBeNull();
      expect(b.sender.sent[0]?.body).toBe(greeted(R_MEDIA_OFF));
    });
  });

  describe('con los audios encendidos', () => {
    it('la transcripción se guarda en body y llega al modelo; el audio no se guarda', async () => {
      const { b, stt, media } = await withAudio(
        new FakeSpeechToText().queue({ text: '¿A qué hora abrís el sábado?' }),
      );
      b.model.queue(reply('El sábado abrimos de 9:00 a 14:00.'));
      await b.sendMessage(audioMessage({ mediaId: 'media-42' }));
      await b.transcriber?.idle();
      await b.settle();

      expect(media.calls).toEqual(['media-42']);
      expect(stt.calls).toEqual([1024]);
      const [row] = await inboundOf(t);
      expect(row).toMatchObject({
        kind: 'audio',
        body: '¿A qué hora abrís el sábado?',
        transcription: 'done',
        status: 'answered',
      });
      expect(b.model.calls[0]?.context.pending).toEqual([
        { kind: 'audio', text: '¿A qué hora abrís el sábado?', audioUnderstood: true },
      ]);
      expect(b.sender.sent[0]?.body).toBe(greeted('El sábado abrimos de 9:00 a 14:00.'));
      // Ninguna columna guarda el audio: solo texto.
      expect(Object.values(row ?? {}).some((v) => Buffer.isBuffer(v))).toBe(false);
    });

    it('una foto sin pie recibe la variante de R-MEDIA con audios', async () => {
      const { b } = await withAudio();
      await b.sendMessage(imageMessage());
      await b.settle();
      expect(b.sender.sent[0]?.body).toBe(greeted(R_MEDIA_ON));
    });

    it.each([
      [
        'provider_error',
        () => new FakeSpeechToText().queue(new SpeechToTextError('provider_error', 500)),
      ],
      ['language', () => new FakeSpeechToText().queue({ text: 'What time?', language: 'en' })],
      ['empty', () => new FakeSpeechToText().queue({ text: '' })],
      ['too_long', () => new FakeSpeechToText().queue({ text: 'hola', durationSeconds: 130 })],
    ] as const)('transcripción %s → R-AUDIO y transcription_failed', async (reason, make) => {
      const { b } = await withAudio(make());
      await b.sendMessage(audioMessage());
      await b.transcriber?.idle();
      await b.settle();
      expect(b.model.calls).toHaveLength(0);
      expect(b.sender.sent[0]?.body).toBe(greeted(R_AUDIO));
      expect(b.log.named('transcription_failed')).toEqual([expect.objectContaining({ reason })]);
      const [row] = await inboundOf(t);
      expect(row).toMatchObject({ transcription: 'failed', body: null });
    });

    it('un audio de más de 2 MB no se transcribe y recibe R-AUDIO', async () => {
      const { b, stt } = await withAudio(
        new FakeSpeechToText(),
        new FakeMediaFetcher(3 * 1024 * 1024),
      );
      await b.sendMessage(audioMessage());
      await b.transcriber?.idle();
      await b.settle();
      expect(stt.calls).toHaveLength(0);
      expect(b.sender.sent[0]?.body).toBe(greeted(R_AUDIO));
      expect(b.log.named('transcription_failed')).toEqual([
        expect.objectContaining({ reason: 'too_large' }),
      ]);
    });

    it('texto y audio no entendido: el modelo contesta al texto con el audio anotado', async () => {
      const { b } = await withAudio(new FakeSpeechToText().queue({ text: '' }));
      b.model.queue(reply('Abrimos a las 10:00.'));
      await b.send('¿a qué hora abrís?');
      await b.sendMessage(audioMessage());
      await b.transcriber?.idle();
      await b.settle();
      expect(b.model.calls[0]?.context.pending).toEqual([
        { kind: 'text', text: '¿a qué hora abrís?' },
        { kind: 'audio', text: null, audioUnderstood: false },
      ]);
      expect(b.sender.sent[0]?.body).toBe(greeted('Abrimos a las 10:00.'));
    });

    it('el procesador no espera a un audio más de 10 s', async () => {
      const { b } = await withAudio(new FakeSpeechToText().queue({ hang: true }));
      await b.sendMessage(audioMessage());
      await b.settle(3000);
      expect(b.sender.sent).toHaveLength(0);
      await b.settle(7001);
      expect(b.sender.sent[0]?.body).toBe(greeted(R_AUDIO));
    });
  });
});
