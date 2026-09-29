/**
 * US5 (005, FR-019, SC-009, R13, R14): si el negocio no confirma en 2 horas de su horario,
 * recibe un recordatorio y el cliente, un único R-HANDOFF-LATE con el contacto directo. Si la
 * conversación vuelve antes al bot por inactividad, el recordatorio sale entonces y sin mensaje
 * al cliente.
 */
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handoff, handoffNotice, message } from '../../../src/db/schema.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';
import { hairSalon } from '../../fixtures/hair-salon.js';
import { weekdays, type BusinessFixture } from '../../fixtures/types.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const CUSTOMER = '+34600111222';
const LATE =
  'Peluquería Tijeras todavía no ha podido responderte. Si lo prefieres, puedes contactar ' +
  'directamente:\n\nPara hablar con una persona de Peluquería Tijeras: WhatsApp +34 612 34 56 78.';
const MINUTE = 60_000;

describe('US5: recordatorio a las 2 h de horario', () => {
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

  /**
   * Deriva por WhatsApp en ese instante. Por defecto, el jueves 24 de septiembre a las 19:00:
   * queda 1 h de horario el jueves y el recordatorio vence el viernes a las 11:00.
   */
  async function derivedAt(at = '2026-09-24T17:00:00Z', fixture: BusinessFixture = hairSalon) {
    // La espera de agrupado son 3 s: la derivación empieza justo en `at`.
    const start = new Date(Date.parse(at) - 3000).toISOString();
    const b = (bot = await createTestBot(t, { handoffAlerts: ALERTS, fixture, start }));
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();
    const token = b.alertRoutes.whatsapp.received[0]?.handoff.token;
    if (!token) throw new Error('Sin derivación');
    return { b, token };
  }

  const status = async () => (await t.db.select().from(handoff))[0];
  const reminderRows = () =>
    t.db.select().from(handoffNotice).where(eq(handoffNotice.type, 'reminder'));
  const types = (b: TestBot) => ({
    whatsapp: b.alertRoutes.whatsapp.received.map((n) => n.type),
    email: b.alertRoutes.email.received.map((n) => n.type),
  });

  it('a 1 h 59 min de horario no pasa nada; a 2 h, un recordatorio por vía y un R-HANDOFF-LATE', async () => {
    const { b } = await derivedAt();
    const sent = b.sender.sent.length;
    expect((await status())?.reminderDueAt?.toISOString()).toBe('2026-09-25T09:00:00.000Z');

    // Viernes 10:59: 1 h 59 min de horario (la noche no cuenta).
    b.clock.set('2026-09-25T08:59:00Z');
    await b.handoff.sweep();
    expect(types(b)).toEqual({ whatsapp: ['alert'], email: ['alert'] });
    expect(b.sender.sent).toHaveLength(sent);

    b.clock.advance(MINUTE);
    await b.handoff.sweep();
    expect(types(b)).toEqual({ whatsapp: ['alert', 'reminder'], email: ['alert', 'reminder'] });
    expect(b.alertRoutes.email.received[1]).toMatchObject({ trigger: 'schedule' });
    expect(b.sender.sent).toHaveLength(sent + 1);
    expect(b.sender.sent.at(-1)).toMatchObject({ to: CUSTOMER, body: LATE });

    // Saliente guardado con su información técnica y sin cubrir entrantes.
    const [late] = await t.db
      .select()
      .from(message)
      .where(eq(message.direction, 'outbound'))
      .orderBy(asc(message.sentAt))
      .then((rows) => rows.slice(-1));
    expect(late).toMatchObject({ body: LATE, status: 'sent' });
    expect(late?.replyTrace).toMatchObject({
      template: 'R-HANDOFF-LATE',
      greeting: false,
      contact: { added: true, reason: 'template' },
      handoff: { action: 'late_notice', kind: 'person' },
    });
    expect(await reminderRows()).toHaveLength(2);
    expect(b.log.named('handoff_reminder_sent')).toEqual([
      expect.objectContaining({ trigger: 'schedule', customerNotified: true }),
    ]);
    // La conversación sigue derivada.
    expect(await status()).toMatchObject({ status: 'active', confirmedAt: null });
  });

  it('barridos siguientes y dos barridos a la vez no lo repiten (SC-009)', async () => {
    const { b } = await derivedAt();
    const sent = b.sender.sent.length;
    b.clock.set('2026-09-25T09:00:00Z');
    await Promise.all([b.handoff.sweep(), b.handoff.sweep()]);
    b.clock.advance(10 * MINUTE);
    await b.handoff.sweep();
    await b.handoff.sweep();
    expect(types(b)).toEqual({ whatsapp: ['alert', 'reminder'], email: ['alert', 'reminder'] });
    expect(b.sender.sent).toHaveLength(sent + 1);
    expect(await reminderRows()).toHaveLength(2);
    expect(b.log.named('handoff_reminder_sent')).toHaveLength(1);
  });

  it('confirmada antes: sin recordatorio', async () => {
    const { b, token } = await derivedAt();
    const sent = b.sender.sent.length;
    b.clock.set('2026-09-25T08:00:00Z');
    expect(
      (await b.app.inject({ method: 'POST', url: `/handoff/${token}/attend` })).statusCode,
    ).toBe(200);
    b.clock.set('2026-09-25T12:00:00Z');
    await b.handoff.sweep();
    expect(types(b)).toEqual({ whatsapp: ['alert'], email: ['alert'] });
    expect(b.sender.sent).toHaveLength(sent);
    expect(b.log.named('handoff_reminder_sent')).toEqual([]);
  });

  it('WhatsApp con la ventana cerrada: recordatorio al negocio, nada al cliente', async () => {
    const { b } = await derivedAt();
    const sent = b.sender.sent.length;
    // La ventana (24 h) y la inactividad (24 h) cierran a la vez; para ver la ventana cerrada
    // con la derivación activa se acorta la ventana del canal.
    const policy = b.policies.whatsapp;
    if (!policy) throw new Error('Sin WhatsApp');
    policy.replyWindowMs = 60 * MINUTE;
    b.clock.set('2026-09-25T09:00:00Z');
    await b.handoff.sweep();
    expect(types(b)).toEqual({ whatsapp: ['alert', 'reminder'], email: ['alert', 'reminder'] });
    expect(b.sender.sent).toHaveLength(sent);
    expect(b.log.named('handoff_reminder_sent')).toEqual([
      expect.objectContaining({ trigger: 'schedule', customerNotified: false }),
    ]);
    // No se reintenta: ni guardado para después ni en el siguiente barrido.
    b.clock.advance(MINUTE);
    await b.handoff.sweep();
    expect(b.sender.sent).toHaveLength(sent);
    expect(await status()).toMatchObject({ status: 'active' });
  });

  it('viernes 21:00 con apertura el lunes: el sábado 21:00 se cierra por inactividad y el lunes no sale nada más', async () => {
    const weekdaysOnly: BusinessFixture = {
      ...hairSalon,
      hours: weekdays([1, 2, 3, 4, 5], '09:00', '20:00'),
    };
    const { b } = await derivedAt('2026-10-02T19:00:00Z', weekdaysOnly);
    const sent = b.sender.sent.length;
    expect((await status())?.reminderDueAt?.toISOString()).toBe('2026-10-05T09:00:00.000Z');

    b.clock.set('2026-10-03T18:59:00Z');
    await b.handoff.sweep();
    expect(types(b)).toEqual({ whatsapp: ['alert'], email: ['alert'] });

    b.clock.set('2026-10-03T19:00:00Z');
    await b.handoff.sweep();
    expect(await status()).toMatchObject({ status: 'ended', endCause: 'inactivity' });
    expect(types(b)).toEqual({ whatsapp: ['alert', 'reminder'], email: ['alert', 'reminder'] });
    expect(b.alertRoutes.whatsapp.received[1]).toMatchObject({ trigger: 'inactivity' });
    expect(b.sender.sent).toHaveLength(sent);

    b.clock.set('2026-10-05T09:30:00Z');
    await b.handoff.sweep();
    expect(types(b)).toEqual({ whatsapp: ['alert', 'reminder'], email: ['alert', 'reminder'] });
    expect(b.sender.sent).toHaveLength(sent);
    expect(b.log.named('handoff_reminder_sent')).toEqual([
      expect.objectContaining({ trigger: 'inactivity', customerNotified: false }),
    ]);
  });
});
