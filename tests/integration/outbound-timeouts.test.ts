/**
 * Servicios externos que no responden (012, US5, SC-006; contracts/outbound-and-retries.md §
 * Plazos). Con plazos acortados: la Graph API colgada no deja ninguna petición abierta más que su
 * plazo, una vía de aviso colgada falla con `timeout` y, mientras tanto, el procesador sigue
 * atendiendo el chat web. (El SMTP colgado lo cubre `tests/unit/mail/smtp-mailer.test.ts` con un
 * servidor real.)
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createGraphClient } from '../../src/channels/whatsapp/graph-client.js';
import { ChannelSendError } from '../../src/conversation/ports.js';
import { createTestBot, type TestBot } from '../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../helpers/db.js';
import { FakeAlertRoute, reply } from '../helpers/fakes.js';

const WEB_ON = { enabled: true, allowedOrigins: ['https://negocio.example'] };

describe('servicios externos sin respuesta (SC-006)', () => {
  let t: TestDatabase;
  let bot: TestBot | null = null;
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    t = await createTestDatabase();
    // Acepta y no contesta nunca.
    server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await t.close();
  });
  afterEach(async () => {
    await bot?.close();
    bot = null;
  });

  it('Graph API colgada: el envío y los metadatos terminan en su plazo', async () => {
    const graph = createGraphClient({
      phoneNumberId: '1098',
      accessToken: 'tok',
      graphVersion: 'v23.0',
      baseUrl: `http://127.0.0.1:${String(port)}`,
      retryDelaysMs: [20, 20, 20],
      timeouts: { requestMs: 100, totalSendMs: 400, mediaMetaMs: 100 },
    });
    const started = Date.now();
    const error = await graph.sendText('+34600111222', 'Hola').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelSendError);
    expect(Date.now() - started).toBeLessThan(600);
    const meta = Date.now();
    await expect(graph.fetchAudio('media-1', 1000)).rejects.toThrow();
    expect(Date.now() - meta).toBeLessThan(300);
  });

  it('una vía de aviso colgada falla con timeout y el chat web se atiende mientras tanto', async () => {
    const b = (bot = await createTestBot(t, {
      handoffAlerts: { whatsapp: '+34611000111', email: 'avisos@negocio.es' },
      alertRoutes: { email: new FakeAlertRoute('email', { hang: true }) },
      handoffTimeouts: { routeMs: 300 },
      webChat: WEB_ON,
    }));
    b.model.queue(
      reply('De acuerdo.', { handoffRequested: true }),
      reply('Abrimos de martes a sábado.'),
    );
    await b.send('Quiero hablar con una persona');
    b.clock.advance(3000);
    // La derivación se queda esperando a la vía email colgada…
    const handoff = b.processor.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // …y mientras tanto el chat web se atiende.
    await b.sendVia('web', '¿Qué horario tenéis?');
    await b.settle();
    const web = (await b.messages()).find(
      (m) => m.direction === 'outbound' && m.body?.includes('Abrimos de martes a sábado.'),
    );
    expect(web).toBeDefined();
    expect(b.log.named('handoff_alert_failed')).toEqual([]);

    const started = Date.now();
    await handoff;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(b.log.named('handoff_alert_failed')).toEqual([
      expect.objectContaining({ route: 'email', failure: 'timeout' }),
    ]);
    // La otra vía entregó: la derivación sigue adelante.
    expect(b.log.named('handoff_started')).toHaveLength(1);
  });
});
