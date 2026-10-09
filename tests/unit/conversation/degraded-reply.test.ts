/**
 * Respuesta degradada (016, T015; FR-002, research R5): durante un corte de la base de datos, el
 * cliente final recibe el aviso con el teléfono de emergencia **sin tocar la base**, porque toda
 * la maquinaria de disculpa de la 012 necesita escribir para funcionar.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ActivityLog, BotEvent } from '../../../src/conversation/activity-log.js';
import { withDegradedReply } from '../../../src/conversation/degraded-reply.js';
import { emergencyContact, errorReply } from '../../../src/conversation/templates.js';
import type { Intake, IntakeOutcome } from '../../../src/conversation/intake.js';
import type { InboundEvent } from '../../../src/conversation/types.js';
import { createOutageWatcher } from '../../../src/db/outage.js';

const coded = (code: string): Error => Object.assign(new Error('fallo'), { code });

const event = (overrides: Partial<InboundEvent> = {}): InboundEvent => ({
    channel: 'whatsapp',
    channelUserId: '+34600000000',
    channelMessageId: 'wamid.1',
    sentAt: new Date('2026-10-09T10:00:00Z'),
    kind: 'text',
    text: 'hola',
    caption: null,
    mediaId: null,
    otherType: null,
    isGroup: false,
    profileName: null,
  buttonPayload: null,
  ...overrides,
});

function setup({
  error = coded('ECONNREFUSED'),
  emergencyContactPhone = '+34911223344',
  sender = true,
}: { error?: unknown; emergencyContactPhone?: string | null; sender?: boolean } = {}) {
  const events: BotEvent[] = [];
  const activityLog: ActivityLog = {
    log: (e) => events.push(e),
    pseudonym: () => 'abc123abc123',
  };
  const sendText = vi.fn(async () => ({ channelMessageId: 'out:1' }));
  const inner: Intake = {
    handle: vi.fn(async (): Promise<IntakeOutcome[]> => {
      if (error !== null) throw error as Error;
      return [{ status: 'stored', conversationId: 'c1' }];
    }),
  };
  const watcher = createOutageWatcher({ probe: async () => undefined });
  watcher.attachLogger(activityLog);
  const intake = withDegradedReply(inner, {
    watcher,
    activityLog,
    emergencyContactPhone,
    senders: sender ? { whatsapp: { sendText } } : {},
  });
  return { intake, sendText, events, watcher, inner };
}

describe('withDegradedReply', () => {
  it('envía la disculpa con el teléfono de emergencia y vuelve a lanzar', async () => {
    const t = setup();
    await expect(t.intake.handle([event()])).rejects.toThrow();
    expect(t.sendText).toHaveBeenCalledTimes(1);
    const [to, body] = t.sendText.mock.calls[0] as unknown as [string, string];
    expect(to).toBe('+34600000000');
    // Las plantillas que ya existen en el núcleo, sin texto nuevo: la disculpa de la 012 y el
    // bloque del contacto de emergencia (que formatea el número).
    expect(body).toContain(errorReply('tu'));
    expect(body).toContain(emergencyContact('+34911223344'));
    expect(t.events.map((e) => e.event)).toContain('db_degraded_reply_sent');
    t.watcher.close();
  });

  it('vuelve a lanzar el error para que el webhook responda 503 y Meta reintente', async () => {
    const t = setup({ error: coded('ECONNREFUSED') });
    await expect(t.intake.handle([event()])).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    t.watcher.close();
  });

  it('avisa una sola vez por cliente y corte, aunque insista o Meta reintente', async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      await expect(
        t.intake.handle([event({ channelMessageId: `wamid.${String(i)}` })]),
      ).rejects.toThrow();
    }
    expect(t.sendText).toHaveBeenCalledTimes(1);
    const skipped = t.events.filter((e) => e.event === 'db_degraded_reply_skipped');
    expect(skipped).toHaveLength(4);
    expect(skipped[0]).toMatchObject({ reason: 'already_notified' });
    t.watcher.close();
  });

  it('tras la recuperación vuelve a avisar al mismo cliente', async () => {
    const t = setup();
    await expect(t.intake.handle([event()])).rejects.toThrow();
    expect(t.sendText).toHaveBeenCalledTimes(1);
    // La recuperación vacía la memoria de avisos: un corte nuevo vuelve a avisar.
    t.watcher.close();
    const again = setup();
    await expect(again.intake.handle([event()])).rejects.toThrow();
    expect(again.sendText).toHaveBeenCalledTimes(1);
    again.watcher.close();
  });

  it('a clientes distintos avisa a cada uno', async () => {
    const t = setup();
    for (const phone of ['+34600000000', '+34600000001', '+34600000002']) {
      await expect(t.intake.handle([event({ channelUserId: phone })])).rejects.toThrow();
    }
    expect(t.sendText).toHaveBeenCalledTimes(3);
    t.watcher.close();
  });

  it('sin teléfono de emergencia no envía nada y lo registra', async () => {
    const t = setup({ emergencyContactPhone: null });
    await expect(t.intake.handle([event()])).rejects.toThrow();
    expect(t.sendText).not.toHaveBeenCalled();
    expect(t.events).toContainEqual({
      event: 'db_degraded_reply_skipped',
      channel: 'whatsapp',
      reason: 'no_contact',
    });
    t.watcher.close();
  });

  it('sin remitente del canal no envía nada y lo registra', async () => {
    const t = setup({ sender: false });
    await expect(t.intake.handle([event()])).rejects.toThrow();
    expect(t.events).toContainEqual({
      event: 'db_degraded_reply_skipped',
      channel: 'whatsapp',
      reason: 'no_sender',
    });
    t.watcher.close();
  });

  it('un fallo que no es de indisponibilidad pasa de largo sin enviar nada', async () => {
    const t = setup({ error: coded('42601') });
    await expect(t.intake.handle([event()])).rejects.toThrow();
    expect(t.sendText).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
    expect(t.watcher.state()).toBe('up');
    t.watcher.close();
  });

  it('sin fallo no se mete en medio: devuelve lo que devuelve la recepción', async () => {
    const t = setup({ error: null });
    await expect(t.intake.handle([event()])).resolves.toEqual([
      { status: 'stored', conversationId: 'c1' },
    ]);
    expect(t.sendText).not.toHaveBeenCalled();
    t.watcher.close();
  });

  it('el canal web no se toca: ya responde con contacto en su propio 503', async () => {
    const t = setup();
    await expect(
      t.intake.handle([event({ channel: 'web', channelUserId: 'a'.repeat(64) })]),
    ).rejects.toThrow();
    expect(t.sendText).not.toHaveBeenCalled();
    t.watcher.close();
  });

  it('si el envío falla, no se rompe y lo registra', async () => {
    const t = setup();
    t.sendText.mockRejectedValueOnce(new Error('Meta no responde'));
    await expect(t.intake.handle([event()])).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(t.events).toContainEqual({
      event: 'db_degraded_reply_skipped',
      channel: 'whatsapp',
      reason: 'send_failed',
    });
    t.watcher.close();
  });

  it('ninguna anotación lleva nada de la dirección de la base de datos (FR-012)', async () => {
    const t = setup({
      error: Object.assign(
        new Error('connect ECONNREFUSED postgres://operador:secreta@/chatbot'),
        { code: 'ECONNREFUSED' },
      ),
    });
    await expect(t.intake.handle([event()])).rejects.toThrow();
    const dump = JSON.stringify(t.events);
    for (const secret of ['operador', 'secreta', 'chatbot', 'postgres://']) {
      expect(dump).not.toContain(secret);
    }
    t.watcher.close();
  });
});
