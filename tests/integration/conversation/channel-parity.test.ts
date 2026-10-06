/**
 * Paridad entre canales (004, contracts/conversation-channels.md garantías 1, 4 y 5; SC-002 en
 * CI): la misma conversación con el modelo falso da por whatsapp, web y playground los mismos
 * textos, plantillas, saludo, contacto y reply_trace (salvo latencias) y los mismos eventos
 * (salvo `via`). Lo único que cambia es lo que dice la tabla de políticas.
 */
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Channel } from '../../../src/conversation/channels.js';
import { message } from '../../../src/db/schema.js';
import { createTestBot, type TestBot, type TestBotOptions } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';

const HOUR = 60 * 60 * 1000;
const WEB_ON = {
  enabled: true,
  allowedOrigins: ['https://negocio.example'],
  privacyUrl: 'https://negocio.example/privacidad',
};
const CHANNELS: Channel[] = ['whatsapp', 'web', 'playground'];

describe('paridad entre canales', () => {
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
    (bot = await createTestBot(t, { webChat: WEB_ON, ...opts }));

  const outbound = () =>
    t.db
      .select({ body: message.body, replyTrace: message.replyTrace })
      .from(message)
      .where(eq(message.direction, 'outbound'))
      .orderBy(asc(message.sentAt));

  /** Conversación de referencia; devuelve salientes y eventos comparables. */
  async function converse(channel: Channel) {
    const b = await start();
    b.model.queue(
      reply('Te cuento el horario cuando quieras.'),
      reply('No dispongo de ese dato.', { offerContact: true }),
      reply('De acuerdo.'),
      // El verificador rechaza el primer borrador (hora sin registrar).
      reply('Abrimos a las 7:45.'),
      reply('Te lo confirma el equipo.'),
    );
    for (const text of [
      'Hola, ¿a qué hora abrís?',
      '¿Tenéis aparcamiento para bicis?',
      'Quiero hablar con una persona',
      '¿Y mañana a qué hora?',
    ]) {
      expect((await b.sendVia(channel, text)).status).toBe('stored');
      await b.settle();
    }
    const rows = (await outbound()).map((r) => {
      const { latencyMs: _l, modelMs: _m, ...trace } = r.replyTrace as Record<string, unknown>;
      return { body: r.body, trace };
    });
    const events = b.log.events.map((e) => {
      const {
        via,
        customer: _c,
        conversationId: _id,
        latencyMs: _l,
        waitMs: _w,
        modelMs: _m,
        ...rest
      } = e as Record<string, unknown>;
      expect(via).toBe(channel);
      return rest;
    });
    return { rows, events, sent: b.sender.sent.length };
  }

  it('mismas respuestas, reply_trace y eventos por los tres canales (garantía 1)', async () => {
    const results = [];
    for (const channel of CHANNELS) {
      results.push(await converse(channel));
      await bot?.close();
      bot = null;
    }
    const [whatsapp, web, playground] = results;
    expect(whatsapp?.rows).toHaveLength(4);
    expect(whatsapp?.rows.map((r) => r.trace)).toEqual([
      expect.objectContaining({
        greeting: true,
        template: null,
        contact: { added: false, reason: null },
      }),
      expect.objectContaining({
        greeting: false,
        contact: { added: true, reason: 'offer_contact' },
      }),
      expect.objectContaining({ contact: { added: true, reason: 'handoff_requested' } }),
      expect.objectContaining({ groundingRejections: 1, contact: { added: false, reason: null } }),
    ]);
    expect(web).toEqual({ ...whatsapp, sent: 0 });
    // 005: el playground siempre tiene la vía simulada (`simulateAlerts`, FR-021), así que ante
    // un dato sin registrar ofrece la derivación (US2) y ante la petición de persona pide los
    // datos, en vez de dar el contacto. Hasta ahí, idéntico.
    const untilOffer = (events: Array<Record<string, unknown>> = []) => {
      const received = events
        .map((e, i) => (e.event === 'message_received' ? i : -1))
        .filter((i) => i >= 0);
      return events.slice(0, (received[1] ?? events.length) + 1);
    };
    expect(playground?.rows.slice(0, 1)).toEqual(whatsapp?.rows.slice(0, 1));
    expect(untilOffer(playground?.events)).toEqual(untilOffer(whatsapp?.events));
    expect(playground?.rows[1]?.trace).toMatchObject({
      contact: { added: false, reason: null },
      handoff: { action: 'offered', kind: 'unresolved' },
    });
    expect(playground?.rows[2]?.trace).toMatchObject({
      template: 'R-HANDOFF-ASK',
      handoff: { action: 'asked', kind: 'person' },
    });
    expect(playground?.sent).toBe(0);
    // Solo WhatsApp llama a su sender; web y playground guardan la respuesta.
    expect(whatsapp?.sent).toBe(4);
  });

  it('la ventana de 24 h descarta solo en WhatsApp (garantía 4)', async () => {
    for (const channel of CHANNELS) {
      const b = await start();
      await b.sendVia(channel, '¿Abrís el sábado?');
      await b.settle(25 * HOUR);
      const answered = (await outbound()).length;
      expect([channel, answered]).toEqual([channel, channel === 'whatsapp' ? 0 : 1]);
      const discarded = b.log.named('message_discarded').map((e) => e.reason);
      expect(discarded).toEqual(channel === 'whatsapp' ? ['outside_window'] : []);
      await b.close();
      bot = null;
    }
  });

  it('negocio en preparación: responde el playground y no web ni WhatsApp (garantía 5)', async () => {
    for (const channel of CHANNELS) {
      const b = await start({ activate: false });
      const outcome = await b.sendVia(channel, 'Hola');
      await b.settle();
      if (channel === 'playground') {
        expect(outcome.status).toBe('stored');
        expect(await outbound()).toHaveLength(1);
      } else {
        expect(outcome).toEqual({ status: 'discarded', reason: 'not_active' });
        expect(await b.messages()).toHaveLength(0);
      }
      await b.close();
      bot = null;
    }
  });

  it('chat web desactivado: la web descarta y los demás canales no', async () => {
    for (const channel of CHANNELS) {
      const b = await start({ webChat: { enabled: false } });
      const outcome = await b.sendVia(channel, 'Hola');
      await b.settle();
      if (channel === 'web') {
        expect(outcome).toEqual({ status: 'discarded', reason: 'disabled' });
        expect(await b.messages()).toHaveLength(0);
        expect(b.log.named('message_discarded')).toEqual([
          expect.objectContaining({ reason: 'disabled', via: 'web' }),
        ]);
      } else {
        expect(await outbound()).toHaveLength(1);
      }
      await b.close();
      bot = null;
    }
  });

  it('petición de persona: misma decisión y plantillas; solo cambian los datos del canal y la vía simulada (005)', async () => {
    const results: Record<string, unknown> = {};
    for (const channel of CHANNELS) {
      const b = await start({
        handoffAlerts: { whatsapp: '+34611000111', email: 'avisos@negocio.es' },
      });
      b.model.queue(
        reply('De acuerdo.', { handoffRequested: true }),
        reply('Gracias.', { contactName: 'Lucía', contactPhone: '612 345 678' }),
      );
      await b.sendVia(channel, 'Quiero hablar con una persona');
      await b.settle();
      await b.sendVia(channel, 'Lucía, 612 345 678');
      await b.settle();
      const traces = (await outbound()).map(
        (r) =>
          r.replyTrace as {
            template: string | null;
            handoff?: { action: string; kind: string; routes: Record<string, string> };
          },
      );
      results[channel] = {
        templates: traces.map((tr) => tr.template),
        actions: traces.map((tr) => tr.handoff?.action),
        kinds: traces.map((tr) => tr.handoff?.kind),
        routes: Object.keys(traces.at(-1)?.handoff?.routes ?? {}).sort(),
        asked: b.log.named('handoff_contact_requested').map((e) => e.missing),
      };
      await b.close();
      bot = null;
    }
    const same = {
      templates: ['R-HANDOFF-ASK', 'R-HANDOFF-OK'],
      actions: ['asked', 'started'],
      kinds: ['person', 'person'],
    };
    // WhatsApp da el teléfono (R15): solo pide el nombre (sin perfil en este evento).
    expect(results.whatsapp).toEqual({
      ...same,
      routes: ['email', 'whatsapp'],
      asked: [['name']],
    });
    expect(results.web).toEqual({
      ...same,
      routes: ['email', 'whatsapp'],
      asked: [['name', 'phone']],
    });
    // El playground solo usa la vía simulada (FR-021).
    expect(results.playground).toEqual({
      ...same,
      routes: ['simulated'],
      asked: [['name', 'phone']],
    });
  });

  it('desactivado entre la recepción y la respuesta: la web no contesta (US2-5)', async () => {
    const b = await start();
    expect((await b.sendVia('web', 'Hola')).status).toBe('stored');
    await b.setWebChat({ enabled: false });
    await b.settle();
    expect(await outbound()).toHaveLength(0);
    expect(b.model.calls).toHaveLength(0);
    const [row] = await b.messages();
    expect(row?.status).toBe('discarded');
  });
});
