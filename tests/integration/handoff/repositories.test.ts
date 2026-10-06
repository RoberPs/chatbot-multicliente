/** Repositorios de la derivación (005, data-model.md): transiciones, barrido e historial. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as conversations from '../../../src/conversation/repositories/conversation.js';
import * as messages from '../../../src/conversation/repositories/message.js';
import { conversation, customer, handoff, message } from '../../../src/db/schema.js';
import * as handoffs from '../../../src/handoff/repositories/handoff.js';
import * as notices from '../../../src/handoff/repositories/handoff-notice.js';
import { createTestDatabase, resetDb, type TestDatabase } from '../../helpers/db.js';

const HOUR = 60 * 60 * 1000;

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('Falta un valor en el test');
  return value;
}
const T0 = new Date('2026-10-01T08:00:00Z');

describe('repositorios de la derivación', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDb(t.db);
  });

  async function newConversation(
    channel: 'whatsapp' | 'web' | 'playground' = 'web',
    lastInboundAt = T0,
  ): Promise<string> {
    const userId =
      channel === 'whatsapp'
        ? `+3461100${Math.floor(1000 + Math.random() * 8999)}`
        : channel === 'web'
          ? randomUUID().replaceAll('-', '').repeat(2)
          : randomUUID();
    const [c] = await t.db
      .insert(customer)
      .values({ channel, channelUserId: userId })
      .returning({ id: customer.id });
    const [conv] = await t.db
      .insert(conversation)
      .values({
        customerId: must(c).id,
        startedAt: lastInboundAt,
        lastInboundAt,
        lastMessageAt: lastInboundAt,
        contactName: 'Lucía',
        contactPhone: '+34611222333',
      })
      .returning({ id: conversation.id });
    return must(conv).id;
  }

  async function newHandoff(
    conversationId: string,
    extra: Partial<handoffs.NewHandoff> = {},
  ): Promise<string> {
    const id = randomUUID();
    await handoffs.insertActive(t.db, {
      id,
      conversationId,
      kind: 'person',
      summary: 'Pregunta por el precio',
      summarySource: 'model',
      tokenHash: Buffer.from(randomUUID()),
      tokenEnc: Buffer.from('cifrado'),
      startedAt: T0,
      reminderDueAt: new Date(T0.getTime() + 2 * HOUR),
      ...extra,
    });
    return id;
  }

  it('una sola derivación activa por conversación', async () => {
    const c = await newConversation();
    const id = await newHandoff(c);
    await expect(newHandoff(c)).rejects.toThrow();
    const active = await handoffs.findActiveByConversation(t.db, c);
    expect(active).toMatchObject({
      id,
      status: 'active',
      customerName: 'Lucía',
      customerPhone: '+34611222333',
      channel: 'web',
    });
    expect(await handoffs.hasEnded(t.db, c)).toBe(false);
  });

  it('confirm solo actúa sobre activas sin confirmar y dice si cambió', async () => {
    const c = await newConversation();
    const id = await newHandoff(c);
    const at = new Date(T0.getTime() + HOUR);
    expect(await handoffs.confirm(t.db, id, 'email', at)).toBe(true);
    expect(await handoffs.confirm(t.db, id, 'whatsapp', new Date(at.getTime() + HOUR))).toBe(false);
    const row = await handoffs.findById(t.db, id);
    expect(row).toMatchObject({ confirmedAt: at, confirmedVia: 'email' });
  });

  it('end termina una sola vez; con confirmVia confirma a la vez', async () => {
    const c = await newConversation();
    const id = await newHandoff(c);
    const at = new Date(T0.getTime() + HOUR);
    expect(await handoffs.end(t.db, id, 'business', at, 'whatsapp')).toBe(true);
    expect(await handoffs.end(t.db, id, 'operator', at)).toBe(false);
    expect(await handoffs.confirm(t.db, id, 'email', at)).toBe(false);
    expect(await handoffs.findById(t.db, id)).toMatchObject({
      status: 'ended',
      endCause: 'business',
      endedAt: at,
      confirmedAt: at,
      confirmedVia: 'whatsapp',
    });
    expect(await handoffs.hasEnded(t.db, c)).toBe(true);
    expect(await handoffs.findActiveByConversation(t.db, c)).toBeNull();
    // Terminada, se puede crear otra en la misma conversación.
    await newHandoff(c);
  });

  it('end con confirmVia no pisa una confirmación anterior', async () => {
    const c = await newConversation();
    const id = await newHandoff(c);
    const confirmedAt = new Date(T0.getTime() + HOUR);
    await handoffs.confirm(t.db, id, 'email', confirmedAt);
    await handoffs.end(t.db, id, 'business', new Date(T0.getTime() + 2 * HOUR), 'whatsapp');
    expect(await handoffs.findById(t.db, id)).toMatchObject({
      confirmedAt,
      confirmedVia: 'email',
    });
  });

  it('endInactive respeta el límite de 24 h y marca el recordatorio si no estaba confirmada', async () => {
    const quiet = await newConversation('web', T0);
    const recent = await newConversation('web', new Date(T0.getTime() + 2 * HOUR));
    const confirmed = await newConversation('web', T0);
    const a = await newHandoff(quiet);
    await newHandoff(recent);
    const b = await newHandoff(confirmed);
    await handoffs.confirm(t.db, b, 'email', T0);

    const now = new Date(T0.getTime() + 24 * HOUR + 60_000);
    const ended = await handoffs.endInactive(t.db, new Date(now.getTime() - 24 * HOUR), now);
    expect(ended.map((e) => e.id).sort()).toEqual([a, b].sort());
    expect(ended.find((e) => e.id === a)).toMatchObject({ confirmed: false, reminderDue: true });
    expect(ended.find((e) => e.id === b)).toMatchObject({ confirmed: true, reminderDue: false });
    expect(await handoffs.findById(t.db, a)).toMatchObject({
      status: 'ended',
      endCause: 'inactivity',
      reminderSentAt: now,
    });
    expect((await handoffs.findById(t.db, b))?.reminderSentAt).toBeNull();
    expect(await handoffs.findActiveByConversation(t.db, recent)).not.toBeNull();
  });

  it('endInactive no repite el recordatorio si ya se había enviado', async () => {
    const c = await newConversation('web', T0);
    const id = await newHandoff(c);
    await t.db
      .update(handoff)
      .set({ reminderSentAt: new Date(T0.getTime() + 2 * HOUR) })
      .where(eq(handoff.id, id));
    const now = new Date(T0.getTime() + 25 * HOUR);
    const [ended] = await handoffs.endInactive(t.db, new Date(now.getTime() - 24 * HOUR), now);
    expect(ended).toMatchObject({ id, reminderDue: false });
  });

  it('claimDueReminders no devuelve la misma fila en dos transacciones concurrentes', async () => {
    const c1 = await newConversation();
    const c2 = await newConversation();
    const c3 = await newConversation();
    const due1 = await newHandoff(c1);
    const due2 = await newHandoff(c2);
    const later = await newHandoff(c3, { reminderDueAt: new Date(T0.getTime() + 5 * HOUR) });
    const now = new Date(T0.getTime() + 3 * HOUR);

    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let first: string[] = [];
    const tx1 = t.db.transaction(async (tx) => {
      first = await handoffs.claimDueReminders(tx, now);
      await hold;
    });
    // Espera a que la primera transacción haya reclamado sus filas.
    while (first.length === 0) await new Promise((r) => setTimeout(r, 10));
    const second = await t.db.transaction((tx) => handoffs.claimDueReminders(tx, now));
    release();
    await tx1;

    expect(first.sort()).toEqual([due1, due2].sort());
    expect(second).toEqual([]);
    expect(await t.db.transaction((tx) => handoffs.claimDueReminders(tx, now))).toEqual([]);
    expect((await handoffs.findById(t.db, later))?.reminderSentAt).toBeNull();
  });

  it('listActive excluye el playground y no trae el motivo', async () => {
    const web = await newConversation('web');
    const play = await newConversation('playground');
    const id = await newHandoff(web);
    await newHandoff(play);
    const list = await handoffs.listActive(t.db);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, channel: 'web', customerName: 'Lucía' });
    expect(list[0]).not.toHaveProperty('summary');
    expect(await handoffs.countActive(t.db)).toBe(1);
  });

  it('avisos: hilo del email y lista en orden', async () => {
    const c = await newConversation();
    const id = await newHandoff(c);
    await notices.insertMany(t.db, [
      {
        handoffId: id,
        type: 'alert',
        route: 'whatsapp',
        status: 'sent',
        providerRef: 'wamid.1',
        createdAt: T0,
      },
      {
        handoffId: id,
        type: 'alert',
        route: 'email',
        status: 'sent',
        providerRef: '<m1@x>',
        body: 'no se guarda',
        createdAt: new Date(T0.getTime() + 1),
      },
      {
        handoffId: id,
        type: 'forward',
        route: 'simulated',
        status: 'sent',
        body: 'texto',
        messagesCovered: 2,
        createdAt: new Date(T0.getTime() + 2),
      },
    ]);
    expect(await notices.emailThreadRef(t.db, id)).toBe('<m1@x>');
    const list = await notices.listForHandoff(t.db, id);
    expect(list.map((n) => [n.route, n.body])).toEqual([
      ['whatsapp', null],
      ['email', null],
      ['simulated', 'texto'],
    ]);
  });

  it('history() y listForConversation() incluyen los entrantes forwarded', async () => {
    const c = await newConversation();
    const ids: string[] = [];
    for (const [i, status] of (['answered', 'pending'] as const).entries()) {
      const { id } = await messages.insertInbound(t.db, {
        conversationId: c,
        channelMessageId: `in-${i}`,
        kind: 'text',
        body: `mensaje ${i}`,
        otherType: null,
        sentAt: new Date(T0.getTime() + i * 1000),
        receivedAt: new Date(T0.getTime() + i * 1000),
        status: status === 'answered' ? 'pending' : status,
      });
      ids.push(must(id));
    }
    await t.db
      .update(message)
      .set({ status: 'answered' })
      .where(eq(message.id, must(ids[0])));
    await messages.markForwarded(t.db, [must(ids[1])]);

    const hist = await messages.history(t.db, c, 10);
    expect(hist.map((h) => h.body)).toEqual(['mensaje 0', 'mensaje 1']);
    const listed = await messages.listForConversation(t.db, c);
    expect(listed.map((m) => [m.direction, m.body])).toEqual([
      ['inbound', 'mensaje 0'],
      ['inbound', 'mensaje 1'],
    ]);
    expect(await messages.customerTexts(t.db, c, 30)).toEqual(['mensaje 0', 'mensaje 1']);
    expect(await messages.hasPending(t.db, c)).toBe(false);
  });

  it('conversación: contacto, paso previo y nombre de perfil', async () => {
    const c = await newConversation();
    await conversations.setContact(t.db, c, { name: '  Ana\nMaría  ', phone: '+34699000111' });
    await conversations.setHandoffStep(t.db, c, {
      step: 'collecting',
      kind: 'person',
      missing: ['phone'],
      phoneRetried: false,
      at: T0.toISOString(),
    });
    let row = await conversations.findWithCustomer(t.db, c);
    expect(row).toMatchObject({
      contactName: 'Ana María',
      contactPhone: '+34699000111',
      handoffStep: { step: 'collecting', missing: ['phone'] },
    });

    await conversations.setProfileName(t.db, c, 'x'.repeat(100));
    row = await conversations.findWithCustomer(t.db, c);
    expect(row?.contactName).toBe('x'.repeat(80));
    await conversations.setProfileName(t.db, c, '   ');
    expect((await conversations.findWithCustomer(t.db, c))?.contactName).toBe('x'.repeat(80));

    // Un valor guardado que no valida se lee como null.
    await t.db
      .update(conversation)
      .set({ handoffStep: { step: 'raro' } })
      .where(eq(conversation.id, c));
    expect((await conversations.findWithCustomer(t.db, c))?.handoffStep).toBeNull();
    await conversations.setHandoffStep(t.db, c, null);
    expect((await conversations.findWithCustomer(t.db, c))?.handoffStep).toBeNull();
  });
});
