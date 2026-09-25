/** US3: fallos del modelo y de la lectura del snapshot (FR-029, Principio V). */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ChatModelError } from '../../../src/conversation/ports.js';
import { createKnowledgeReader } from '../../../src/knowledge/snapshot.js';
import type { KnowledgeReader } from '../../../src/knowledge/types.js';
import {
  createTestBot,
  EMERGENCY_PHONE,
  greeted,
  inboundOf,
  type TestBot,
} from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';

const R_ERR = 'Ahora mismo no puedo responder. Por favor, vuelve a escribirme en unos minutos.';
const CONTACT = 'Para hablar con una persona de Peluquería Tijeras:';

describe('US3: fallos', () => {
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

  async function expectAnsweredOnce(b: TestBot) {
    const inbound = await inboundOf(t);
    expect(inbound.every((m) => m.status === 'answered' && m.replyId !== null)).toBe(true);
    const outbound = (await b.messages()).filter((m) => m.direction === 'outbound');
    expect(outbound).toHaveLength(1);
    // Una segunda pasada no genera otra respuesta.
    await b.settle();
    expect(b.sender.sent).toHaveLength(1);
  }

  it.each(['timeout', 'refusal', 'invalid_output', 'api_error'] as const)(
    'el modelo lanza %s → R-ERR con CONTACTO',
    async (reason) => {
      const b = (bot = await createTestBot(t));
      b.model.queue(new ChatModelError(reason, reason === 'api_error' ? 529 : undefined));
      await b.send('¿abrís el sábado?');
      await b.settle();

      const body = b.sender.sent[0]?.body ?? '';
      expect(body.startsWith(greeted(R_ERR))).toBe(true);
      expect(body).toContain(CONTACT);
      expect(b.log.named('generation_failed')).toEqual([
        expect.objectContaining({ reason, ...(reason === 'api_error' ? { status: 529 } : {}) }),
      ]);
      expect(b.log.named('reply_sent')[0]).toMatchObject({ template: 'R-ERR', contactBlock: true });
      await expectAnsweredOnce(b);
    },
  );

  it('el modelo supera el plazo total → R-ERR con CONTACTO y generation_failed{timeout}', async () => {
    const b = (bot = await createTestBot(t, { settings: { modelBudgetMs: 200 } }));
    b.model.queue({ reply: reply('Tarde.'), realDelayMs: 5_000 });
    await b.send('¿abrís el sábado?');
    await b.settle();

    const body = b.sender.sent[0]?.body ?? '';
    expect(body.startsWith(greeted(R_ERR))).toBe(true);
    expect(body).toContain(CONTACT);
    expect(b.log.named('generation_failed')).toEqual([
      expect.objectContaining({ reason: 'timeout' }),
    ]);
    await expectAnsweredOnce(b);
  });

  it('el snapshot no se puede leer en el procesador → R-ERR con el teléfono de emergencia', async () => {
    let failing = false;
    const real = createKnowledgeReader(t.db);
    const reader: KnowledgeReader = {
      getSnapshot: () =>
        failing ? Promise.reject(new TypeError('conexión perdida')) : real.getSnapshot(),
    };
    const b = (bot = await createTestBot(t, { reader }));
    await b.send('¿abrís el sábado?');
    failing = true;
    await b.settle();

    expect(b.model.calls).toHaveLength(0);
    expect(b.sender.sent[0]?.body).toBe(
      `${R_ERR}\n\nSi necesitas hablar con una persona: teléfono +34 600 99 98 88.`,
    );
    expect(b.sender.sent[0]?.body).not.toContain('Peluquería');
    expect(b.log.named('knowledge_read_failed')).toEqual([
      expect.objectContaining({ errorClass: 'TypeError', stage: 'processor' }),
    ]);
    expect(b.log.named('reply_sent')[0]).toMatchObject({ template: 'R-ERR', contactBlock: true });
    await expectAnsweredOnce(b);
    expect(EMERGENCY_PHONE).toBe('+34600999888');
  });
});
