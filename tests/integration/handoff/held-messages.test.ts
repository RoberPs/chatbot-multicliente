/**
 * US2 (012, research R7.4; contracts/handoff-limits.md § Reenvío, punto 5): al terminar una
 * derivación por cualquier causa, los entrantes que esperaban su reenvío pasan a `held`: no se
 * reenvían, el bot no los contesta ni los pasa al modelo, y se ven como «retenido (no reenviado)»
 * en el panel y en «Probar el bot».
 */
import type { LightMyRequestResponse } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { conversation, handoff, message } from '../../../src/db/schema.js';
import type { BusinessNotice } from '../../../src/handoff/types.js';
import { cookieHeader, csrfFrom, get, login, postForm, type Session } from '../../helpers/app.js';
import { createTestBot, type TestBot } from '../../helpers/bot.js';
import { createTestDatabase, type TestDatabase } from '../../helpers/db.js';
import { reply } from '../../helpers/fakes.js';

const ALERTS = { whatsapp: '+34611000111', email: 'avisos@negocio.es' };
const HELD_LABEL = 'retenido (no reenviado)';
const DAY = 24 * 60 * 60 * 1000;

type Forward = Extract<BusinessNotice, { type: 'forward' }>;

describe('US2: mensajes retenidos al terminar la derivación', () => {
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

  /** Derivación activa por WhatsApp con dos mensajes esperando el intervalo de agrupado. */
  async function withWaiting(): Promise<{ b: TestBot; id: string; token: string }> {
    const b = (bot = await createTestBot(t, { handoffAlerts: ALERTS }));
    b.model.queue(reply('De acuerdo.', { handoffRequested: true }));
    await b.send('Quiero hablar con una persona');
    await b.settle();
    await b.send('Primer mensaje que espera');
    b.clock.advance(1000);
    await b.send('Segundo mensaje que espera');
    await b.settle();
    const [row] = await t.db.select().from(handoff);
    const token = b.alertRoutes.whatsapp.received[0]?.handoff.token;
    if (!row || !token) throw new Error('sin derivación');
    expect(await statuses()).toEqual(['answered', 'pending', 'pending']);
    return { b, id: row.id, token };
  }

  const statuses = async () =>
    (
      await t.db
        .select({ status: message.status })
        .from(message)
        .where(eq(message.direction, 'inbound'))
        .orderBy(asc(message.receivedAt))
    ).map((m) => m.status);

  const forwards = (b: TestBot) =>
    b.alertRoutes.whatsapp.received.filter((n): n is Forward => n.type === 'forward');

  /** Tras el fin, nada de lo retenido se reenvía ni se contesta, aunque pase el intervalo. */
  async function expectHeld(b: TestBot, cause: string): Promise<void> {
    expect(await statuses()).toEqual(['answered', 'held', 'held']);
    const [conv] = await t.db.select().from(conversation);
    expect(conv?.processAfter).toBeNull();
    expect(b.log.named('handoff_ended')).toEqual([
      expect.objectContaining({ cause, heldMessages: 2 }),
    ]);
    const sent = b.sender.sent.length;
    await b.settle(60 * 60 * 1000);
    expect(forwards(b)).toEqual([]);
    expect(b.sender.sent).toHaveLength(sent);
    expect(b.model.calls).toHaveLength(1);
  }

  it('fin por el negocio («Terminado»)', async () => {
    const { b, token } = await withWaiting();
    expect((await b.handoff.act(token, 'end', 'email')).result).toBe('done');
    await expectHeld(b, 'business');
  });

  it('fin desde el panel', async () => {
    const { b, id } = await withWaiting();
    expect((await b.handoff.endByOperator(id, 'operator')).result).toBe('done');
    await expectHeld(b, 'operator');
  });

  it('fin por inactividad', async () => {
    const { b } = await withWaiting();
    b.clock.advance(DAY + 1000);
    await b.handoff.sweep();
    expect(await statuses()).toEqual(['answered', 'held', 'held']);
    expect(b.log.named('handoff_ended')).toEqual([
      expect.objectContaining({ cause: 'inactivity', heldMessages: 2 }),
    ]);
    // El recordatorio de cierre sí sale (no es texto del cliente); el reenvío, no.
    await b.settle(60 * 60 * 1000);
    expect(forwards(b)).toEqual([]);
  });

  it('tras el fin, un mensaje nuevo lo contesta el bot sin pasar al modelo los retenidos', async () => {
    const { b, id } = await withWaiting();
    await b.handoff.endByOperator(id, 'operator');
    b.model.queue(reply('Abrimos de martes a sábado.'));
    await b.send('¿Qué horario tenéis?');
    await b.settle();

    expect(b.model.calls).toHaveLength(2);
    const call = JSON.stringify(b.model.calls[1]);
    expect(call).toContain('¿Qué horario tenéis?');
    expect(call).not.toContain('Primer mensaje que espera');
    expect(call).not.toContain('Segundo mensaje que espera');
    expect(await statuses()).toEqual(['answered', 'held', 'held', 'answered']);
  });

  it('el panel de derivaciones muestra los retenidos', async () => {
    const { b, id } = await withWaiting();
    await b.handoff.endByOperator(id, 'operator');
    const session = await login(b.app);
    const page = await get(b.app, session, '/admin/handoffs');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Mensajes retenidos');
    expect(page.body).toMatch(/data-held-conversation="[0-9a-f-]+"[\s\S]*?>2</);
    // Sin los textos del cliente (FR-016a).
    expect(page.body).not.toContain('Primer mensaje que espera');
  });

  it('«Probar el bot» muestra los retenidos como «retenido (no reenviado)»', async () => {
    const b = (bot = await createTestBot(t, { activate: false }));
    let session: Session = await login(b.app);
    const keep = (res: LightMyRequestResponse) => {
      const cookie = cookieHeader(res);
      if (cookie) session = { ...session, cookie };
      return res;
    };
    const page = keep(await get(b.app, session, '/admin/playground'));
    session = { ...session, csrf: csrfFrom(page.body) };
    const say = async (text: string) =>
      keep(await postForm(b.app, session, '/admin/playground/messages', { text }));

    b.model.queue(
      reply('De acuerdo.', { handoffRequested: true }),
      reply('Gracias.', { contactName: 'Operador', contactPhone: '+34 612 345 678' }),
    );
    await say('Quiero hablar con una persona');
    await b.settle();
    await say('Operador, +34 612 345 678');
    await b.settle();
    const [row] = await t.db.select().from(handoff);
    if (!row) throw new Error('sin derivación');

    // Termina antes de que el procesador lo reenvíe.
    await say('Esto ya no llega');
    await b.handoff.endByOperator(row.id, 'playground');
    await b.settle();

    const after = keep(await get(b.app, session, '/admin/playground'));
    expect(after.body).toContain('Esto ya no llega');
    expect(after.body).toContain(HELD_LABEL);
  });
});
