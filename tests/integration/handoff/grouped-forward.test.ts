/**
 * US2 (012, FR-014, SC-003; contracts/handoff-limits.md § Reenvío durante la derivación): con una
 * derivación activa, lo que escribe el cliente se reenvía como mucho una vez por intervalo desde
 * el último aviso (alerta, reenvío o recordatorio), en un solo aviso con todo lo acumulado; sin
 * plaza diaria espera al día siguiente. Ningún mensaje se pierde y el cliente no nota nada.
 */
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  conversation,
  handoff,
  handoffDay,
  handoffLimits,
  message,
} from '../../../src/db/schema.js';
import { readHandoffDay } from '../../../src/handoff/limits.js';
import {
  FORWARD_TEMPLATE_MAX,
  forwardEmail,
  forwardTemplateVars,
} from '../../../src/handoff/notices.js';
import type { BusinessNotice } from '../../../src/handoff/types.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply, type FakeAlertRoute } from '../../helpers/fakes.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const MINUTE = 60_000;
const INTERVAL = 15 * MINUTE;
const TODAY = '2026-09-24';

type Forward = Extract<BusinessNotice, { type: 'forward' }>;
const forwards = (route: FakeAlertRoute) =>
  route.received.filter((n): n is Forward => n.type === 'forward');

describe('US2: reenvío agrupado', () => {
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

  /** Derivación activa por WhatsApp; devuelve el bot y la hora de la alerta. */
  async function derived(): Promise<{ b: TestBot; alertAt: Date }> {
    // Sin el límite por cliente: aquí se prueba solo el agrupado.
    const b = (bot = await createTestBot(t, {
      handoffAlerts: ALERTS,
      settings: { rateLimitMessages: 1000 },
    }));
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();
    const [row] = await t.db.select().from(handoff);
    if (!row) throw new Error('sin derivación');
    return { b, alertAt: row.startedAt };
  }

  const inbound = () =>
    t.db
      .select({ body: message.body, status: message.status })
      .from(message)
      .where(eq(message.direction, 'inbound'))
      .orderBy(asc(message.receivedAt));

  const processAfter = async () => (await t.db.select().from(conversation))[0]?.processAfter;

  it('mensajes seguidos → como mucho un aviso por intervalo y ninguno se pierde (SC-003)', async () => {
    const { b, alertAt } = await derived();
    // Intervalo mínimo (5 min) y 30 mensajes cada 30 s: cruzan dos intervalos, que es lo que
    // prueba SC-003, sin los 100 lotes del enunciado.
    const interval = 5 * MINUTE;
    await t.db.update(handoffLimits).set({ forwardIntervalMinutes: 5 });
    const total = 30;
    const sentBefore = b.sender.sent.length;
    const forwardTimes: number[] = [];
    for (let i = 1; i <= total; i++) {
      await b.send(`mensaje ${String(i)}`);
      const before = forwards(b.alertRoutes.whatsapp).length;
      await b.settle(30_000);
      if (forwards(b.alertRoutes.whatsapp).length > before)
        forwardTimes.push(b.clock.now().getTime());
    }
    await b.settle(interval);

    const all = forwards(b.alertRoutes.whatsapp);
    // 30 mensajes en 15 min: reenvíos a los 5, 10 y 15 min de la alerta y el resto al vencer.
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.length).toBeLessThanOrEqual(4);
    const times = [alertAt.getTime(), ...forwardTimes];
    for (let i = 1; i < times.length; i++) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(interval);
    }
    expect(all.flatMap((f) => f.items.map((i) => i.text))).toEqual(
      Array.from({ length: total }, (_, i) => `mensaje ${String(i + 1)}`),
    );
    expect(forwards(b.alertRoutes.email)).toHaveLength(all.length);
    expect((await inbound()).slice(1).every((m) => m.status === 'forwarded')).toBe(true);
    // El cliente no recibe nada mientras tanto.
    expect(b.sender.sent).toHaveLength(sentBefore);
    expect(b.model.calls).toHaveLength(1);
    // Un aviso por reenvío (no por vía) más la alerta.
    expect((await readHandoffDay(t.db, TODAY)).notices).toBe(1 + all.length);
  });

  it('dentro del intervalo los entrantes siguen pending con process_after y al vencer sale un reenvío con todos', async () => {
    const { b, alertAt } = await derived();
    await b.send('Llegaré sobre las cinco');
    await b.settle();
    b.clock.advance(MINUTE);
    await b.send('¿Os viene bien?');
    await b.settle();

    expect(forwards(b.alertRoutes.whatsapp)).toEqual([]);
    expect((await inbound()).slice(1)).toEqual([
      { body: 'Llegaré sobre las cinco', status: 'pending' },
      { body: '¿Os viene bien?', status: 'pending' },
    ]);
    expect(await processAfter()).toEqual(new Date(alertAt.getTime() + INTERVAL));
    // El segundo ya no se reclama antes de `process_after`: se une al lote que espera.
    expect(b.log.named('handoff_forward_deferred')).toEqual([
      expect.objectContaining({ messages: 1, reason: 'interval' }),
    ]);

    // Antes de vencer no se reclama.
    b.clock.set(new Date(alertAt.getTime() + INTERVAL - 1000));
    await b.processor.runOnce();
    expect(forwards(b.alertRoutes.whatsapp)).toEqual([]);

    b.clock.set(new Date(alertAt.getTime() + INTERVAL));
    await b.processor.runOnce();
    const [fwd] = forwards(b.alertRoutes.whatsapp);
    expect(forwards(b.alertRoutes.whatsapp)).toHaveLength(1);
    expect(fwd?.items.map((i) => i.text)).toEqual(['Llegaré sobre las cinco', '¿Os viene bien?']);
    expect(await processAfter()).toBeNull();
    const [row] = await t.db.select().from(handoff);
    expect(row?.lastNoticeAt).toEqual(new Date(alertAt.getTime() + INTERVAL));

    // Email con la hora de cada mensaje; la plantilla, unida.
    if (!fwd) throw new Error('sin reenvío');
    const email = forwardEmail(fwd, 'https://negocio.example').text;
    expect(email).toMatch(/10:00[\s\S]*Llegaré sobre las cinco[\s\S]*10:01[\s\S]*¿Os viene bien\?/);
    expect(forwardTemplateVars(fwd).join(' ')).toContain('Llegaré sobre las cinco');
  });

  it('el reenvío por plantilla une los mensajes y no pasa de 700 caracteres', async () => {
    const { b, alertAt } = await derived();
    for (let i = 0; i < 20; i++) {
      await b.send(`Mensaje largo número ${String(i)}: ${'texto '.repeat(10)}`);
      b.clock.advance(1000);
    }
    b.clock.set(new Date(alertAt.getTime() + INTERVAL));
    await b.processor.runOnce();
    const [fwd] = forwards(b.alertRoutes.whatsapp);
    expect(fwd?.items).toHaveLength(20);
    if (!fwd) throw new Error('sin reenvío');
    for (const v of forwardTemplateVars(fwd)) {
      expect(v.length).toBeLessThanOrEqual(FORWARD_TEMPLATE_MAX);
    }
  });

  it('sin plaza de aviso diaria → espera a las 00:00 locales del día siguiente (daily_limit)', async () => {
    const { b, alertAt } = await derived();
    await t.db.update(handoffDay).set({ notices: 60 }).where(eq(handoffDay.day, TODAY));
    await b.send('¿Me llamáis hoy?');
    b.clock.set(new Date(alertAt.getTime() + INTERVAL));
    await b.processor.runOnce();

    expect(forwards(b.alertRoutes.whatsapp)).toEqual([]);
    // 00:00 del 25/09 en Madrid (UTC+2).
    expect(await processAfter()).toEqual(new Date('2026-09-24T22:00:00Z'));
    expect((await inbound()).at(-1)).toEqual({ body: '¿Me llamáis hoy?', status: 'pending' });
    expect((await readHandoffDay(t.db, TODAY)).noticesHeld).toBe(1);
    expect(b.log.named('handoff_forward_deferred').at(-1)).toMatchObject({
      messages: 1,
      reason: 'daily_limit',
    });
    expect(b.log.named('business_notices_held')).toEqual([
      { event: 'business_notices_held', max: 60 },
    ]);

    // Al empezar el día siguiente sale el reenvío.
    b.clock.set('2026-09-24T22:00:00Z');
    await b.processor.runOnce();
    expect(forwards(b.alertRoutes.whatsapp)).toHaveLength(1);
    expect((await inbound()).at(-1)?.status).toBe('forwarded');
    expect((await readHandoffDay(t.db, '2026-09-25')).notices).toBe(1);
  });

  it('el intervalo también cuenta desde cada recordatorio', async () => {
    const { b, alertAt } = await derived();
    // Recordatorio a las 2 h de horario sin confirmar.
    b.clock.set(new Date(alertAt.getTime() + 2 * 60 * MINUTE + MINUTE));
    await b.handoff.sweep();
    const reminderAt = b.clock.now();
    expect(b.alertRoutes.whatsapp.received.map((n) => n.type)).toEqual(['alert', 'reminder']);

    b.clock.advance(MINUTE);
    await b.send('¿Sigue ahí alguien?');
    await b.settle();
    expect(forwards(b.alertRoutes.whatsapp)).toEqual([]);
    expect(await processAfter()).toEqual(new Date(reminderAt.getTime() + INTERVAL));

    b.clock.set(new Date(reminderAt.getTime() + INTERVAL));
    await b.processor.runOnce();
    expect(forwards(b.alertRoutes.whatsapp)).toHaveLength(1);
  });
});
