/**
 * US5 (005, FR-009 – FR-011, R13): con el negocio cerrado, el aviso sale en el momento y la
 * confirmación al cliente da la próxima franja de atención, con los cierres puntuales, el
 * horario del contacto de derivación y la zona horaria del negocio.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handoff } from '../../../src/db/schema.js';
import { createTestBot, greeted, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';
import { hairSalon } from '../../fixtures/hair-salon.js';
import { weekdays, type BusinessFixture } from '../../fixtures/types.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const PREFIX = 'He avisado a Peluquería Tijeras.';
const CLOSED = `${PREFIX} Ahora mismo no están atendiendo; te contactarán en el +34 600 11 12 22`;

/** Abre de lunes a viernes de 9:00 a 20:00. */
const weekdaysOnly: BusinessFixture = {
  ...hairSalon,
  hours: weekdays([1, 2, 3, 4, 5], '09:00', '20:00'),
};

describe('US5: derivación fuera de horario', () => {
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
   * Pide una persona por WhatsApp de forma que la derivación empiece en ese instante (la espera
   * de agrupado son 3 s) y devuelve la confirmación sin el saludo de la primera respuesta.
   */
  async function requestAt(at: string, fixture: BusinessFixture = hairSalon) {
    const start = new Date(Date.parse(at) - 3000).toISOString();
    const b = (bot = await createTestBot(t, { handoffAlerts: ALERTS, fixture, start }));
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();
    const body = b.sender.sent.at(-1)?.body ?? '';
    expect(body.startsWith(greeted(''))).toBe(true);
    return { b, text: body.slice(greeted('').length) };
  }

  it('sábado por la noche: "el lunes … a las 9:00" y el aviso sale en el momento (FR-009)', async () => {
    // Sábado 3 de octubre, 22:00 en Madrid.
    const { b, text } = await requestAt('2026-10-03T20:00:00Z', weekdaysOnly);
    expect(text).toBe(`${CLOSED} a partir del lunes 5 de octubre a las 9:00.`);
    expect(b.alertRoutes.whatsapp.received).toHaveLength(1);
    expect(b.alertRoutes.email.received).toHaveLength(1);
    const [row] = await t.db.select().from(handoff);
    expect(row?.status).toBe('active');
    // Recordatorio a las 2 h de horario: el lunes a las 11:00.
    expect(row?.reminderDueAt?.toISOString()).toBe('2026-10-05T09:00:00.000Z');
    expect(b.log.named('handoff_started')).toEqual([expect.objectContaining({ afterHours: true })]);
  });

  it('cierre puntual mañana derivando la víspera: primera franja tras el cierre (US5-2)', async () => {
    const withClosure: BusinessFixture = {
      ...hairSalon,
      closures: [{ start_date: '2026-10-01', end_date: '2026-10-01', reason: 'Inventario' }],
    };
    // Miércoles 30 de septiembre, 21:00: el jueves está cerrado; abre el viernes a las 10:00.
    const { text } = await requestAt('2026-09-30T19:00:00Z', withClosure);
    expect(text).toBe(`${CLOSED} a partir del viernes 2 de octubre a las 10:00.`);
  });

  it('manda el horario del contacto de derivación, no el del negocio (FR-011)', async () => {
    const mondayMornings: BusinessFixture = {
      ...hairSalon,
      handoff: { ...hairSalon.handoff, slots: [[1, '09:00', '14:00']] },
    };
    // Jueves 24 de septiembre, 10:00: el negocio abre, pero el contacto solo atiende los lunes.
    const { b, text } = await requestAt('2026-09-24T08:00:00Z', mondayMornings);
    expect(text).toBe(`${CLOSED} a partir del lunes 28 de septiembre a las 9:00.`);
    expect(b.log.named('handoff_started')).toEqual([expect.objectContaining({ afterHours: true })]);
  });

  it('mismo día, antes de abrir: "hoy a las …"', async () => {
    // Jueves 24 de septiembre, 8:00: abre a las 10:00.
    const { text } = await requestAt('2026-09-24T06:00:00Z');
    expect(text).toBe(`${CLOSED} a partir de hoy a las 10:00.`);
  });

  it('negocio abierto: sin horarios (US5-3)', async () => {
    const { b, text } = await requestAt('2026-09-24T08:00:00Z');
    expect(text).toBe(`${PREFIX} Te contactarán en el +34 600 11 12 22 lo antes posible.`);
    expect(b.log.named('handoff_started')).toEqual([
      expect.objectContaining({ afterHours: false }),
    ]);
  });

  it('cerrado sin franja en 60 días: "en cuanto puedan"', async () => {
    const longClosure: BusinessFixture = {
      ...hairSalon,
      closures: [{ start_date: '2026-09-24', end_date: '2027-01-31', reason: 'Reforma' }],
    };
    const { b, text } = await requestAt('2026-09-24T08:00:00Z', longClosure);
    expect(text).toBe(`${CLOSED} en cuanto puedan.`);
    const [row] = await t.db.select().from(handoff);
    // Sin horario en 60 días no hay recordatorio por horario; queda el de inactividad.
    expect(row?.reminderDueAt).toBeNull();
    expect(b.log.named('handoff_started')).toEqual([expect.objectContaining({ afterHours: true })]);
  });
});
