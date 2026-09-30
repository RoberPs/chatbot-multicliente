/**
 * US1 (005, FR-008, FR-012, R5, R12): una vía que falla, las dos caídas, ninguna configurada, una
 * vía colgada y el resumen caído. "Te contactarán" solo con al menos un aviso entregado.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handoff, handoffNotice, message } from '../../../src/db/schema.js';
import { createTestBot, type TestBot, type TestBotOptions } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { FakeAlertRoute, FakeSummarizer, reply } from '../../helpers/fakes.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const OK = 'He avisado a Peluquería Tijeras.';
const CONTACT = 'Para hablar con una persona de Peluquería Tijeras:';
const FAIL = 'No he podido avisar a Peluquería Tijeras ahora mismo.';

describe('US1: fallos de las vías de aviso', () => {
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

  async function request(opts: TestBotOptions, modelBody = 'De acuerdo.') {
    const b = (bot = await createTestBot(t, opts));
    b.model.queue(reply(modelBody, { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();
    const [outbound] = await t.db
      .select({ body: message.body, replyTrace: message.replyTrace })
      .from(message)
      .where(eq(message.direction, 'outbound'));
    return { b, outbound };
  }

  it('una vía falla y la otra no → deriva y registra handoff_alert_failed', async () => {
    const { b, outbound } = await request({
      handoffAlerts: ALERTS,
      alertRoutes: { email: new FakeAlertRoute('email', { fail: 'smtp_5xx' }) },
    });
    expect(outbound?.body).toContain(OK);
    expect(await t.db.select().from(handoff)).toHaveLength(1);
    const notices = await t.db.select().from(handoffNotice);
    expect(notices.map((n) => [n.route, n.status, n.failure]).sort()).toEqual([
      ['email', 'failed', 'smtp_5xx'],
      ['whatsapp', 'sent', null],
    ]);
    expect(b.log.named('handoff_alert_failed')).toEqual([
      expect.objectContaining({ route: 'email', noticeType: 'alert', failure: 'smtp_5xx' }),
    ]);
    expect(outbound?.replyTrace).toMatchObject({
      handoff: { action: 'started', routes: { whatsapp: 'sent', email: 'failed' } },
    });
  });

  it('las dos fallan → sin derivación, CONTACTO (handoff_unavailable) y delivery_failed', async () => {
    const { b, outbound } = await request({
      handoffAlerts: ALERTS,
      alertRoutes: {
        whatsapp: new FakeAlertRoute('whatsapp', { fail: 'template_rejected' }),
        email: new FakeAlertRoute('email', { fail: 'network' }),
      },
    });
    expect(outbound?.body).not.toContain(OK);
    expect(outbound?.body).toContain(FAIL);
    expect(outbound?.body).toContain(CONTACT);
    expect(outbound?.replyTrace).toMatchObject({
      template: 'R-HANDOFF-FAIL',
      contact: { added: true, reason: 'handoff_unavailable' },
      handoff: { action: 'not_started', routes: { whatsapp: 'failed', email: 'failed' } },
    });
    expect(await t.db.select().from(handoff)).toEqual([]);
    expect(await t.db.select().from(handoffNotice)).toEqual([]);
    expect(b.log.named('handoff_not_started')).toEqual([
      expect.objectContaining({ reason: 'delivery_failed' }),
    ]);
  });

  it('sin entrega, el cuerpo del modelo no llega al cliente aunque prometa el contacto', async () => {
    const { outbound } = await request(
      {
        handoffAlerts: ALERTS,
        alertRoutes: {
          whatsapp: new FakeAlertRoute('whatsapp', { fail: 'network' }),
          email: new FakeAlertRoute('email', { fail: 'network' }),
        },
      },
      'Gracias. Hemos anotado sus datos, en breve le contactarán.',
    );
    expect(outbound?.body).not.toContain('anotado');
    expect(outbound?.body).not.toContain('contactarán');
    expect(outbound?.body).toContain(FAIL);
  });

  it('ninguna vía configurada → el contacto de la 002 y no_routes', async () => {
    const { b, outbound } = await request({});
    expect(outbound?.body).toContain(CONTACT);
    expect(outbound?.replyTrace).toMatchObject({
      contact: { added: true, reason: 'handoff_requested' },
      handoff: { action: 'not_started', kind: 'person' },
    });
    expect(await t.db.select().from(handoff)).toEqual([]);
    expect(b.alertRoutes.whatsapp.received).toEqual([]);
    expect(b.log.named('handoff_not_started')).toEqual([
      expect.objectContaining({ reason: 'no_routes' }),
    ]);
  });

  it('una vía colgada se corta con su plazo y cuenta como fallo', async () => {
    const { b, outbound } = await request({
      handoffAlerts: ALERTS,
      handoffTimeouts: { routeMs: 50 },
      alertRoutes: { whatsapp: new FakeAlertRoute('whatsapp', { hang: true }) },
    });
    expect(outbound?.body).toContain(OK);
    expect(b.log.named('handoff_alert_failed')).toEqual([
      expect.objectContaining({ route: 'whatsapp', failure: 'timeout' }),
    ]);
  });

  it('resumen caído → deriva con el respaldo y handoff_summary_fallback', async () => {
    const { b, outbound } = await request({
      handoffAlerts: ALERTS,
      summarizer: new FakeSummarizer({ fail: true }),
    });
    expect(outbound?.body).toContain(OK);
    const [row] = await t.db.select().from(handoff);
    expect(row).toMatchObject({
      summarySource: 'fallback',
      summary: 'El cliente pidió hablar con una persona sin dar el motivo.',
    });
    expect(b.log.named('handoff_summary_fallback')).toEqual([
      expect.objectContaining({ reason: 'model_error' }),
    ]);
  });
});
