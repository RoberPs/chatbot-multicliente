/**
 * US2 (012, FR-012, FR-014; contracts/handoff-limits.md § Recordatorios y § Reenvío, punto 7):
 * un recordatorio sin plaza diaria no se envía ni se acumula, pero el cliente recibe igualmente
 * R-HANDOFF-LATE; con una derivación activa, lo que pasa del límite por cliente queda
 * `rate_limited`, no se reenvía nunca y R-LIMIT sale una vez por ventana.
 */
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handoff, handoffDay, message } from '../../../src/db/schema.js';
import { readHandoffDay } from '../../../src/handoff/limits.js';
import type { BusinessNotice } from '../../../src/handoff/types.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const MINUTE = 60_000;
const TODAY = '2026-09-24';
const LIMIT_TEXT = 'Has enviado muchos mensajes seguidos';

type Forward = Extract<BusinessNotice, { type: 'forward' }>;

describe('US2: recordatorios y límite por cliente con derivación', () => {
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

  async function derived(): Promise<{ b: TestBot; alertAt: Date }> {
    const b = (bot = await createTestBot(t, { handoffAlerts: ALERTS }));
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();
    const [row] = await t.db.select().from(handoff);
    if (!row) throw new Error('sin derivación');
    return { b, alertAt: row.startedAt };
  }

  const templates = async () =>
    (
      await t.db
        .select({ replyTrace: message.replyTrace })
        .from(message)
        .where(eq(message.direction, 'outbound'))
        .orderBy(asc(message.sentAt))
    ).map((m) => (m.replyTrace as { template?: string } | null)?.template ?? null);

  it('recordatorio sin plaza diaria → no sale ni se acumula, notices_held + 1 y R-HANDOFF-LATE al cliente', async () => {
    const { b, alertAt } = await derived();
    await t.db.update(handoffDay).set({ notices: 60 }).where(eq(handoffDay.day, TODAY));
    // Las 2 h de horario sin confirmar.
    b.clock.set(new Date(alertAt.getTime() + 2 * 60 * MINUTE + MINUTE));
    await b.handoff.sweep();

    expect(b.alertRoutes.whatsapp.received.map((n) => n.type)).toEqual(['alert']);
    expect(b.alertRoutes.email.received.map((n) => n.type)).toEqual(['alert']);
    expect(await readHandoffDay(t.db, TODAY)).toMatchObject({ notices: 60, noticesHeld: 1 });
    expect(b.log.named('business_notices_held')).toEqual([
      { event: 'business_notices_held', max: 60 },
    ]);
    expect((await templates()).at(-1)).toBe('R-HANDOFF-LATE');
    const [row] = await t.db.select().from(handoff);
    expect(row?.reminderSentAt).not.toBeNull();

    // No se acumula: otro barrido (incluso con plaza) no lo envía.
    await t.db.update(handoffDay).set({ notices: 0 }).where(eq(handoffDay.day, TODAY));
    b.clock.advance(MINUTE);
    await b.handoff.sweep();
    expect(b.alertRoutes.whatsapp.received.map((n) => n.type)).toEqual(['alert']);
    expect((await readHandoffDay(t.db, TODAY)).noticesHeld).toBe(1);
  });

  it('recordatorio con plaza → sale, reserva un aviso y reinicia el intervalo', async () => {
    const { b, alertAt } = await derived();
    b.clock.set(new Date(alertAt.getTime() + 2 * 60 * MINUTE + MINUTE));
    await b.handoff.sweep();
    expect(b.alertRoutes.whatsapp.received.map((n) => n.type)).toEqual(['alert', 'reminder']);
    expect((await readHandoffDay(t.db, TODAY)).notices).toBe(2);
    const [row] = await t.db.select().from(handoff);
    expect(row?.lastNoticeAt).toEqual(b.clock.now());
  });

  it('por encima del límite por cliente: rate_limited, nunca reenviados y un R-LIMIT por ventana', async () => {
    const { b } = await derived();
    // Con la petición ya son 30 en la ventana: los dos siguientes la superan.
    for (let i = 0; i < 29; i++) {
      await b.send(`mensaje ${String(i + 1)}`);
      b.clock.advance(1000);
    }
    await b.send('limitado 1');
    await b.processor.runOnce();
    await b.send('limitado 2');
    await b.settle();
    await b.settle(15 * MINUTE);

    const forwarded = b.alertRoutes.whatsapp.received
      .filter((n): n is Forward => n.type === 'forward')
      .flatMap((f) => f.items.map((i) => i.text));
    expect(forwarded).toHaveLength(29);
    expect(forwarded).not.toContain('limitado 1');
    expect(forwarded).not.toContain('limitado 2');
    const limited = await t.db
      .select({ body: message.body, status: message.status })
      .from(message)
      .where(eq(message.status, 'rate_limited'));
    expect(limited.map((m) => m.body).sort()).toEqual(['limitado 1', 'limitado 2']);
    expect(b.sender.sent.filter((s) => s.body.includes(LIMIT_TEXT))).toHaveLength(1);
  });
});
