import { describe, expect, it } from 'vitest';
import {
  createActivityLog,
  eventLevels,
  type BotEvent,
  type LoggerLike,
} from '../../../src/conversation/activity-log.js';

const SECRET = '3f9a1c7e5b2d4086a1e3c5f7092b4d6e8a0c2e4f6183a5c7e9b1d3f5a7c9e0b2';

function capture() {
  const lines: Array<{ level: string; obj: Record<string, unknown> }> = [];
  const make = (bindings: Record<string, unknown>): LoggerLike => ({
    debug: (obj) => lines.push({ level: 'debug', obj: { ...bindings, ...obj } }),
    info: (obj) => lines.push({ level: 'info', obj: { ...bindings, ...obj } }),
    warn: (obj) => lines.push({ level: 'warn', obj: { ...bindings, ...obj } }),
    error: (obj) => lines.push({ level: 'error', obj: { ...bindings, ...obj } }),
    child: (b) => make({ ...bindings, ...b }),
  });
  return { logger: make({}), lines };
}

describe('registro técnico del bot', () => {
  it('seudónimo estable, de 12 hex, distinto por número y sin el número en claro', () => {
    const { logger } = capture();
    const log = createActivityLog(logger, SECRET);
    const a = log.pseudonym('whatsapp', '+34600111222');
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(log.pseudonym('whatsapp', '+34600111222')).toBe(a);
    expect(createActivityLog(logger, SECRET).pseudonym('whatsapp', '+34600111222')).toBe(a);
    expect(log.pseudonym('whatsapp', '+34600111223')).not.toBe(a);
    expect(a).not.toContain('600111222');
  });

  it('el mismo channel_user_id en dos canales da seudónimos distintos (R12)', () => {
    const log = createActivityLog(capture().logger, SECRET);
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(log.pseudonym('playground', id)).not.toBe(log.pseudonym('web', id));
    expect(log.pseudonym('whatsapp', '+34600111222')).not.toBe(
      log.pseudonym('playground', '+34600111222'),
    );
  });

  it('emite en el canal bot con via, el seudónimo y sin el número', () => {
    const { logger, lines } = capture();
    const log = createActivityLog(logger, SECRET);
    log.log(
      { event: 'message_received', kind: 'text' },
      { channel: 'whatsapp', customerKey: '+34600111222', conversationId: 'c1' },
    );
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line?.obj).toMatchObject({
      channel: 'bot',
      via: 'whatsapp',
      event: 'message_received',
      kind: 'text',
      conversationId: 'c1',
      customer: log.pseudonym('whatsapp', '+34600111222'),
    });
    expect(JSON.stringify(line)).not.toContain('600111222');
  });

  it('los eventos sin cliente no llevan via ni customer', () => {
    const { logger, lines } = capture();
    createActivityLog(logger, SECRET).log({ event: 'web_rejected', reason: 'origin' });
    expect(lines[0]?.obj).toEqual({ channel: 'bot', event: 'web_rejected', reason: 'origin' });
  });

  it('los eventos nuevos solo tienen campos cerrados (sin texto libre)', () => {
    const { logger, lines } = capture();
    const log = createActivityLog(logger, SECRET);
    log.log({ event: 'web_session_created' });
    log.log({ event: 'web_quota_reached', period: 'day', cap: 200 });
    log.log(
      { event: 'message_discarded', reason: 'quota' },
      { channel: 'web', customerKey: 'a'.repeat(64) },
    );
    expect(lines.map((l) => l.obj)).toEqual([
      { channel: 'bot', event: 'web_session_created' },
      { channel: 'bot', event: 'web_quota_reached', period: 'day', cap: 200 },
      {
        channel: 'bot',
        event: 'message_discarded',
        reason: 'quota',
        via: 'web',
        customer: log.pseudonym('web', 'a'.repeat(64)),
      },
    ]);
    expect(JSON.stringify(lines)).not.toContain('a'.repeat(64));
  });

  it.each<[BotEvent, string]>([
    [{ event: 'message_received', kind: 'text' }, 'info'],
    [{ event: 'duplicate_ignored' }, 'debug'],
    [{ event: 'rate_limit_exceeded', count: 31, windowMinutes: 15, noticeSent: true }, 'warn'],
    [{ event: 'knowledge_read_failed', errorClass: 'Error', stage: 'intake' }, 'error'],
    [{ event: 'generation_failed', reason: 'timeout' }, 'error'],
    [{ event: 'grounding_rejected', attempt: 1, offendingCount: 2 }, 'warn'],
    [{ event: 'send_failed', attempts: 3, finalFailure: true }, 'error'],
    [{ event: 'webhook_rejected', reason: 'signature' }, 'warn'],
    [{ event: 'retention_purged', conversations: 1, customers: 1 }, 'info'],
    [{ event: 'web_session_created' }, 'debug'],
    [{ event: 'web_rejected', reason: 'session_limit' }, 'warn'],
    [{ event: 'web_quota_reached', period: 'month', cap: 3000 }, 'warn'],
    [{ event: 'message_discarded', reason: 'disabled' }, 'info'],
  ])('nivel de %o', (event, level) => {
    const { logger, lines } = capture();
    createActivityLog(logger, SECRET).log(event);
    expect(lines[0]?.level).toBe(level);
    expect(eventLevels[event.event]).toBe(level);
  });

  describe('eventos del consumo (010)', () => {
    const usageEvents: Array<[BotEvent, string]> = [
      [{ event: 'usage_record_failed', purpose: 'reply' }, 'error'],
      [{ event: 'usage_record_failed', purpose: 'handoff_summary' }, 'error'],
      [{ event: 'spend_cap_reached', month: '2026-10' }, 'warn'],
      [{ event: 'handoff_summary_fallback', reason: 'spend_cap' }, 'warn'],
    ];

    it.each(usageEvents)('nivel de %o', (event, level) => {
      const { logger, lines } = capture();
      createActivityLog(logger, SECRET).log(event);
      expect(lines[0]?.level).toBe(level);
      expect(eventLevels[event.event]).toBe(level);
    });

    it('no llevan importes, precios, monedas ni textos', () => {
      const { logger, lines } = capture();
      const log = createActivityLog(logger, SECRET);
      log.log(
        { event: 'usage_record_failed', purpose: 'reply' },
        { channel: 'whatsapp', customerKey: '+34600111222', conversationId: 'c1' },
      );
      log.log({ event: 'spend_cap_reached', month: '2026-10' });
      log.log({ event: 'handoff_summary_fallback', reason: 'spend_cap' });
      expect(lines.map((l) => l.obj)).toEqual([
        {
          channel: 'bot',
          event: 'usage_record_failed',
          purpose: 'reply',
          via: 'whatsapp',
          customer: log.pseudonym('whatsapp', '+34600111222'),
          conversationId: 'c1',
        },
        { channel: 'bot', event: 'spend_cap_reached', month: '2026-10' },
        { channel: 'bot', event: 'handoff_summary_fallback', reason: 'spend_cap' },
      ]);
      expect(JSON.stringify(lines)).not.toMatch(/cost|price|currency|USD|EUR|cents|pico/i);
    });
  });

  describe('eventos de la derivación (005)', () => {
    const handoffId = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const handoffEvents: Array<[BotEvent, string]> = [
      [{ event: 'handoff_offered' }, 'info'],
      [{ event: 'handoff_contact_requested', missing: ['name', 'phone'], retry: false }, 'info'],
      [
        {
          event: 'handoff_started',
          handoffId,
          kind: 'person',
          routes: { whatsapp: 'sent', email: 'failed' },
          summarySource: 'model',
          afterHours: false,
        },
        'info',
      ],
      [{ event: 'handoff_not_started', kind: 'complaint', reason: 'no_routes' }, 'warn'],
      [
        {
          event: 'handoff_alert_failed',
          handoffId,
          route: 'email',
          noticeType: 'alert',
          failure: 'smtp_5xx',
        },
        'warn',
      ],
      [{ event: 'handoff_summary_fallback', reason: 'unverified' }, 'warn'],
      [
        { event: 'handoff_forwarded', handoffId, messagesCovered: 2, routes: { email: 'sent' } },
        'info',
      ],
      [{ event: 'handoff_forward_failed', handoffId, messagesCovered: 1 }, 'error'],
      [{ event: 'handoff_confirmed', handoffId, via: 'email', minutesToConfirm: 12 }, 'info'],
      [
        {
          event: 'handoff_reminder_sent',
          handoffId,
          routes: { whatsapp: 'sent' },
          trigger: 'schedule',
          customerNotified: true,
        },
        'warn',
      ],
      [
        {
          event: 'handoff_ended',
          handoffId,
          cause: 'business',
          durationMinutes: 30,
          confirmed: true,
        },
        'info',
      ],
      [{ event: 'handoff_action_ignored', reason: 'already_ended', via: 'whatsapp' }, 'debug'],
      [{ event: 'handoff_business_message', kind: 'text', helpSent: true }, 'debug'],
    ];

    it.each(handoffEvents)('nivel de %o', (event, level) => {
      const { logger, lines } = capture();
      createActivityLog(logger, SECRET).log(event);
      expect(lines[0]?.level).toBe(level);
      expect(eventLevels[event.event]).toBe(level);
    });

    it('todos los eventos handoff_* tienen nivel y están probados', () => {
      const tested = new Set(handoffEvents.map(([e]) => e.event));
      const declared = Object.keys(eventLevels).filter((e) => e.startsWith('handoff_'));
      expect(declared.sort()).toEqual([...tested].sort());
    });

    it('se serializan sin campos de texto libre', () => {
      const { logger, lines } = capture();
      const log = createActivityLog(logger, SECRET);
      for (const [event] of handoffEvents) log.log(event);
      const allowedStrings = new Set([
        'bot',
        handoffId,
        'person',
        'complaint',
        'sent',
        'failed',
        'model',
        'no_routes',
        'email',
        'whatsapp',
        'alert',
        'smtp_5xx',
        'unverified',
        'schedule',
        'business',
        'already_ended',
        'text',
        'name',
        'phone',
      ]);
      const strings: string[] = [];
      const walk = (v: unknown): void => {
        if (typeof v === 'string') strings.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      for (const line of lines) {
        const { event: _name, ...rest } = line.obj;
        walk(rest);
      }
      expect(strings.filter((s) => !allowedStrings.has(s))).toEqual([]);
    });

    it('los eventos del negocio no llevan customer ni el via del canal', () => {
      const { logger, lines } = capture();
      const log = createActivityLog(logger, SECRET);
      log.log({ event: 'handoff_confirmed', handoffId, via: 'whatsapp', minutesToConfirm: 3 });
      log.log({ event: 'handoff_action_ignored', reason: 'invalid', via: 'email' });
      log.log({ event: 'handoff_business_message', kind: 'button', helpSent: false });
      log.log({
        event: 'handoff_ended',
        handoffId,
        cause: 'business',
        durationMinutes: 5,
        confirmed: true,
      });
      for (const line of lines) {
        expect(line.obj).not.toHaveProperty('customer');
        expect(line.obj).not.toHaveProperty('conversationId');
      }
      expect(lines.map((l) => l.obj.via)).toEqual(['whatsapp', 'email', undefined, undefined]);
    });
  });
});
