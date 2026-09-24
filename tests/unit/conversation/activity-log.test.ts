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
    const a = log.pseudonym('+34600111222');
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(log.pseudonym('+34600111222')).toBe(a);
    expect(createActivityLog(logger, SECRET).pseudonym('+34600111222')).toBe(a);
    expect(log.pseudonym('+34600111223')).not.toBe(a);
    expect(a).not.toContain('600111222');
  });

  it('emite en el canal bot con el seudónimo y sin el número', () => {
    const { logger, lines } = capture();
    const log = createActivityLog(logger, SECRET);
    log.log(
      { event: 'message_received', kind: 'text' },
      { phone: '+34600111222', conversationId: 'c1' },
    );
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line?.obj).toMatchObject({
      channel: 'bot',
      event: 'message_received',
      kind: 'text',
      conversationId: 'c1',
      customer: log.pseudonym('+34600111222'),
    });
    expect(JSON.stringify(line)).not.toContain('600111222');
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
  ])('nivel de %o', (event, level) => {
    const { logger, lines } = capture();
    createActivityLog(logger, SECRET).log(event);
    expect(lines[0]?.level).toBe(level);
    expect(eventLevels[event.event]).toBe(level);
  });
});
