/**
 * Reintentos de un lote que falla (012, US5, R10; contracts/outbound-and-retries.md § Reintentos
 * de un lote) con reloj falso: esperas de 5 s, 30 s, 2 min y 10 min; al quinto fallo, una sola
 * disculpa con el contacto cubriendo los pendientes; tras un éxito el contador vuelve a 0; un
 * entrante nuevo durante la espera se une al lote.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { conversation, message } from '../../src/db/schema.js';
import { createTestBot, type TestBot } from '../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { reply } from '../helpers/fakes.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const APOLOGY = 'Ahora mismo no puedo responder.';
const CONTACT = 'Para hablar con una persona de Peluquería Tijeras:';

describe('reintentos de los lotes', () => {
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

  /** Bot cuyo lote lanza (BD caída a mitad) mientras `broken` sea cierto. */
  async function failing(): Promise<{ b: TestBot; fix: () => void }> {
    const b = (bot = await createTestBot(t));
    const original = b.handoff.hasEnded.bind(b.handoff);
    let broken = true;
    b.handoff.hasEnded = async (id) => {
      if (broken) throw new Error('BD caída');
      return original(id);
    };
    return {
      b,
      fix: () => {
        broken = false;
      },
    };
  }

  const state = async () => (await t.db.select().from(conversation))[0];

  it('esperas 5 s, 30 s, 2 min y 10 min; al quinto, una disculpa con contacto y contador a 0', async () => {
    const { b } = await failing();
    await b.send('¿A qué hora abrís?');
    await b.settle();
    expect(b.log.named('batch_retry_scheduled')).toEqual([
      expect.objectContaining({ attempt: 1, delayMs: 5 * SECOND, errorClass: 'Error' }),
    ]);
    expect((await state())?.batchAttempts).toBe(1);

    // No se reclama antes de la espera.
    await b.settle(4 * SECOND);
    expect(b.log.named('batch_retry_scheduled')).toHaveLength(1);

    for (const [wait, next] of [
      [1 * SECOND, 30 * SECOND],
      [30 * SECOND, 2 * MINUTE],
      [2 * MINUTE, 10 * MINUTE],
    ] as const) {
      await b.settle(wait);
      expect(b.log.named('batch_retry_scheduled').at(-1)).toMatchObject({ delayMs: next });
    }
    expect(b.sender.sent).toEqual([]);

    await b.settle(10 * MINUTE);
    expect(b.log.named('batch_abandoned')).toEqual([
      expect.objectContaining({ attempts: 5, apologySent: true }),
    ]);
    expect(b.sender.sent).toHaveLength(1);
    expect(b.sender.sent[0]?.body).toContain(APOLOGY);
    expect(b.sender.sent[0]?.body).toContain(CONTACT);
    const inbound = await t.db.select().from(message).where(eq(message.direction, 'inbound'));
    expect(inbound.map((m) => m.status)).toEqual(['answered']);
    expect(await state()).toMatchObject({ batchAttempts: 0, processAfter: null });

    // Nada se repite: otra pasada no manda otra disculpa.
    await b.settle(10 * MINUTE);
    expect(b.sender.sent).toHaveLength(1);
  });

  it('tras un éxito el contador vuelve a 0; un entrante nuevo durante la espera se une al lote', async () => {
    const { b, fix } = await failing();
    await b.send('¿A qué hora abrís?');
    await b.settle();
    await b.settle(5 * SECOND);
    expect((await state())?.batchAttempts).toBe(2);

    // Durante la espera de 30 s llega otro mensaje y se arregla la BD.
    await b.send('¿Y los sábados?');
    fix();
    b.model.queue(reply('Abrimos de martes a sábado.'));
    await b.settle(30 * SECOND);

    expect(b.sender.sent).toHaveLength(1);
    expect(b.model.calls).toHaveLength(1);
    const inbound = await t.db.select().from(message).where(eq(message.direction, 'inbound'));
    expect(inbound.map((m) => m.status)).toEqual(['answered', 'answered']);
    expect((await state())?.batchAttempts).toBe(0);
  });
});
