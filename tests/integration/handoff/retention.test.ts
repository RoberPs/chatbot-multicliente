/**
 * FR-023 (005): la retención de 30 días borra la conversación derivada y con ella sus
 * derivaciones (activas o terminadas), los avisos al negocio y los datos de contacto y el paso
 * de la derivación, que viven en la conversación. Los contadores diarios de la 012 duran 400 días.
 */
import { asc } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createRetention } from '../../../src/conversation/retention.js';
import {
  conversation,
  handoff,
  handoffDay,
  handoffNotice,
  message,
} from '../../../src/db/schema.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';

const DAY = 24 * 60 * 60 * 1000;
const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const WEB_ON = { enabled: true, allowedOrigins: ['https://negocio.example'] };
const OTHER_WEB = 'cd'.repeat(32);

describe('retención de la derivación (FR-023)', () => {
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

  it('a los 30 días borra derivaciones, avisos, datos de contacto y paso; lo reciente se queda', async () => {
    const b = (bot = await createTestBot(t, { handoffAlerts: ALERTS, webChat: WEB_ON }));
    // Derivación terminada y otra activa en la misma conversación web, con reenvío.
    b.model.queue(
      reply('De acuerdo.', { handoffRequested: true }),
      reply('Gracias.', { contactName: 'Lucía', contactPhone: '612 345 678' }),
      reply('De acuerdo.', { handoffRequested: true }),
    );
    await b.sendVia('web', 'Quiero hablar con una persona');
    await b.settle();
    await b.sendVia('web', 'Lucía, 612 345 678');
    await b.settle();
    const [first] = await t.db.select().from(handoff);
    if (!first) throw new Error('Sin derivación');
    await b.handoff.endByOperator(first.id, 'operator');
    await b.sendVia('web', 'Otra vez: quiero hablar con alguien');
    await b.settle();
    await b.sendVia('web', 'Sigo aquí');
    // Reenvío agrupado (012): sale al cumplirse el intervalo.
    await b.settle(15 * 60 * 1000);
    expect(await t.db.select().from(handoff)).toHaveLength(2);
    expect((await t.db.select().from(handoffNotice)).length).toBeGreaterThanOrEqual(5);

    // Otro cliente, 20 días después, a mitad de pedir sus datos.
    b.clock.advance(20 * DAY);
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.sendVia('web', 'Quiero hablar con una persona', { user: OTHER_WEB });
    await b.settle();

    b.clock.advance(11 * DAY);
    await createRetention({ db: t.db, clock: b.clock, activityLog: b.log }).purge();

    expect(await t.db.select().from(handoff)).toEqual([]);
    expect(await t.db.select().from(handoffNotice)).toEqual([]);
    const rest = await t.db.select().from(conversation);
    // Solo queda la conversación reciente, con su paso de derivación.
    expect(rest).toHaveLength(1);
    expect(rest[0]).toMatchObject({
      contactName: null,
      contactPhone: null,
      handoffStep: { step: 'collecting' },
    });
    const bodies = (await t.db.select().from(message)).map((m) => m.body ?? '');
    expect(bodies.join('\n')).not.toContain('Lucía');
  });

  it('012: purga handoff_day de hace más de 400 días en la misma pasada', async () => {
    const b = (bot = await createTestBot(t));
    // 2026-09-24 − 400 días = 2025-08-20.
    await t.db.insert(handoffDay).values([
      { day: '2025-08-19', started: 1 },
      { day: '2025-08-20', started: 2 },
      { day: '2026-09-24', started: 3 },
    ]);
    await createRetention({ db: t.db, clock: b.clock, activityLog: b.log }).purge();
    const rows = await t.db
      .select({ day: handoffDay.day })
      .from(handoffDay)
      .orderBy(asc(handoffDay.day));
    expect(rows.map((r) => r.day)).toEqual(['2025-08-20', '2026-09-24']);
  });
});
