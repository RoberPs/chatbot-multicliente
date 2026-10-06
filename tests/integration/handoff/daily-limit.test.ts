/**
 * US2 (012, FR-013, Principio V; contracts/handoff-limits.md § Derivación nueva): con las
 * derivaciones nuevas o los avisos del día agotados, una petición de persona no avisa al negocio
 * y el cliente recibe R-HANDOFF-FAIL con el contacto. Pedir persona con una derivación ya activa
 * no es una derivación nueva.
 */
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handoff, handoffDay, message } from '../../../src/db/schema.js';
import { readHandoffDay } from '../../../src/handoff/limits.js';
import { createTestBot, type TestBot, type TestBotOptions } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const WEB_ON = { enabled: true, allowedOrigins: ['https://negocio.example'] };
const FAIL = 'No he podido avisar a Peluquería Tijeras ahora mismo.';
const CONTACT = 'Para hablar con una persona de Peluquería Tijeras:';
/** Día local del reloj de los tests (jueves 24/09/2026, 10:00 en Madrid). */
const TODAY = '2026-09-24';

describe('US2: derivación nueva con el límite diario', () => {
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

  const start = async (opts: TestBotOptions = {}) =>
    (bot = await createTestBot(t, { handoffAlerts: ALERTS, ...opts }));

  /** Contadores de hoy fijados a mano (los límites por defecto: 20 derivaciones y 60 avisos). */
  const setToday = (values: { started?: number; notices?: number }) =>
    t.db.insert(handoffDay).values({ day: TODAY, ...values });

  const lastOutbound = async () => {
    const rows = await t.db
      .select({ body: message.body, replyTrace: message.replyTrace })
      .from(message)
      .where(eq(message.direction, 'outbound'))
      .orderBy(asc(message.sentAt));
    return rows.at(-1);
  };

  const received = (b: TestBot) =>
    b.alertRoutes.whatsapp.received.length + b.alertRoutes.email.received.length;

  it('WhatsApp con started = daily_max → R-HANDOFF-FAIL + CONTACTO, nada al negocio y refused + 1', async () => {
    const b = await start();
    await setToday({ started: 20 });
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();

    const out = await lastOutbound();
    expect(out?.body).toContain(FAIL);
    expect(out?.body).toContain(CONTACT);
    expect(out?.replyTrace).toMatchObject({
      template: 'R-HANDOFF-FAIL',
      contact: { added: true, reason: 'handoff_unavailable' },
      handoff: { action: 'not_started', kind: 'person' },
    });
    expect(received(b)).toBe(0);
    expect(b.summarizer.calls).toEqual([]);
    expect(await t.db.select().from(handoff)).toEqual([]);
    expect(await readHandoffDay(t.db, TODAY)).toEqual({
      started: 20,
      refused: 1,
      notices: 0,
      noticesHeld: 0,
    });
    expect(b.log.named('handoff_not_started')).toEqual([
      expect.objectContaining({ kind: 'person', reason: 'daily_limit' }),
    ]);
    expect(b.log.named('handoff_daily_limit')).toEqual([{ event: 'handoff_daily_limit', max: 20 }]);

    // Una segunda petición el mismo día suma, pero el evento ya salió.
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Por favor, una persona');
    await b.settle();
    expect((await readHandoffDay(t.db, TODAY)).refused).toBe(2);
    expect(b.log.named('handoff_daily_limit')).toHaveLength(1);
  });

  it('web con started = daily_max → lo mismo tras dar nombre y teléfono', async () => {
    const b = await start({ webChat: WEB_ON });
    await setToday({ started: 20 });
    b.model.queue(
      reply('De acuerdo.', { handoffRequested: true }),
      reply('Gracias.', { contactName: 'Lucía', contactPhone: '612 345 678' }),
    );
    await b.sendVia('web', 'Quiero hablar con alguien');
    await b.settle();
    await b.sendVia('web', 'Lucía, 612 345 678');
    await b.settle();

    const out = await lastOutbound();
    expect(out?.body).toContain(FAIL);
    expect(out?.body).toContain(CONTACT);
    expect(out?.replyTrace).toMatchObject({ template: 'R-HANDOFF-FAIL' });
    expect(received(b)).toBe(0);
    expect((await readHandoffDay(t.db, TODAY)).refused).toBe(1);
    expect(b.log.named('handoff_not_started')).toEqual([
      expect.objectContaining({ reason: 'daily_limit' }),
    ]);
  });

  it('con plaza de derivación pero sin plaza de aviso → R-HANDOFF-FAIL y notices_held + 1', async () => {
    const b = await start();
    await setToday({ started: 3, notices: 60 });
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();

    const out = await lastOutbound();
    expect(out?.body).toContain(FAIL);
    expect(out?.body).toContain(CONTACT);
    expect(received(b)).toBe(0);
    expect(await t.db.select().from(handoff)).toEqual([]);
    // La plaza de derivación no se gasta si no hay aviso.
    expect(await readHandoffDay(t.db, TODAY)).toEqual({
      started: 3,
      refused: 0,
      notices: 60,
      noticesHeld: 1,
    });
    expect(b.log.named('handoff_not_started')).toEqual([
      expect.objectContaining({ reason: 'daily_limit' }),
    ]);
    expect(b.log.named('business_notices_held')).toEqual([
      { event: 'business_notices_held', max: 60 },
    ]);
  });

  it('con plaza, la derivación reserva una plaza de derivación y una de aviso', async () => {
    const b = await start();
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();

    expect(await t.db.select().from(handoff)).toHaveLength(1);
    // Un aviso aunque salga por dos vías.
    expect(await readHandoffDay(t.db, TODAY)).toEqual({
      started: 1,
      refused: 0,
      notices: 1,
      noticesHeld: 0,
    });
    const [row] = await t.db.select().from(handoff);
    expect(row?.lastNoticeAt).toEqual(row?.startedAt);
    expect(row?.alertsSentAt).toEqual(row?.startedAt);
    expect(row?.customerNotifiedAt).not.toBeNull();
  });

  it('pedir persona con una derivación activa no es derivación nueva', async () => {
    const b = await start();
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();
    // Ya no queda plaza: si contara como nueva, se rechazaría.
    await t.db.update(handoffDay).set({ started: 20 }).where(eq(handoffDay.day, TODAY));

    await b.send('¿Hay alguien? Quiero hablar con una persona');
    await b.settle(15 * 60_000);

    expect(await t.db.select().from(handoff)).toHaveLength(1);
    expect(b.alertRoutes.whatsapp.received.map((n) => n.type)).toEqual(['alert', 'forward']);
    expect((await readHandoffDay(t.db, TODAY)).refused).toBe(0);
    expect(b.log.named('handoff_not_started')).toEqual([]);
  });
});
