/**
 * US1 (005, FR-021): en "Probar el bot" la derivación es simulada: la única vía es la simulada,
 * ninguna vía real recibe nada y el texto del aviso queda para el operador.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handoff, handoffNotice, message } from '../../../src/db/schema.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';

describe('US1: derivación simulada en el playground', () => {
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

  it('pide los datos, deriva por la vía simulada y guarda el texto del aviso', async () => {
    // Con destinos reales configurados: aun así, el playground no los usa.
    const b = (bot = await createTestBot(t, {
      activate: false,
      handoffAlerts: { whatsapp: '+34611000111', email: 'avisos@negocio.es' },
    }));
    b.model.queue(
      reply('De acuerdo.', { handoffRequested: true }),
      reply('Gracias.', { contactName: 'Operador', contactPhone: '+34 612 345 678' }),
    );
    b.summarizer.queue({ summary: 'Quiere hablar con una persona para una prueba.' });
    await b.sendVia('playground', 'Quiero hablar con una persona');
    await b.settle();
    await b.sendVia('playground', 'Operador, +34 612 345 678');
    await b.settle();

    expect(b.alertRoutes.whatsapp.received).toEqual([]);
    expect(b.alertRoutes.email.received).toEqual([]);
    expect(b.sender.sent).toEqual([]);

    const [row] = await t.db.select().from(handoff);
    expect(row?.status).toBe('active');
    const notices = await t.db.select().from(handoffNotice);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ route: 'simulated', type: 'alert', status: 'sent' });
    expect(notices[0]?.body).toContain('Derivación: Operador (quiere hablar con una persona)');
    expect(notices[0]?.body).toContain('Canal: prueba del panel');
    expect(notices[0]?.body).toContain('Motivo: Quiere hablar con una persona para una prueba.');

    const [, last] = await t.db
      .select({ replyTrace: message.replyTrace })
      .from(message)
      .where(eq(message.direction, 'outbound'))
      .orderBy(message.sentAt);
    expect(last?.replyTrace).toMatchObject({
      template: 'R-HANDOFF-OK',
      handoff: { action: 'started', kind: 'person', routes: { simulated: 'sent' } },
    });
  });
});
