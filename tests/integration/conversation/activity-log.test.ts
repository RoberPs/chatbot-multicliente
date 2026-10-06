/**
 * Registros técnicos sin datos personales (contracts/activity-log.md, research R11): ninguna
 * línea contiene texto de mensajes, el número en claro ni un id de mensaje de WhatsApp.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LoggerLike } from '../../../src/conversation/activity-log.js';
import { ChatModelError } from '../../../src/conversation/ports.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { FakeMediaFetcher, FakeSpeechToText, reply } from '../../helpers/fakes.js';
import { audioMessage, CUSTOMER_WA, imageMessage } from '../../helpers/whatsapp.js';

const MARK = 'MARCA-7f3a';
const HOUR = 60 * 60 * 1000;

/** Logger que guarda cada línea tal como se serializaría. */
function capturingLogger(lines: string[]): LoggerLike {
  const write = (level: string) => (obj: object, msg?: string) => {
    lines.push(JSON.stringify({ level, ...obj, msg }));
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

describe('registros técnicos sin datos personales', () => {
  let t: TestDatabase;
  let bot: TestBot | null = null;
  const lines: string[] = [];

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

  it('recorre los escenarios y ninguna línea lleva la marca, el número ni un wa_message_id', async () => {
    const stt = new FakeSpeechToText().queue({ text: `${MARK} ¿abrís mañana?` });
    const b = (bot = await createTestBot(t, {
      logger: capturingLogger(lines),
      audio: { stt, media: new FakeMediaFetcher() },
    }));

    // Texto normal.
    b.model.queue(reply(`Respuesta ${MARK}`));
    await b.send(`Hola ${MARK}`, { id: 'wamid.SECRETO-1' });
    await b.settle();
    // Foto con pie.
    await b.sendMessage(imageMessage({ caption: `${MARK} ¿y esto?`, id: 'wamid.SECRETO-2' }));
    await b.settle();
    // Audio transcrito.
    await b.sendMessage(audioMessage({ id: 'wamid.SECRETO-3' }));
    await b.transcriber?.idle();
    await b.settle();
    // Fallo del modelo.
    b.model.queue(new ChatModelError('api_error', 500));
    await b.send(`Otra ${MARK}`, { id: 'wamid.SECRETO-4' });
    await b.settle();
    // Límite por número.
    for (let i = 0; i < 31; i++) await b.send(`${MARK} ${i}`, { id: `wamid.SECRETO-L${i}` });
    await b.settle();
    // Descarte por ventana de 24 h, desde otro número.
    await b.send(`Tarde ${MARK}`, { from: '34611000999', id: 'wamid.SECRETO-5' });
    await b.settle(25 * HOUR);

    const events = new Set(lines.map((l) => (JSON.parse(l) as { event?: string }).event));
    for (const event of [
      'message_received',
      'reply_sent',
      'generation_failed',
      'rate_limit_exceeded',
      'message_discarded',
    ]) {
      expect(events).toContain(event);
    }

    expect(lines.length).toBeGreaterThan(40);
    for (const line of lines) {
      expect(line).not.toContain(MARK);
      expect(line).not.toContain(CUSTOMER_WA);
      expect(line).not.toContain('34611000999');
      expect(line).not.toMatch(/wamid\./);
    }
    // El cliente aparece seudonimizado: 12 caracteres hexadecimales.
    const customers = lines
      .map((l) => (JSON.parse(l) as { customer?: string }).customer)
      .filter((c): c is string => c !== undefined);
    expect(customers.length).toBeGreaterThan(0);
    for (const c of customers) expect(c).toMatch(/^[0-9a-f]{12}$/);
  });
});
