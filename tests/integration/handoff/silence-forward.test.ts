/**
 * US3 (005, FR-013 – FR-015, R11, SC-004): con una derivación activa el bot no responde; los
 * mensajes del cliente se agrupan y se reenvían al negocio en un único aviso por lote.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handoff, handoffNotice, message } from '../../../src/db/schema.js';
import type { BusinessNotice } from '../../../src/handoff/types.js';
import { createTestBot, type TestBot, type TestBotOptions } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { FakeAlertRoute, reply } from '../../helpers/fakes.js';
import { imageMessage } from '../../helpers/whatsapp.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const OTHER_CUSTOMER = '34600333444';

type Forward = Extract<BusinessNotice, { type: 'forward' }>;
const forwards = (route: FakeAlertRoute) =>
  route.received.filter((n): n is Forward => n.type === 'forward');

describe('US3: el bot calla y reenvía mientras el negocio atiende', () => {
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

  /** Bot con una derivación activa por WhatsApp (perfil "Cliente"). */
  async function derived(opts: TestBotOptions = {}): Promise<TestBot> {
    const b = (bot = await createTestBot(t, { handoffAlerts: ALERTS, ...opts }));
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();
    expect(await t.db.select().from(handoff)).toHaveLength(1);
    // Sin el agrupado de la 012 (lo prueba grouped-forward): el último aviso, hace tiempo.
    await t.db.update(handoff).set({ lastNoticeAt: new Date(0) });
    return b;
  }

  const statuses = async () =>
    (
      await t.db
        .select({ body: message.body, status: message.status })
        .from(message)
        .where(eq(message.direction, 'inbound'))
        .orderBy(message.receivedAt)
    ).map((m) => [m.body, m.status]);

  it('dos mensajes seguidos → ningún saliente y un único reenvío por vía con los dos (SC-004)', async () => {
    const b = await derived();
    const sentBefore = b.sender.sent.length;
    await b.send('Llegaré sobre las cinco');
    b.clock.advance(1000);
    await b.send('¿Os viene bien?');
    b.clock.advance(1000);
    await b.sendMessage(imageMessage());
    await b.settle();

    expect(b.sender.sent).toHaveLength(sentBefore);
    expect(b.model.calls).toHaveLength(1);
    for (const route of [b.alertRoutes.whatsapp, b.alertRoutes.email]) {
      const [fwd] = forwards(route);
      expect(forwards(route)).toHaveLength(1);
      expect(fwd?.items.map((i) => i.text ?? `[${i.otherType}]`)).toEqual([
        'Llegaré sobre las cinco',
        '¿Os viene bien?',
        '[image]',
      ]);
      expect(fwd?.handoff.token).toBe(route.received[0]?.handoff.token);
    }
    expect((await statuses()).slice(1)).toEqual([
      ['Llegaré sobre las cinco', 'forwarded'],
      ['¿Os viene bien?', 'forwarded'],
      [null, 'forwarded'],
    ]);
    const rows = await t.db.select().from(handoffNotice).where(eq(handoffNotice.type, 'forward'));
    expect(rows.map((r) => [r.route, r.status, r.messagesCovered]).sort()).toEqual([
      ['email', 'sent', 3],
      ['whatsapp', 'sent', 3],
    ]);
    expect(b.log.named('handoff_forwarded')).toEqual([
      expect.objectContaining({ messagesCovered: 3, routes: { whatsapp: 'sent', email: 'sent' } }),
    ]);
  });

  it('una nueva petición de persona se reenvía sin aviso nuevo (US3-4)', async () => {
    const b = await derived();
    await b.send('¿Hay alguien? Quiero hablar con una persona');
    await b.settle();

    expect(b.alertRoutes.whatsapp.received.map((n) => n.type)).toEqual(['alert', 'forward']);
    expect(await t.db.select().from(handoff)).toHaveLength(1);
    expect(b.model.calls).toHaveLength(1);
  });

  it('con las vías caídas los entrantes quedan reenviados y se registra el fallo, sin reintentos', async () => {
    const whatsapp = new FakeAlertRoute('whatsapp')
      .queue({ ok: true })
      .always({ fail: 'http_5xx' });
    const email = new FakeAlertRoute('email').queue({ ok: true }).always({ fail: 'network' });
    const b = await derived({ alertRoutes: { whatsapp, email } });
    await b.send('¿Me llamáis?');
    await b.settle();
    await b.settle();

    expect((await statuses()).at(-1)).toEqual(['¿Me llamáis?', 'forwarded']);
    expect(forwards(whatsapp)).toHaveLength(1);
    expect(b.log.named('handoff_forward_failed')).toEqual([
      expect.objectContaining({ messagesCovered: 1 }),
    ]);
    expect(
      await t.db
        .select()
        .from(handoffNotice)
        .where(and(eq(handoffNotice.type, 'forward'), eq(handoffNotice.status, 'failed'))),
    ).toHaveLength(2);
  });

  it('límite por cliente superado → un R-LIMIT con CONTACTO y los limitados no se reenvían', async () => {
    const b = await derived();
    // Con la petición ya son 30 en la ventana: el siguiente supera el límite.
    for (let i = 0; i < 29; i++) {
      await b.send(`mensaje ${i + 1}`);
      b.clock.advance(1000);
    }
    await b.settle();
    await b.send('mensaje limitado');
    await b.settle();

    const last = b.sender.sent.at(-1)?.body ?? '';
    expect(last).toContain('Has enviado muchos mensajes seguidos');
    expect(last).toContain('Para hablar con una persona de Peluquería Tijeras:');
    const forwarded = forwards(b.alertRoutes.whatsapp).flatMap((f) => f.items.map((i) => i.text));
    expect(forwarded).toHaveLength(29);
    expect(forwarded).not.toContain('mensaje limitado');
    expect((await statuses()).at(-1)).toEqual(['mensaje limitado', 'rate_limited']);
  });

  it('otro cliente se atiende con normalidad a la vez (FR-015)', async () => {
    const b = await derived();
    b.model.queue(reply('Abrimos de martes a sábado.'));
    await b.send('Sigo esperando');
    await b.send('¿Qué horario tenéis?', { from: OTHER_CUSTOMER });
    await b.settle();

    expect(b.sender.sent.at(-1)).toMatchObject({ to: `+${OTHER_CUSTOMER}` });
    expect(b.sender.sent.at(-1)?.body).toContain('Abrimos de martes a sábado.');
    expect(forwards(b.alertRoutes.whatsapp)[0]?.items.map((i) => i.text)).toEqual([
      'Sigo esperando',
    ]);
  });
});
