/**
 * FR-022 (005, contracts/activity-log.md): un flujo completo de derivación (petición, datos,
 * aviso, reenvío, recordatorio, botón, texto del negocio y fin) no deja en los registros el
 * nombre ni el teléfono del cliente, el WhatsApp ni el email de avisos, el motivo, el token ni
 * los textos; y los eventos que provoca el negocio no llevan seudónimo.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LoggerLike } from '../../../src/conversation/activity-log.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';
import { buttonMessage, postWebhook, textMessage, webhookPayload } from '../../helpers/whatsapp.js';

const NAME = 'Zoraida';
const WORD = 'Xilofonista';
const MARK = 'MARCA-9c1e';
const ALERTS = { whatsapp: '+34611000111', email: 'avisos-secretos@negocio.es' };
const WEB_ON = { enabled: true, allowedOrigins: ['https://negocio.example'] };
const BUSINESS_EVENTS = new Set([
  'handoff_confirmed',
  'handoff_action_ignored',
  'handoff_business_message',
]);

function capturingLogger(lines: string[]): LoggerLike {
  const write = (level: string) => (obj: object, msg?: string) => {
    lines.push(JSON.stringify({ level, ...obj, msg }));
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

describe('registros de la derivación sin datos personales (FR-022)', () => {
  let t: TestDatabase;
  let bot: TestBot | null = null;
  const lines: string[] = [];

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

  it('flujo completo: ninguna línea lleva datos marcados; el negocio sin seudónimo', async () => {
    const b = (bot = await createTestBot(t, {
      logger: capturingLogger(lines),
      handoffAlerts: ALERTS,
      webChat: WEB_ON,
    }));
    const businessFrom = ALERTS.whatsapp.slice(1);

    // Petición y datos por la web.
    b.model.queue(
      reply('De acuerdo.', { handoffRequested: true }),
      reply('Gracias.', { contactName: NAME, contactPhone: '612 345 678' }),
    );
    b.summarizer.queue({ summary: `Pregunta por el ${WORD} y quiere hablar con alguien.` });
    await b.sendVia('web', `Quiero hablar con una persona ${MARK}`);
    await b.settle();
    await b.sendVia('web', `${NAME}, 612 345 678`);
    await b.settle();
    const token = b.alertRoutes.email.received[0]?.handoff.token;
    if (!token) throw new Error('Sin derivación');

    // Reenvío durante la derivación (agrupado: sale al cumplirse el intervalo, 012).
    await b.sendVia('web', `Otra cosa ${MARK}`);
    await b.settle(15 * 60 * 1000);

    // Recordatorio a las 2 h de horario, con R-HANDOFF-LATE al cliente.
    b.clock.advance(3 * 60 * 60 * 1000);
    await b.handoff.sweep();

    // El negocio: texto libre desde el WhatsApp de avisos y botón «Le atiendo».
    await postWebhook(
      b.app,
      webhookPayload({
        messages: [
          textMessage(`Ya le llamo ${MARK}`, { from: businessFrom, timestamp: b.clock.now() }),
        ],
      }),
    );
    await postWebhook(
      b.app,
      webhookPayload({
        messages: [
          buttonMessage(`h1:attend:${token}`, { from: businessFrom, timestamp: b.clock.now() }),
        ],
      }),
    );
    // Fin por el enlace del email y un segundo clic sin efecto.
    await b.app.inject({ method: 'POST', url: `/handoff/${token}/end` });
    await b.app.inject({ method: 'POST', url: `/handoff/${token}/end` });

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const events = new Set(parsed.map((e) => e.event));
    for (const event of [
      'handoff_contact_requested',
      'handoff_started',
      'handoff_forwarded',
      'handoff_reminder_sent',
      'handoff_business_message',
      'handoff_confirmed',
      'handoff_ended',
      'handoff_action_ignored',
    ]) {
      expect(events).toContain(event);
    }

    const forbidden = [
      NAME,
      WORD,
      MARK,
      token,
      '612 345 678',
      '612345678',
      ALERTS.email,
      '611000111',
      '611 00 01 11',
    ];
    for (const line of lines) {
      for (const value of forbidden) expect(line).not.toContain(value);
    }

    // Eventos del negocio (y el fin que provoca): sin seudónimo ni conversación. Su `via` es la
    // del botón o el enlace (whatsapp/email), no el canal de un cliente.
    const business = parsed.filter(
      (e) =>
        BUSINESS_EVENTS.has(String(e.event)) ||
        (e.event === 'handoff_ended' && e.cause === 'business'),
    );
    expect(business.length).toBeGreaterThanOrEqual(4);
    for (const e of business) {
      expect(e).not.toHaveProperty('customer');
      expect(e).not.toHaveProperty('conversationId');
    }
  });
});
